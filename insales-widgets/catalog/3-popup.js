(function () {
  // Попап «Уведомить»: e-mail уходит на heartz.immo в Unisender (список 71) с меткой
  // товара. Форма отправляется в iframe внутри попапа - страница не перезагружается,
  // ответ (успех/ошибка) показывается там же.
  function initNotifyPopup() {
    const popupBlock = document.querySelector(".form-notify-popup");
    if (!popupBlock || popupBlock.getAttribute("data-hz-ready")) return;
    popupBlock.setAttribute("data-hz-ready", "1");

    const btnClose = popupBlock.querySelector(".close-btn");
    const form = popupBlock.querySelector(".form");
    const notifyForm = popupBlock.querySelector("form");
    const emailInput = notifyForm.querySelector('input[name="email"]');
    const productUrlInput = notifyForm.querySelector('input[name="product_url"]');
    const frame = notifyForm.querySelector(".hz-restock-frame");
    let closeTimer = null;

    function closePopup() {
      clearTimeout(closeTimer);
      popupBlock.classList.remove("active");
    }

    // Делегирование: работает и для товаров, подгруженных кнопкой «показать ещё».
    $(document).on("click", ".product-subscription", function (event) {
      event.preventDefault();
      clearTimeout(closeTimer);
      productUrlInput.value = this.getAttribute("data-product-url") || "";
      if (frame) frame.style.visibility = "hidden"; // спрятать ответ от прошлого товара
      popupBlock.classList.add("active");
      setTimeout(function () { emailInput.focus(); }, 50);
    });

    // На сайте есть сторонний скрипт, который перехватывает отправку этой формы
    // (показывает «Вы подписаны на уведомление», а в Unisender ничего не уходит).
    // Ловим клик и отправку раньше него - в фазе захвата на window - и сами
    // отправляем форму обычным POST в iframe.
    function sendToUnisender() {
      if (frame) frame.style.visibility = "visible";
      HTMLFormElement.prototype.submit.call(notifyForm);
    }

    window.addEventListener("click", function (e) {
      const btn = e.target && e.target.closest ? e.target.closest(".button-subscribe") : null;
      if (!btn || !notifyForm.contains(btn)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      sendToUnisender();
    }, true);

    window.addEventListener("submit", function (e) {
      if (e.target !== notifyForm) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      sendToUnisender();
    }, true);

    btnClose.addEventListener("click", closePopup);

    popupBlock.addEventListener("click", function (e) {
      if (!form.contains(e.target)) closePopup();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && popupBlock.classList.contains("active")) closePopup();
    });

    // Ответ из iframe: при успехе очищаем поле и закрываем попап через 4 секунды.
    window.addEventListener("message", function (e) {
      if (e.origin !== "https://heartz.immo" || !e.data || e.data.hzNewsletter !== "ok") return;
      if (!frame || e.source !== frame.contentWindow) return;
      emailInput.value = "";
      clearTimeout(closeTimer);
      closeTimer = setTimeout(closePopup, 4000);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initNotifyPopup);
  } else {
    initNotifyPopup();
  }
})();
