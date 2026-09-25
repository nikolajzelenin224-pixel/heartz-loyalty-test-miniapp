# Подвал heartz.online с подпиской на рассылку

Форма e-mail в подвале, как на prada.com. E-mail уходит на обработчик на heartz.immo (1С-Битрикс) и сохраняется в модуль рассылок Битрикса.

## 1. Битрикс (heartz.immo)

1. Загрузить `bitrix/local/ajax/hz-newsletter-subscribe.php` на сервер в `/local/ajax/hz-newsletter-subscribe.php`.
2. Временно вписать любой ключ в `$HZ_DIAG_KEY` и открыть
   `https://heartz.immo/local/ajax/hz-newsletter-subscribe.php?diag=<ключ>`. Там будет видно, какой модуль установлен (`sender` - "Email-маркетинг" или `subscribe` - "Подписка, рассылки") и ID рассылок/рубрик.
3. Вписать нужный ID в `$HZ_SENDER_MAILING_IDS` или `$HZ_SUBSCRIBE_RUBRIC_IDS`. После этого снова очистить `$HZ_DIAG_KEY`.
4. Проверка: при открытии URL в браузере без `?diag` должно показаться `{"error":"method_not_allowed"}`.

## 2. InSales (heartz.online)

Виджет подвала: HTML заменить на `footer.html`, SCSS на `footer.scss`. Скрипт формы уже внутри HTML.
Проверить в режиме предпросмотра темы и только потом публиковать.
