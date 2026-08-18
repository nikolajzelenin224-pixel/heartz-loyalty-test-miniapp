// HEARTZ · Мини-приложение лояльности
// Идентификация клиента идёт по Telegram initData, подпись которого проверяется на бэкенде
// (см. api/_lib/verifyInitData.js). Локально initData никогда не парсится и не используется
// напрямую — только целиком пересылается на сервер, который сам достаёт из неё tg_id.

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  // Не даём свайпом вниз "утащить" приложение и вызвать дрожание/скачки интерфейса —
  // весь скролл должен быть только внутри самого приложения.
  if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
  if (typeof tg.setHeaderColor === "function") {
    try { tg.setHeaderColor("secondary_bg_color"); } catch { /* не все клиенты поддерживают */ }
  }
}

const screens = {
  loading: document.getElementById("screen-loading"),
  code: document.getElementById("screen-code"),
  level: document.getElementById("screen-level"),
  fatal: document.getElementById("screen-fatal"),
  boxReveal: document.getElementById("screen-box-reveal"),
};

// Код лояльности — строго HEARTZ-XXXXXXXX по нашему алфавиту. Всё остальное, что ввели
// в это же поле, пробуем как код коробки Mystery Box (свой формат задаёт сторонняя
// программа, поэтому здесь намеренно нет жёсткой проверки формата).
const LOYALTY_CODE_RE = /^HEARTZ-?[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

function show(name) {
  Object.values(screens).forEach(s => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

// Единая кнопка "назад" в верхнем левом углу — видна там, где реально есть куда
// вернуться, и всегда ведёт на предыдущий по смыслу экран (а не просто "домой").
const backBtn = document.getElementById("screen-back-btn");
function setBack(handler) {
  if (handler) {
    backBtn.classList.remove("hidden");
    backBtn.onclick = handler;
  } else {
    backBtn.classList.add("hidden");
    backBtn.onclick = null;
  }
}

function normalizeCode(raw) {
  return (raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

const LEVEL_NAMES = {
  "0": "ПОКА НЕТ ПОКУПОК",
  I: "УРОВЕНЬ I",
  II: "УРОВЕНЬ II",
  III: "УРОВЕНЬ III",
  IV: "УРОВЕНЬ IV",
};
const LEVEL_THRESHOLDS = { I: 9000, II: 20000, III: 50000, IV: null };
const PREV_THRESHOLDS = { I: 0, II: 9000, III: 20000, IV: 50000 };

function nextLevelName(level) {
  return { I: "II", II: "III", III: "IV" }[level] || "";
}

let currentCode = null;
let promoCopiedTimer = null;

// Плашка с кодом и "Скопировано" не должна переживать переход на новый экран —
// иначе после повторного открытия уровня видно "Скопировано" от прошлого раза.
function resetPromoResult() {
  clearTimeout(promoCopiedTimer);
  document.getElementById("promo-result").classList.add("hidden");
  document.getElementById("promo-copied").classList.add("hidden");
  document.getElementById("promo-copied").classList.remove("fade-out");
}

function renderLevel(data) {
  currentCode = data.code || null;
  resetPromoResult();
  setBack(null);
  document.getElementById("level-badge").textContent = data.level === "0" ? "—" : data.level;
  document.getElementById("level-name").textContent = LEVEL_NAMES[data.level] || data.level;
  document.getElementById("stat-ltv").textContent = data.ltv.toLocaleString("ru-RU") + " ₽";

  const fill = document.getElementById("progress-fill");
  const text = document.getElementById("progress-text");

  if (data.level === "0") {
    fill.style.width = "0%";
    text.textContent = "Сделайте первую покупку, чтобы получить уровень";
    show("level");
    return;
  }

  const next = LEVEL_THRESHOLDS[data.level];
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
  setBack(null);
}

function showCodeScreen() {
  document.getElementById("code-block").classList.remove("hidden");
  document.getElementById("phone-block").classList.add("hidden");
  document.getElementById("code-support-btn").classList.add("hidden");
  show("code");
  // Если уровень уже был загружен в этой сессии (человек нажал "Ввести другой код"
  // случайно) — даём вернуться назад без повторного ввода кода.
  setBack(currentCode ? loadMe : null);
}

function showPhoneScreen() {
  document.getElementById("code-block").classList.add("hidden");
  document.getElementById("phone-block").classList.remove("hidden");
  document.getElementById("phone-support-btn").classList.add("hidden");
  show("code");
  setBack(showCodeScreen);
}

// Поддержка мини-приложения — @HeartzSupportBot. Показываем кнопку только там, где
// человеку реально может понадобиться живая помощь (код/бокс уже занят кем-то другим),
// а не на каждой ошибке — иначе она перестаёт быть сигналом "тут стоит написать".
function openSupport() {
  const url = "https://t.me/HeartzSupportBot";
  if (tg && tg.openTelegramLink) {
    tg.openTelegramLink(url);
  } else {
    window.open(url, "_blank");
  }
}
document.getElementById("code-support-btn").addEventListener("click", openSupport);
document.getElementById("phone-support-btn").addEventListener("click", openSupport);
document.getElementById("box-support-btn").addEventListener("click", openSupport);

async function loadMe() {
  show("loading");
  const { ok, status, data } = await postJSON("/api/me", { initData: tg.initData });

  if (ok) {
    renderLevel(data);
    return;
  }
  if (status === 404) {
    maybeAutoSubmitStartParam();
    return;
  }
  if (status === 401) {
    showFatal("Не удалось подтвердить аккаунт Telegram. Попробуйте закрыть и снова открыть приложение из бота.");
    return;
  }
  showFatal("Не удалось связаться с сервером. Попробуйте ещё раз.");
}

async function submitCode(code) {
  const consent = document.getElementById("code-consent").checked;
  if (!consent) {
    const err = document.getElementById("code-error");
    err.textContent = "Отметьте согласие на обработку персональных данных, чтобы продолжить.";
    err.classList.remove("hidden");
    return;
  }
  show("loading");
  const { ok, status, data } = await postJSON("/api/lookup", { initData: tg.initData, code, consent });

  if (ok) {
    renderLevel(data);
    return;
  }
  if (status === 404 || status === 400) {
    showCodeScreen();
    const err = document.getElementById("code-error");
    err.textContent = data?.error === "consent_required"
      ? "Отметьте согласие на обработку персональных данных."
      : "Код не найден. Проверьте написание — или войдите по номеру телефона, которым оформляли заказ.";
    err.classList.remove("hidden");
    return;
  }
  if (status === 409) {
    // Код уже привязан к другому Telegram-аккаунту — это не "неверный код", отдельная
    // ситуация, и человеку нужно подсказать реальный выход, а не просто "попробуйте ещё раз".
    showCodeScreen();
    const err = document.getElementById("code-error");
    err.textContent = "Этот код уже используется в другом Telegram-аккаунте. Попробуйте войти по номеру телефона — или напишите в поддержку, если уверены, что код ваш.";
    err.classList.remove("hidden");
    document.getElementById("code-support-btn").classList.remove("hidden");
    return;
  }
  if (status === 429) {
    showCodeScreen();
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

async function submitPhone(phone) {
  const name = document.getElementById("name-input").value.trim();
  const email = document.getElementById("email-input").value.trim();
  const birthDate = document.getElementById("birthdate-input").value || null;
  const consent = document.getElementById("phone-consent").checked;

  if (!name || !email) {
    showPhoneScreen();
    const err = document.getElementById("phone-error");
    err.textContent = "Заполните имя и email.";
    err.classList.remove("hidden");
    return;
  }
  if (!consent) {
    showPhoneScreen();
    const err = document.getElementById("phone-error");
    err.textContent = "Отметьте согласие на обработку персональных данных, чтобы продолжить.";
    err.classList.remove("hidden");
    return;
  }

  show("loading");
  const { ok, status, data } = await postJSON("/api/register-phone", {
    initData: tg.initData, phone, name, email, birthDate, consent,
  });

  if (ok) {
    renderLevel(data);
    return;
  }
  if (status === 400) {
    showPhoneScreen();
    const err = document.getElementById("phone-error");
    const messages = {
      consent_required: "Отметьте согласие на обработку персональных данных.",
      bad_profile: "Проверьте имя и email.",
      bad_phone_format: "Проверьте номер телефона.",
    };
    err.textContent = messages[data?.error] || "Проверьте введённые данные.";
    err.classList.remove("hidden");
    return;
  }
  if (status === 409) {
    showPhoneScreen();
    const err = document.getElementById("phone-error");
    err.textContent = "Код, привязанный к этому номеру, уже используется в другом Telegram-аккаунте. Если это ваш номер — напишите в поддержку, разберёмся.";
    err.classList.remove("hidden");
    document.getElementById("phone-support-btn").classList.remove("hidden");
    return;
  }
  if (status === 429) {
    showPhoneScreen();
    const err = document.getElementById("phone-error");
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

async function submitBoxCode(code) {
  show("loading");
  const { ok, status, data } = await postJSON("/api/mystery-box/redeem", { initData: tg.initData, code, consent: true });

  if (ok) {
    document.getElementById("box-reveal-image").src = data.imageUrl;
    show("boxReveal");
    setBack(loadMe);
    return;
  }
  if (status === 404) {
    showCodeScreen();
    const err = document.getElementById("code-error");
    err.textContent = "Код не найден — ни как код лояльности, ни как код бокса. Проверьте написание.";
    err.classList.remove("hidden");
    return;
  }
  if (status === 409) {
    showCodeScreen();
    const err = document.getElementById("code-error");
    err.textContent = "Этот бокс уже был активирован — с другого аккаунта. Если это ошибка, напишите в поддержку.";
    err.classList.remove("hidden");
    document.getElementById("code-support-btn").classList.remove("hidden");
    return;
  }
  if (status === 429) {
    showCodeScreen();
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
  if (!document.getElementById("code-consent").checked) {
    const err = document.getElementById("code-error");
    err.textContent = "Отметьте согласие на обработку персональных данных, чтобы продолжить.";
    err.classList.remove("hidden");
    return;
  }
  if (LOYALTY_CODE_RE.test(code)) {
    submitCode(code);
  } else {
    submitBoxCode(code);
  }
});

function showTgMessage(text) {
  if (tg && typeof tg.showAlert === "function") tg.showAlert(text);
  else alert(text);
}

document.getElementById("box-share-btn").addEventListener("click", () => {
  const url = document.getElementById("box-reveal-image").src;
  if (tg && typeof tg.shareToStory === "function") {
    tg.shareToStory(url, { text: "HEARTZ Special Supply" });
  } else {
    showTgMessage("Это же фото уже отправлено вам ботом в чат — им можно поделиться оттуда: переслать другу или добавить в историю.");
  }
});

document.getElementById("box-back-btn").addEventListener("click", loadMe);

document.getElementById("code-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("code-submit").click();
});

document.getElementById("phone-submit").addEventListener("click", () => {
  const phone = document.getElementById("phone-input").value.trim();
  if (!phone) return;
  submitPhone(phone);
});

document.getElementById("phone-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("phone-submit").click();
});

document.getElementById("show-phone-btn").addEventListener("click", showPhoneScreen);
document.getElementById("show-code-btn").addEventListener("click", showCodeScreen);

// Обычная ссылка с target="_blank" не всегда корректно открывается во WebView Telegram —
// используем tg.openLink, если доступен.
function openPrivacyLink(e) {
  e.preventDefault();
  const url = new URL("/privacy.html", window.location.href).toString();
  if (tg && tg.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, "_blank");
  }
}
document.getElementById("code-privacy-link").addEventListener("click", openPrivacyLink);
document.getElementById("phone-privacy-link").addEventListener("click", openPrivacyLink);

document.getElementById("reset-btn").addEventListener("click", () => {
  document.getElementById("code-input").value = "";
  document.getElementById("code-error").classList.add("hidden");
  showCodeScreen();
});

document.getElementById("fatal-retry").addEventListener("click", init);

// Код клиента — он же код скидки на сайте. Скидка на кассе считается по
// текущему уровню автоматически (см. api/external-discount.js), отдельного
// одноразового промокода не выдаём. По нажатию код показывается крупно и сразу
// копируется в буфер обмена, чтобы его не приходилось перепечатывать руками на сайте.
async function copyPromoCode() {
  const box = document.getElementById("promo-result");
  const codeEl = document.getElementById("promo-code");
  const copiedEl = document.getElementById("promo-copied");
  const hintEl = document.getElementById("promo-hint");

  if (!currentCode) {
    codeEl.textContent = "";
    copiedEl.classList.add("hidden");
    hintEl.textContent = "Код недоступен. Нажмите «Ввести другой код» и войдите заново.";
    box.classList.remove("hidden");
    return;
  }

  const fullCode = `HEARTZ-${currentCode}`;
  codeEl.textContent = fullCode;
  hintEl.textContent = "Введите этот код на странице «Корзина» на сайте — скидка применится по вашему уровню.";
  clearTimeout(promoCopiedTimer);
  copiedEl.classList.add("hidden");
  copiedEl.classList.remove("fade-out");
  box.classList.remove("hidden");

  try {
    await navigator.clipboard.writeText(fullCode);
    copiedEl.classList.remove("hidden");
    // Плашка "Скопировано" — временное подтверждение действия, а не постоянная часть
    // экрана: через 2 секунды начинаем плавно гасить, через 2.6 — прячем совсем.
    promoCopiedTimer = setTimeout(() => {
      copiedEl.classList.add("fade-out");
      promoCopiedTimer = setTimeout(() => copiedEl.classList.add("hidden"), 600);
    }, 2000);
  } catch {
    // Буфер обмена недоступен (редкий случай в некоторых WebView) — код всё равно
    // показан крупно и его можно выделить/скопировать вручную (user-select: all в CSS).
  }
}

document.getElementById("promo-btn").addEventListener("click", copyPromoCode);
document.getElementById("promo-code")?.addEventListener("click", copyPromoCode);

// Если приложение открыто по диплинку t.me/heartzinfobot/app?startapp=HEARTZ-XXXXXXXX,
// подставляем код автоматически, без ручного набора.
function maybeAutoSubmitStartParam() {
  const startParam = tg?.initDataUnsafe?.start_param;
  const code = normalizeCode(startParam || "");
  if (code) {
    submitCode(code);
  } else {
    showCodeScreen();
  }
}

function init() {
  if (!tg || !tg.initData) {
    // Приложение открыто не из Telegram — initData нет и подтвердить личность нечем.
    showFatal("Откройте это приложение через кнопку в @heartzinfobot.");
    return;
  }
  loadMe();
}

init();
