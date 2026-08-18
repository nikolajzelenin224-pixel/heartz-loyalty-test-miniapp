// HEARTZ · Mystery Box — активация кода бокса и выдача Reveal Card.
//
// Данные о содержимом бокса (уровень/тир, состав, серийный номер) отдельно НЕ храним —
// вся эта информация уже нарисована на самой картинке Reveal Card, которую сотрудник
// выгружает на Google Диск под именем = код бокса. Мы только: ищем файл по коду,
// один раз кэшируем его в Vercel Blob (см. googleDrive.js и решение от 18.08.2026 —
// кэшировать при первой активации, не дёргать Диск каждый раз), помечаем код
// использованным и шлём то же фото ботом в чат клиента.
//
// В отличие от кода лояльности, код бокса — строго одноразовый: один и тот же код
// нельзя открыть с двух разных Telegram-аккаунтов. Для тестовых боксов есть отдельный
// admin-эндпоинт (admin.js) с ручным откатом "открыт" -> "закрыт".

const { verifyInitData } = require("../_lib/verifyInitData");
const { kvGet, kvSet, kvIncrWithExpire } = require("../_lib/kv");
const { findFileByCode } = require("../_lib/googleDrive");
const { put } = require("@vercel/blob");

const RATE_LIMIT_MAX = 8;
const RATE_LIMIT_WINDOW = 600; // 10 минут
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomLeadCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

async function generateUniqueLeadCode() {
  for (let i = 0; i < 5; i++) {
    const code = randomLeadCode();
    const exists = await kvGet(`code:${code}`);
    if (!exists) return code;
  }
  throw new Error("code_generation_failed");
}

// Открытие бокса теперь всегда даёт доступ к полноценному аккаунту лояльности — человек
// после Reveal Card сразу видит свой уровень и код скидки, а не только картинку.
// Если у Telegram-аккаунта уже есть код — просто возвращаем его. Если это первое
// касание с приложением вообще (человек пришёл только с коробкой, без истории заказов) —
// заводим "лид" уровня 0, как и при регистрации по телефону без найденного клиента
// в InSales (см. register-phone.js). Телефон при этом не запрашиваем и не привязываем —
// только код и Telegram-аккаунт; телефон появится позже, если человек довяжет заказы.
async function ensureLoyaltyAccount(tgId) {
  const raw = await kvGet(`tg:${tgId}`);
  if (raw) {
    const [level, ltv, loyaltyCode] = raw.split("|");
    return { level, ltv: Number(ltv) || 0, loyaltyCode: loyaltyCode || null };
  }
  const code = await generateUniqueLeadCode();
  await kvSet(`code:${code}`, "0|0");
  await kvSet(`tg:${tgId}`, `0|0|${code}`);
  await kvSet(`codeowner:${code}`, tgId);
  // Согласие на ПДн уже было дано на экране ввода кода (обязательный чекбокс перед
  // отправкой) — фиксируем время, если это первое согласие этого tg_id в системе.
  const consentAlready = await kvGet(`consent:${tgId}`);
  if (!consentAlready) await kvSet(`consent:${tgId}`, new Date().toISOString());
  return { level: "0", ltv: 0, loyaltyCode: code };
}

async function sendBotPhoto(chatId, photoUrl, caption) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
    });
  } catch (e) {
    // Не роняем весь запрос из-за сбоя отправки фото ботом — карточка в миниаппе
    // важнее и уже посчитана активированной.
    console.error("mystery_box_send_photo_failed", e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { initData, code, consent } = body || {};

  const check = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: check.reason });
    return;
  }
  const tgId = check.user.id;

  if (consent !== true) {
    res.status(400).json({ error: "consent_required" });
    return;
  }

  const normalized = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized || normalized.length > 40) {
    res.status(400).json({ error: "bad_code_format" });
    return;
  }

  try {
    const attempts = await kvIncrWithExpire(`ratelimit:boxredeem:${tgId}`, RATE_LIMIT_WINDOW);
    if (attempts > RATE_LIMIT_MAX) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }

    const existingRaw = await kvGet(`boxcode:${normalized}`);
    let record = existingRaw ? JSON.parse(existingRaw) : null;

    if (record && record.redeemed) {
      if (String(record.redeemedBy) !== String(tgId)) {
        res.status(409).json({ error: "box_already_claimed" });
        return;
      }
      // Тот же человек открывает повторно — идемпотентно показываем ту же карточку,
      // заодно возвращаем актуальный уровень лояльности (вдруг успел что-то купить).
      const account = await ensureLoyaltyAccount(tgId);
      res.status(200).json({
        imageUrl: record.imageUrl,
        boxCode: normalized,
        alreadyOpened: true,
        level: account.level,
        ltv: account.ltv,
        loyaltyCode: account.loyaltyCode,
      });
      return;
    }

    if (!record) {
      // Первая активация этого кода вообще — ищем файл на Диске и кэшируем в Blob.
      const file = await findFileByCode(normalized);
      if (!file) {
        res.status(404).json({ error: "box_not_found" });
        return;
      }
      const blob = await put(`mystery-box/${normalized}.png`, file.buffer, {
        access: "public",
        contentType: file.contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      record = { imageUrl: blob.url, redeemed: false, redeemedBy: null, redeemedAt: null };
    }
    // Если record уже существовал, но redeemed:false — это код после admin-отката
    // (тестовый бокс), картинка в Blob уже закэширована и переиспользуется как есть.

    const account = await ensureLoyaltyAccount(tgId);

    record.redeemed = true;
    record.redeemedBy = tgId;
    record.redeemedAt = new Date().toISOString();
    await kvSet(`boxcode:${normalized}`, JSON.stringify(record));

    await sendBotPhoto(
      tgId,
      record.imageUrl,
      "HEARTZ Special Supply — ваш Reveal Card открыт. Этим фото можно поделиться с друзьями или в Stories."
    );

    res.status(200).json({
      imageUrl: record.imageUrl,
      boxCode: normalized,
      alreadyOpened: false,
      level: account.level,
      ltv: account.ltv,
      loyaltyCode: account.loyaltyCode,
    });
  } catch (e) {
    console.error("mystery_box_redeem_error", e);
    res.status(502).json({ error: "upstream_unavailable", detail: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
