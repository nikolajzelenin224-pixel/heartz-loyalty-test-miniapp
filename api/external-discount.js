// "Внешняя скидка" InSales: этот URL InSales дёргает сам, с сайта корзины,
// когда клиент вводит код в доп. поле заказа и отправляет форму на /cart_items.
// Не часть миниаппа — вызывается InSales напрямую, поэтому initData здесь нет,
// вместо него — секретный ключ в query-параметре (?key=...), известный только
// нам и вписанный в настройку "Внешняя скидка" в админке InSales.
// Документация: https://www.insales.ru/collection/doc-skidki/product/vneshnie-skidki

const { kvGet } = require("./_lib/kv");

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_RE = new RegExp(`HEARTZ-?([${ALPHABET}]{8})`);
const LEVEL_DISCOUNT = { I: 5, II: 10, III: 15, IV: 20 };

// Точное имя поля, в которое InSales положит введённое клиентом значение,
// зависит от ID доп. поля заказа (назначается только при его создании в
// админке InSales, заранее неизвестен). Чтобы не зависеть от непроверенного
// имени ключа, ищем код по формату (HEARTZ-XXXXXXXX) во всём теле запроса.
function findCode(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    const m = value.toUpperCase().match(CODE_RE);
    return m ? m[1] : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = findCode(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || "";
  if (!process.env.EXTERNAL_DISCOUNT_KEY || key !== process.env.EXTERNAL_DISCOUNT_KEY) {
    res.status(401).json({ errors: ["unauthorized"] });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const code = findCode(body);
  if (!code) {
    res.status(200).json({ errors: ["Введите код клиента Heartz (HEARTZ-XXXXXXXX)"] });
    return;
  }

  try {
    const raw = await kvGet(`code:${code}`);
    if (!raw) {
      res.status(200).json({ errors: ["Код Heartz не найден"] });
      return;
    }
    const [level] = raw.split("|");
    const discount = LEVEL_DISCOUNT[level];
    if (!discount) {
      res.status(200).json({ errors: ["Скидка по коду появится после первой покупки"] });
      return;
    }
    res.status(200).json({
      discount,
      discount_type: "PERCENT",
      title: `Heartz — скидка ${discount}% (уровень ${level})`,
    });
  } catch (e) {
    res.status(200).json({ errors: ["Сервис лояльности временно недоступен, попробуйте позже"] });
  }
};

module.exports.config = { maxDuration: 15 };
