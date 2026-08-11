// HEARTZ · Мини-приложение лояльности
// Идентификация клиента идёт по Telegram initData, подпись которого проверяется на бэкенде
// (см. api/_lib/verifyInitData.js). Локально initData никогда не парсится и не используется
// напрямую — только целиком пересылается на сервер, который сам достаёт из неё tg_id.

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const screens = {
  loading: document.getElementById("screen-loading"),
  code: document.getElementById("screen-code"),
  level: document.getElementById("screen-level"),
  fatal: document.getElementById("screen-fatal"),
};

function show(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function normalizeCode(raw) {
  return (raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

const LEVEL_NAMES = { I: "УРОВЕНЬ I", II: "УРОВЕНЬ II", III: "УРОВЕНЬ III", IV: "УРОВЕНЬ IV" };
const LEVEL_THRESHOLDS = { I: 9000, II: 20000, III: 50000, IV: null };
const PREV_THRESHOLDS = { I: 0, II: 9000, III: 20000, IV: 50000 };

function nextLevelName(level) {
  return { I: "II", II: "III", III: "IV" }[level] || "";
}

function renderLevel(data) {
  document.getElementById("level-badge").textContent = data.level;
  document.getElementById("level-name").textContent = LEVEL_NAMES[data.level] || data.level;
  document.getElementById("stat-ltv").textContent = data.ltv.toLocaleString("ru-RU") + " ₽";

  const next = LEVEL_THRESHOLDS[data.level];
  const fill = document.getElementById("progress-fill");
  const text = document.getElementById("progress-text");
  if (next === null) {
    fill.style.width = "100%";
    text.textContent = "Максимальный уровень";
  } else {
    const base = PREV_THRESHOLDS[data.level];
    const pct = Math.min(100, Math.round(((data.ltv - base) / (next - base)) * 100));
    fill.style.width = pct + "%";
    text.textContent = `До уровня ${nextLevelName(data.level)}: ${(next - data.ltv).toLocaleString("ru-RU")} ₽`;
  }
  show("level");
}

async function postJSON(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* пусто */ }
  return { ok: res.ok, status: res.status, data };
}

function showFatal(text) {
  document.getElementById("fatal-text").textContent = text;
  show("fatal");
}

async function loadMe() {
  show("loading");
  const { ok, status, data } = await postJSON("/api/me", { initData: tg.initData });

  if (ok) {
    renderLevel(data);
    return;
  }
  if (status === 404) {
    show("code");
    return;
  }
  if (status === 401) {
    showFatal("Не удалось подтвердить аккаунт Telegram. Попробуйте закрыть и снова открыть приложение из бота.");
    return;
  }
  showFatal("Не удалось связаться с сервером. Попробуйте ещё раз.");
}

async function submitCode(code) {
  show("loading");
  const { ok, status, data } = await postJSON("/api/lookup", { initData: tg.initData, code });

  if (ok) {
    renderLevel(data);
    return;
  }
  if (status === 404 || status === 400) {
    show("code");
    const err = document.getElementById("code-error");
    err.textContent = "Код не найден. Проверьте написание.";
    err.classList.remove("hidden");
    return;
  }
  if (status === 429) {
    show("code");
    const err = document.getElementById("code-error");
    err.textContent = "Слишком много попыток. Попробуйте позже.";
    err.classList.remove("hidden");
    return;
  }
  if (status === 401) {
    showFatal("Не удалось подтвердить аккаунт Telegram. Попробуйте закрыть и снова открыть приложение из бота.");
    return;
  }
  showFatal("Не удалось связаться с сервером. Попробуйте ещё раз.");
}

document.getElementById("code-submit").addEventListener("click", () => {
  const code = normalizeCode(document.getElementById("code-input").value);
  if (!code) return;
  submitCode(code);
});

document.getElementById("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("code-submit").click();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("code-input").value = "";
  document.getElementById("code-error").classList.add("hidden");
  show("code");
});

document.getElementById("fatal-retry").addEventListener("click", init);

// Промокод — пока заглушка, реальная выдача через InSales будет в отдельном блоке.
document.getElementById("promo-btn").addEventListener("click", async () => {
  const btn = document.getElementById("promo-btn");
  btn.disabled = true;
  btn.textContent = "Генерируем...";
  await new Promise(r => setTimeout(r, 600));
  const fake = "HZ-" + Math.random().toString(36).slice(2, 6).toUpperCase() + "-48H";
  const box = document.getElementById("promo-result");
  box.textContent = `${fake} — действует 48 часов, один раз`;
  box.classList.remove("hidden");
  btn.disabled = false;
  btn.textContent = "Получить новый промокод";
});

function init() {
  if (!tg || !tg.initData) {
    // Приложение открыто не из Telegram — initData нет и подтвердить личность нечем.
    showFatal("Откройте это приложение через кнопку в @heartzinfobot.");
    return;
  }
  loadMe();
}

init();
