// Разовый служебный эндпоинт для удаления ключа из KV. Защищён тем же секретом, что и BOT_TOKEN
// (отдельную переменную заводить незачем ради одноразовой операции). Удали этот файл после использования.
const { kvDel } = require("./_lib/kv");

module.exports = async (req, res) => {
  if (!process.env.BOT_TOKEN || req.query.token !== process.env.BOT_TOKEN) {
    res.status(404).end();
    return;
  }
  const key = req.query.key;
  if (!key) {
    res.status(400).json({ error: "missing_key" });
    return;
  }
  const result = await kvDel(key);
  res.status(200).json({ deleted: key, result });
};
