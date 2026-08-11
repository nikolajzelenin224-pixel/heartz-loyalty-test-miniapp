const { verifyInitData } = require("./_lib/verifyInitData");
const { kvGet } = require("./_lib/kv");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { initData } = body || {};

  const check = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: check.reason });
    return;
  }

  try {
    const raw = await kvGet(`tg:${check.user.id}`);
    if (!raw) {
      res.status(404).json({ error: "not_linked" });
      return;
    }
    const [level, ltv, code] = raw.split("|");
    res.status(200).json({ level, ltv: Number(ltv), code: code || null });
  } catch (e) {
    res.status(502).json({ error: "storage_unavailable" });
  }
};
