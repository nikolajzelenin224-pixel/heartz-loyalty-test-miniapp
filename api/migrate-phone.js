// ВРЕМЕННЫЙ миграционный эндпоинт: заполняет обратный индекс phone:<телефон> -> код
// из батча, переданного в query-параметре. Никакие данные не хранятся в репозитории —
// только проходят транзитом через запрос. Удалить сразу после использования.
const { kvSet } = require("./_lib/kv");

module.exports = async (req, res) => {
  const batch = req.query.batch || "";
  const pairs = batch
    .split(",")
    .filter(Boolean)
    .map((s) => {
      const [phone, code] = s.split(":");
      return { phone, code };
    });

  let written = 0;
  for (const { phone, code } of pairs) {
    if (!phone || !code) continue;
    await kvSet(`phone:${phone}`, code);
    written++;
  }

  res.status(200).json({ written, total: pairs.length });
};
