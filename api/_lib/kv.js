const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvFetch(path) {
  const res = await fetch(`${KV_URL}${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`kv_error_${res.status}`);
  const json = await res.json();
  return json.result;
}

async function kvGet(key) {
  return kvFetch(`/get/${encodeURIComponent(key)}`);
}

async function kvSet(key, value) {
  return kvFetch(`/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
}

async function kvDel(key) {
  return kvFetch(`/del/${encodeURIComponent(key)}`);
}

// Инкрементирует счётчик, при первом инкременте в окне выставляет TTL.
// Возвращает текущее значение счётчика после инкремента.
async function kvIncrWithExpire(key, windowSeconds) {
  const count = await kvFetch(`/incr/${encodeURIComponent(key)}`);
  if (Number(count) === 1) {
    await kvFetch(`/expire/${encodeURIComponent(key)}/${windowSeconds}`);
  }
  return Number(count);
}

// Выполняет пачку команд одним запросом. commands — массив вида [["SET","k","v"], ...].
async function kvPipeline(commands) {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`kv_pipeline_error_${res.status}`);
  return res.json();
}

module.exports = { kvGet, kvSet, kvDel, kvIncrWithExpire, kvPipeline };
