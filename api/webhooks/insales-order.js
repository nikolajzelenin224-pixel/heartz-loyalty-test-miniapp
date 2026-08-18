// HEARTZ · Блок 5 — вебхук InSales, автовыдача кода и апдейт уровня.
//
// Подписывается на события orders/create и orders/update (InSales официально не даёт
// отдельного orders/paid — статус оплаты отслеживается через orders/update). InSales НЕ
// подписывает и не аутентифицирует вебхуки (ни HMAC, ни секрет в теле — проверено по
// официальной документации 18.08.2026), поэтому единственная защита — секретный ключ в
// query, тот же паттерн, что уже используется в /api/external-discount.js.
//
// Телу вебхука не доверяем (точный формат — полный объект заказа или только id — нигде
// не задокументирован): достаём числовой id заказа откуда угодно из присланного JSON,
// а дальше сами переспрашиваем актуальные данные заказа и клиента у InSales напрямую.
//
// Логика идемпотентна: при каждом вызове уровень/LTV пересчитывается заново по ВСЕМ
// оплаченным заказам клиента (как в /api/register-phone.js), а не инкрементируется —
// поэтому один и тот же вебхук безопасно обработать дважды (InSales может ретраить).
//
// Закрывает сценарии 4 и 6 из "Лояльность - сценарии выдачи кода.md":
// - сценарий 4: у клиента, которого ещё нет в нашей базе, при первом заказе появляется
//   code:/phone: с настоящим уровнем (доставка клиенту — отдельная операционная задача,
//   письмо/рассылка, вне зоны этого файла — код только создаёт запись).
// - сценарий 6: у лида с уровнем "0" при первом заказе уровень пересчитывается на
//   настоящий, тот же code остаётся.
// - плюс закрывает старый пробел "уровни со временем устареют": теперь пересчёт
//   происходит при каждом заказе, а не только один раз при миграции. Чтобы уже открытый
//   миниапп (привязка tg -> code) тоже не показывал устаревшие данные, вебхук использует
//   реверс-индекс codeowner:<code> -> tg_id (пишется в /api/lookup.js и
//   /api/register-phone.js) и обновляет tg:<id> вместе с code:<code>.

const { kvGet, kvSet } = require("./_lib/kv");

const HOST = "myshop-cxk555.myinsales.ru";
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function insalesAuth() {
  const login = process.env.INSALES_LOGIN;
  const password = process.env.INSALES_PASSWORD;
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function insalesGet(path) {
  const res = await fetch(`https://${HOST}${path}`, { headers: { Authorization: insalesAuth() } });
  if (!res.ok) throw new Error(`insales_error_${res.status}_${path}`);
  return res.json();
}

// Формат тела вебхука не задокументирован — ищем числовой id заказа в любом месте JSON,
// по аналогии с тем, как /api/external-discount.js ищет код скидки.
function findOrderId(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOrderId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    if (value.id != null) {
      const id = findOrderId(value.id, depth + 1);
      if (id) return id;
    }
    for (const key of Object.keys(value)) {
      const found = findOrderId(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  let d = digits;
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length !== 11 || d[0] !== "7") return null;
  return d;
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
      if (o.financial_status === "paid") total += Number(o.total_price || 0);
    }
    if (orders.length < perPage) break;
    page++;
  }
  return Math.round(total);
}

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || "";
  if (!process.env.INSALES_WEBHOOK_KEY || key !== process.env.INSALES_WEBHOOK_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    const orderId = findOrderId(body);
    if (!orderId) {
      res.status(200).json({ skipped: "no_order_id" });
      return;
    }

    const order = await insalesGet(`/admin/orders/${orderId}.json`);
    const clientId = order.client_id || (order.client && order.client.id);
    if (!clientId) {
      res.status(200).json({ skipped: "no_client_id", orderId });
      return;
    }

    const client = await insalesGet(`/admin/clients/${clientId}.json`);
    const phone = normalizePhone(client.phone);
    if (!phone) {
      res.status(200).json({ skipped: "no_phone", orderId, clientId });
      return;
    }

    const ltv = await sumPaidLtv(clientId);
    const level = levelFromLtv(ltv);
    const raw = `${level}|${ltv}`;

    let code = await kvGet(`phone:${phone}`);
    let created = false;
    if (!code) {
      code = await generateUniqueCode();
      await kvSet(`phone:${phone}`, code);
      created = true;
    }
    await kvSet(`code:${code}`, raw);

    // Если клиент уже открывал бота раньше — держим tg: в синхроне, иначе миниапп
    // покажет устаревший уровень до следующей ручной активации.
    const tgId = await kvGet(`codeowner:${code}`);
    if (tgId) {
      await kvSet(`tg:${tgId}`, `${raw}|${code}`);
    }

    res.status(200).json({ ok: true, orderId, clientId, phone, level, ltv, code, created, tgSynced: Boolean(tgId) });
  } catch (e) {
    // 200 даже при ошибке — чтобы InSales не заваливал повторными попытками из-за
    // единичного сбоя (например, клиент уже удалён). Ошибка уходит в логи Vercel.
    console.error("insales_webhook_error", e);
    res.status(200).json({ error: "processing_failed", detail: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 30 };
