// ВРЕМЕННЫЙ админ-эндпоинт для регистрации вебхука в InSales. По аналогии с
// api/migrate-phone-bulk.js — вызывается один раз, потом файл удаляется вместе с
// переменной INSALES_WEBHOOK_KEY при желании её сменить (или просто оставляется —
// endpoint защищён тем же ключом, что и сам приёмник вебхуков, но лучше удалить после
// использования, как советует finding по гигиене кода из плана 18.08.2026).
//
// GET  /api/webhooks/webhooks-setup?key=...           — список текущих вебхуков
// POST /api/webhooks/webhooks-setup?key=...&topic=orders/create  — создать вебхук на этот topic

const HOST = "myshop-cxk555.myinsales.ru";

function insalesAuth() {
  const login = process.env.INSALES_LOGIN;
  const password = process.env.INSALES_PASSWORD;
  return "Basic " + Buffer.from(`${login}:${password}`).toString("base64");
}

function targetUrl() {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://heartz-loyalty.vercel.app";
  return `${base}/api/webhooks/insales-order?key=${encodeURIComponent(process.env.INSALES_WEBHOOK_KEY || "")}`;
}

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || "";
  if (!process.env.INSALES_WEBHOOK_KEY || key !== process.env.INSALES_WEBHOOK_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    if (req.method === "GET") {
      const r = await fetch(`https://${HOST}/admin/webhooks.json`, { headers: { Authorization: insalesAuth() } });
      const list = await r.json();
      res.status(r.status).json(list);
      return;
    }

    if (req.method === "POST") {
      const topic = (req.query && req.query.topic) || "";
      if (!["orders/create", "orders/update"].includes(topic)) {
        res.status(400).json({ error: "bad_topic", allowed: ["orders/create", "orders/update"] });
        return;
      }
      const r = await fetch(`https://${HOST}/admin/webhooks.json`, {
        method: "POST",
        headers: { Authorization: insalesAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ webhook: { address: targetUrl(), topic } }),
      });
      const data = await r.json();
      res.status(r.status).json(data);
      return;
    }

    res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    res.status(502).json({ error: "insales_unavailable", detail: String(e.message || e) });
  }
};
