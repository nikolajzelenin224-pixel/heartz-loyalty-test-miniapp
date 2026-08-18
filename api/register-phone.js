const { verifyInitData } = require("./_lib/verifyInitData");
const { kvGet, kvSet, kvDel, kvIncrWithExpire } = require("./_lib/kv");

const HOST = "myshop-cxk555.myinsales.ru";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 600;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function insalesAuth() {
  const login = process.env.INSALES_LOGIN;
  const password = process.env.INSALES_PASSWORD;
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function insalesGet(path) {
  const res = await fetch(`https://${HOST}${path}`, { headers: { Authorization: insalesAuth() } });
  if (!res.ok) throw new Error(`insales_error_${res.status}`);
  return res.json();
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let d = digits;
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length !== 11 || d[0] !== "7") return null;
  return d;
}

// В InSales телефоны реальных клиентов сохранены в разных форматах ("+79521234567",
// "89521234567", "79521234567" — зависит от того, как был оформлен заказ). Поиск по
// ?phone= — точное совпадение строки, поэтому пробуем все варианты по очереди.
function insalesPhoneVariants(normalized) {
  return [`+${normalized}`, `8${normalized.slice(1)}`, normalized];
}

async function findInsalesClient(normalized) {
  for (const variant of insalesPhoneVariants(normalized)) {
    const clients = await insalesGet(`/admin/clients.json?phone=${encodeURIComponent(variant)}`);
    if (Array.isArray(clients)) {
      const match = clients.find((c) => c.phone === variant);
      if (match) return match;
    }
  }
  return null;
}

function levelFromLtv(ltv) {
  if (ltv < 9000) return "I";
  if (ltv < 20000) return "II";
  if (ltv < 50000) return "III";
  return "IV";
}

function randomCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

async function generateUniqueCode() {
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    const exists = await kvGet(`code:${code}`);
    if (!exists) return code;
  }
  throw new Error("code_generation_failed");
}

// Анкета (имя/почта/дата рождения) хранится по НОМЕРУ ТЕЛЕФОНА, а не по tg_id — это
// одна и та же анкета клиента независимо от того, с какого Telegram-аккаунта её
// заполняют (например, у человека сменился телефон/аккаунт, или кто-то тестирует
// заново тем же номером). Раньше хранили по tg_id, но так конфликт не ловился, если
// анкету пробовали заполнить с ДРУГОГО tg_id тем же номером.
async function loadProfile(normalizedPhone) {
  const raw = await kvGet(`profile:${normalizedPhone}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Возвращает объект для 409-ответа, если анкета с этим телефоном уже сохранена с
// ДРУГИМИ именем/почтой, иначе null. Вызывать только после того, как убедились, что
// запрашивающий tg_id либо уже владеет кодом на этот телефон, либо код ещё ничей —
// иначе можно случайно показать чужие ФИО/почту постороннему, который просто угадал
// или подобрал номер телефона.
async function findProfileConflict(normalizedPhone, cleanName, cleanEmail, confirmOverwrite) {
  if (confirmOverwrite) return null;
  const existing = await loadProfile(normalizedPhone);
  if (!existing) return null;
  if (existing.name !== cleanName || existing.email !== cleanEmail) {
    return {
      error: "profile_conflict",
      existingProfile: {
        name: existing.name,
        email: existing.email,
        birthDate: existing.birthDate || null,
      },
    };
  }
  return null;
}

async function saveProfile(normalizedPhone, tgId, cleanName, cleanEmail, birthDate) {
  await kvSet(`profile:${normalizedPhone}`, JSON.stringify({
    name: cleanName,
    email: cleanEmail,
    birthDate: birthDate || null,
    tgId,
    consentAt: new Date().toISOString(),
  }));
}

// Если у этого tg_id уже был привязан ДРУГОЙ код (например, раньше регистрировался
// другим номером, или уже открывал Mystery Box как лид уровня 0) — освобождаем его
// codeowner, иначе старый код навсегда останется помечен "занят этим аккаунтом", хотя
// человек уже переключился на новый.
async function releasePreviousCode(tgId, newCode) {
  const prevRaw = await kvGet(`tg:${tgId}`);
  if (!prevRaw) return;
  const prevCode = prevRaw.split("|")[2];
  if (prevCode && prevCode !== newCode) {
    await kvDel(`codeowner:${prevCode}`);
  }
}

async function sumPaidLtv(clientId) {
  let total = 0;
  let page = 1;
  const perPage = 100;
  for (;;) {
    const orders = await insalesGet(`/admin/orders.json?client_id=${clientId}&per_page=${perPage}&page=${page}`);
    if (!Array.isArray(orders) || orders.length === 0) break;
    for (const o of orders) {
      if (o.financial_status === "paid") {
        total += Number(o.total_price || 0);
      }
    }
    if (orders.length < perPage) break;
    page++;
  }
  return Math.round(total);
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
  const { initData, phone, name, email, birthDate, consent, confirmOverwrite } = body || {};

  const check = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: check.reason });
    return;
  }
  const tgId = check.user.id;

  try {
    if (consent !== true) {
      res.status(400).json({ error: "consent_required" });
      return;
    }
    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim();
    if (!cleanName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: "bad_profile" });
      return;
    }

    const attempts = await kvIncrWithExpire(`ratelimit:register:${tgId}`, RATE_LIMIT_WINDOW);
    if (attempts > RATE_LIMIT_MAX) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }

    const normalized = normalizePhone(phone);
    if (!normalized) {
      res.status(400).json({ error: "bad_phone_format" });
      return;
    }

    // 1. уже есть в нашей базе (исторический клиент или ранее зарегистрированный лид)
    const existingCode = await kvGet(`phone:${normalized}`);
    if (existingCode) {
      const raw = await kvGet(`code:${existingCode}`);
      if (raw) {
        // Тот же лок владельца, что и в /api/lookup.js — один код лояльности не
        // должен молча переприкрепляться к другому Telegram-аккаунту. Проверяем ЭТО
        // раньше сверки анкеты, чтобы посторонний, который просто угадал чужой номер
        // телефона, не увидел настоящие ФИО/почту владельца в ответе на конфликт.
        const owner = await kvGet(`codeowner:${existingCode}`);
        if (owner && String(owner) !== String(tgId)) {
          res.status(409).json({ error: "code_claimed_by_other" });
          return;
        }

        // Дошли сюда — это либо уже наш tg_id, либо код почему-то ещё ничей. Теперь
        // безопасно сверить анкету по номеру телефона.
        const conflict = await findProfileConflict(normalized, cleanName, cleanEmail, confirmOverwrite);
        if (conflict) {
          res.status(409).json(conflict);
          return;
        }
        await saveProfile(normalized, tgId, cleanName, cleanEmail, birthDate);
        await releasePreviousCode(tgId, existingCode);

        await kvSet(`tg:${tgId}`, `${raw}|${existingCode}`);
        await kvSet(`codeowner:${existingCode}`, tgId); // см. комментарий ниже про блок 5
        const [level, ltv] = raw.split("|");
        res.status(200).json({ level, ltv: Number(ltv), code: existingCode, source: "existing" });
        return;
      }
    }

    // 2. номер новый — код ещё никому не принадлежит, конфликтов владения быть не
    // может, но анкета всё равно могла остаться от прошлой попытки (например, лид
    // регистрировался, но код тогда создать не удалось) — сверяем и здесь.
    const conflict = await findProfileConflict(normalized, cleanName, cleanEmail, confirmOverwrite);
    if (conflict) {
      res.status(409).json(conflict);
      return;
    }
    await saveProfile(normalized, tgId, cleanName, cleanEmail, birthDate);

    // 3. ищем в InSales по телефону (разные форматы записи)
    const client = await findInsalesClient(normalized);

    let level, ltv;
    if (client) {
      ltv = await sumPaidLtv(client.id);
      level = levelFromLtv(ltv);
    } else {
      // 4. лид без заказов
      level = "0";
      ltv = 0;
    }

    const code = await generateUniqueCode();
    const raw = `${level}|${ltv}`;
    await kvSet(`code:${code}`, raw);
    await kvSet(`phone:${normalized}`, code);
    await releasePreviousCode(tgId, code);
    await kvSet(`tg:${tgId}`, `${raw}|${code}`);
    // Реверс-индекс для блока 5 (вебхук InSales, api/webhooks/insales-order.js) — при
    // новом заказе вебхук обновит и tg:<id>, чтобы уровень в открытом миниаппе не устарел.
    await kvSet(`codeowner:${code}`, tgId);

    res.status(200).json({ level, ltv, code, source: client ? "insales" : "lead" });
  } catch (e) {
    res.status(502).json({ error: "upstream_unavailable", detail: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
