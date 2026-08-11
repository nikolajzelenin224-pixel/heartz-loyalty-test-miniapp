// ВРЕМЕННЫЙ миграционный эндпоинт. Заполняет обратный индекс phone:<телефон> -> код
// из переменной окружения PHONE_CODE_DATA (компактная строка, без делимитеров: каждая
// запись — 11 цифр телефона + 8 символов кода = 19 символов подряд). Данные не хранятся
// в репозитории — только в env var, которую нужно удалить после использования вместе с
// этим файлом.
const { kvPipeline } = require("./_lib/kv");

const RECORD_LEN = 19;
const PHONE_LEN = 11;
const CHUNK = 850;

module.exports = async (req, res) => {
  const raw = process.env.PHONE_CODE_DATA || "";
  if (raw.length % RECORD_LEN !== 0) {
    res.status(500).json({ error: "bad_data_length", length: raw.length });
    return;
  }

  const records = [];
  for (let i = 0; i < raw.length; i += RECORD_LEN) {
    const chunk = raw.slice(i, i + RECORD_LEN);
    const phone = chunk.slice(0, PHONE_LEN);
    const code = chunk.slice(PHONE_LEN);
    records.push([phone, code]);
  }

  let written = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const commands = slice.map(([phone, code]) => ["SET", `phone:${phone}`, code]);
    await kvPipeline(commands);
    written += slice.length;
  }

  res.status(200).json({ totalRecords: records.length, written });
};

module.exports.config = { maxDuration: 60 };
