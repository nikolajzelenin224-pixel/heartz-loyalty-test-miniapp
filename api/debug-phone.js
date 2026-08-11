// ВРЕМЕННЫЙ диагностический эндпоинт. Проверяет, умеет ли InSales API фильтровать
// клиентов по номеру телефона на уровне запроса. Удалить сразу после теста.
const HOST = "myshop-cxk555.myinsales.ru";

function auth() {
  const login = process.env.INSALES_LOGIN;
  const password = process.env.INSALES_PASSWORD;
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

async function insales(path) {
  const res = await fetch(`https://${HOST}${path}`, {
    headers: { Authorization: auth() },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* не json */ }
  return { status: res.status, json };
}

function maskPhone(p) {
  if (!p) return p;
  return p.slice(0, -4).replace(/\d/g, "•") + p.slice(-4);
}

module.exports = async (req, res) => {
  const phone = req.query.phone;

  if (!phone) {
    // Без параметра — просто берём образец реальных клиентов, чтобы знать формат телефона.
    const sample = await insales("/admin/clients.json?per_page=3");
    const items = Array.isArray(sample.json) ? sample.json : [];
    res.status(sample.status).json({
      mode: "sample",
      count: items.length,
      sample: items.map(c => ({ id: c.id, phone: maskPhone(c.phone) })),
    });
    return;
  }

  const baseline = await insales("/admin/clients.json?per_page=1");
  const attempts = {};

  const a = await insales(`/admin/clients.json?client%5Bphone%5D=${encodeURIComponent(phone)}`);
  attempts["client[phone]"] = {
    status: a.status,
    count: Array.isArray(a.json) ? a.json.length : null,
    matched: Array.isArray(a.json) ? a.json.some(c => c.phone === phone) : null,
  };

  const b = await insales(`/admin/clients.json?phone=${encodeURIComponent(phone)}`);
  attempts["phone"] = {
    status: b.status,
    count: Array.isArray(b.json) ? b.json.length : null,
    matched: Array.isArray(b.json) ? b.json.some(c => c.phone === phone) : null,
  };

  const c = await insales(`/admin/clients.json?q=${encodeURIComponent(phone)}`);
  attempts["q"] = {
    status: c.status,
    count: Array.isArray(c.json) ? c.json.length : null,
    matched: Array.isArray(c.json) ? c.json.some(cl => cl.phone === phone) : null,
  };

  res.status(200).json({
    mode: "search",
    baselineTotalSample: Array.isArray(baseline.json) ? baseline.json.length : null,
    attempts,
  });
};
