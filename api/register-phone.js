const { verifyInitData } = require("./_lib/verifyInitData");
const { kvGet, kvSet, kvIncrWithExpire } = require("./_lib/kv");

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
  const { initData, phone } = body || {};

  const check = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: check.reason });
    return;
  }
  const tgId = check.user.id;

  try {
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
        await kvSet(`tg:${tgId}`, `${raw}|${existingCode}`);
        const [level, ltv] = raw.split("|");
        res.status(200).json({ level, ltv: Number(ltv), code: existingCode, source: "existing" });
        return;
      }
    }

    // 2. ищем в InSales по телефону (разные форматы записи)
    const client = await findInsalesClient(normalized);

    let level, ltv;
    if (client) {
      ltv = await sumPaidLtv(client.id);
      level = levelFromLtv(ltv);
    } else {
      // 3. лид без заказов
      level = "0";
      ltv = 0;
    }

    const code = await generateUniqueCode();
    const raw = `${level}|${ltv}`;
    await kvSet(`code:${code}`, raw);
    await kvSet(`phone:${normalized}`, code);
    await kvSet(`tg:${tgId}`, `${raw}|${code}`);

    res.status(200).json({ level, ltv, code, source: client ? "insales" : "lead" });
  } catch (e) {
    res.status(502).json({ error: "upstream_unavailable", detail: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
