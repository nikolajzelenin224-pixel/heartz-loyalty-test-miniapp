// HEARTZ · Mystery Box — админ-утилита для тестовых боксов.
// GET /api/mystery-box/admin?key=...&code=...&action=status   — посмотреть состояние кода
// GET /api/mystery-box/admin?key=...&code=...&action=reset    — откатить "открыт" -> "закрыт"
// Открывается просто в браузере (или Postman) с секретным ключом в query — без интерфейса,
// по аналогии с остальными admin-эндпоинтами в этом проекте (external-discount.js,
// webhooks-setup.js).

const { kvGet, kvSet } = require("../_lib/kv");

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || "";
  if (!process.env.MYSTERYBOX_ADMIN_KEY || key !== process.env.MYSTERYBOX_ADMIN_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const code = String((req.query && req.query.code) || "").trim().toUpperCase();
  const action = (req.query && req.query.action) || "status";
  if (!code) {
    res.status(400).json({ error: "code_required" });
    return;
  }

  try {
    const raw = await kvGet(`boxcode:${code}`);
    if (action === "status") {
      res.status(200).json({ code, record: raw ? JSON.parse(raw) : null });
      return;
    }
    if (action === "reset") {
      if (!raw) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const record = JSON.parse(raw);
      record.redeemed = false;
      record.redeemedBy = null;
      record.redeemedAt = null;
      await kvSet(`boxcode:${code}`, JSON.stringify(record));
      res.status(200).json({ ok: true, code, action: "reset", record });
      return;
    }
    res.status(400).json({ error: "bad_action", allowed: ["status", "reset"] });
  } catch (e) {
    res.status(502).json({ error: "storage_unavailable", detail: String(e.message || e) });
  }
};
