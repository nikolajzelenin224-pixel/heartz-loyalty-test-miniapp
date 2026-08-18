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
      // Тот же человек открывает повторно — идемпотентно показываем ту же карточку.
      res.status(200).json({ imageUrl: record.imageUrl, code: normalized, alreadyOpened: true });
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

    record.redeemed = true;
    record.redeemedBy = tgId;
    record.redeemedAt = new Date().toISOString();
    await kvSet(`boxcode:${normalized}`, JSON.stringify(record));

    await sendBotPhoto(
      tgId,
      record.imageUrl,
      "HEARTZ Special Supply — ваш Reveal Card открыт. Этим фото можно поделиться с друзьями или в Stories."
    );

    res.status(200).json({ imageUrl: record.imageUrl, code: normalized, alreadyOpened: false });
  } catch (e) {
    console.error("mystery_box_redeem_error", e);
    res.status(502).json({ error: "upstream_unavailable", detail: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
