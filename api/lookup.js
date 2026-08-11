const { verifyInitData } = require("./_lib/verifyInitData");
const { kvGet, kvSet, kvIncrWithExpire } = require("./_lib/kv");

const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const RATE_LIMIT_MAX = 10;      // попыток
const RATE_LIMIT_WINDOW = 600;  // за 10 минут, секунд

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { initData, code } = body || {};

  const check = verifyInitData(initData, process.env.BOT_TOKEN);
  if (!check.ok) {
    res.status(401).json({ error: check.reason });
    return;
  }

  const tgId = check.user.id;

  try {
    const attempts = await kvIncrWithExpire(`ratelimit:lookup:${tgId}`, RATE_LIMIT_WINDOW);
    if (attempts > RATE_LIMIT_MAX) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }

    const normalized = String(code || "").trim().toUpperCase().replace(/^HEARTZ-?/, "");
    if (!CODE_RE.test(normalized)) {
      res.status(400).json({ error: "bad_code_format" });
      return;
    }

    const raw = await kvGet(`code:${normalized}`);
    if (!raw) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await kvSet(`tg:${tgId}`, `${raw}|${normalized}`);

    const [level, ltv] = raw.split("|");
    res.status(200).json({ level, ltv: Number(ltv), code: normalized });
  } catch (e) {
    res.status(502).json({ error: "storage_unavailable" });
  }
};
