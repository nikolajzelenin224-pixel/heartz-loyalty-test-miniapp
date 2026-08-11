const crypto = require("crypto");

// Проверяет подлинность initData, присланного Telegram Web App,
// по алгоритму: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Возвращает { ok: true, user, authDate } или { ok: false, reason }.
function verifyInitData(initDataRaw, botToken, maxAgeSeconds = 86400) {
  if (!initDataRaw || typeof initDataRaw !== "string") {
    return { ok: false, reason: "missing_init_data" };
  }
  if (!botToken) {
    return { ok: false, reason: "server_misconfigured" };
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing_hash" };
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computedHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (!authDate || ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    return { ok: false, reason: "expired" };
  }

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    user = null;
  }
  if (!user || !user.id) {
    return { ok: false, reason: "missing_user" };
  }

  return { ok: true, user, authDate };
}

module.exports = { verifyInitData };
