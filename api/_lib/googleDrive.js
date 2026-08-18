// HEARTZ · Mystery Box — доступ к Google Диску сервисным аккаунтом (JWT Bearer flow).
// Без внешних библиотек (googleapis и т.п.), только встроенный crypto + fetch — тот же
// подход, что и в остальном бэкенде (см. api/_lib/verifyInitData.js).
//
// Как это настроить (нужно один раз сделать в Google Cloud Console):
// 1. Создать проект (или использовать существующий) на console.cloud.google.com.
// 2. Включить Google Drive API для этого проекта.
// 3. Создать сервисный аккаунт (IAM & Admin → Service Accounts), создать ему JSON-ключ.
// 4. Из JSON-ключа взять поля client_email и private_key — это и есть
//    GOOGLE_SERVICE_ACCOUNT_EMAIL и GOOGLE_SERVICE_ACCOUNT_KEY в env Vercel
//    (private_key вставлять как есть, включая -----BEGIN PRIVATE KEY-----...).
// 5. Расшарить папку на Google Диске с Reveal Card на email сервисного аккаунта
//    (Доступ к файлу → добавить email из client_email, роль "Читатель").
// 6. ID папки — это часть ссылки на неё: https://drive.google.com/drive/folders/<ID>.
//    Записать как GOOGLE_DRIVE_FOLDER_ID.

const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedToken = null; // { token, expiresAt } — кэш в рамках "тёплого" инстанса функции

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.token;
  }

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !rawKey) throw new Error("google_drive_not_configured");
  // В переменных окружения Vercel перенос строки в приватном ключе обычно хранится как
  // литеральные "\n" — раскрываем их обратно в настоящие переносы строк.
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`google_token_error_${res.status}`);
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function driveFetch(path, accessToken) {
  const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`google_drive_error_${res.status}`);
  return res;
}

// Ищет в целевой папке файл, названный кодом бокса (сотрудник называет файл ровно
// кодом при выгрузке, например "28682V.png" — расширение InSales/Диск добавляют сами).
// Регистр и расширение не важны: сравниваем имя без расширения без учёта регистра.
async function findFileByCode(code) {
  const accessToken = await getAccessToken();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("google_drive_folder_not_configured");

  const safeCode = code.replace(/'/g, "");
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed = false and name contains '${safeCode}'`
  );
  const listRes = await driveFetch(`/files?q=${q}&fields=files(id,name)&pageSize=10`, accessToken);
  const listData = await listRes.json();
  const files = listData.files || [];
  const exact = files.find((f) => f.name.replace(/\.[^.]+$/, "").toUpperCase() === code.toUpperCase());
  const file = exact || files[0];
  if (!file) return null;

  const contentRes = await driveFetch(`/files/${file.id}?alt=media`, accessToken);
  const buffer = Buffer.from(await contentRes.arrayBuffer());
  const contentType = contentRes.headers.get("content-type") || "image/png";
  return { name: file.name, buffer, contentType };
}

module.exports = { findFileByCode };
