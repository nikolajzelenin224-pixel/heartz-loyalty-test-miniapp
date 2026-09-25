<?php
/**
 * HEARTZ - подписка на рассылку с сайта heartz.online (InSales) в Unisender.
 *
 * Куда положить: /ajax/hz-newsletter-subscribe.php на сервере heartz.immo
 * URL:           https://heartz.immo/ajax/hz-newsletter-subscribe.php
 *
 * Зачем прокладка, а не запрос из браузера прямо в Unisender: API-ключ Unisender
 * даёт полный доступ к аккаунту, его нельзя показывать в коде сайта. Ключ живёт
 * только здесь, на сервере.
 *
 * Форма живёт на другом домене (heartz.online), поэтому отвечаем CORS-заголовками
 * только для доменов магазина. Виджет шлёт JSON с Content-Type: text/plain - это
 * "простой" запрос, браузер не делает preflight.
 *
 * Ядро Битрикса не подключается: файлу оно не нужно, так быстрее и надёжнее.
 */

// ===================== НАСТРОЙКИ =====================

// API-ключ Unisender хранится в ОТДЕЛЬНОМ файле hz-newsletter-key.php рядом с этим
// (в той же папке /ajax). Так этот файл можно обновлять, не вписывая ключ заново.
// При открытии hz-newsletter-key.php в браузере ключ не показывается.

// Откуда пришла подписка -> ID списка Unisender
$HZ_LISTS = [
    'footer'  => 72, // Подписка на рассылку. С сайта.
    'restock' => 71, // Уведомить о наличии. С сайта.
];

$HZ_ALLOWED_ORIGINS = [
    'https://heartz.online',
    'https://www.heartz.online',
    'https://myshop-cxk555.myinsales.ru',
];

// Не больше N запросов с одного IP за окно (секунд)
$HZ_RATE_LIMIT_MAX = 10;
$HZ_RATE_LIMIT_WINDOW = 600;

$HZ_UNISENDER_URL = 'https://api.unisender.com/ru/api/subscribe?format=json';

// =====================================================

// Форма в подвале отправляется обычным POST в невидимый iframe под полем ввода
// (target="hz-newsletter-frame"), поэтому страница магазина не перезагружается и
// скрипт на стороне InSales не нужен. Для такого запроса отвечаем не JSON, а
// маленькой HTML-страницей с сообщением в стиле сайта: она показывается в iframe
// и через 10 секунд плавно исчезает (CSS-анимация).
$HZ_CT = isset($_SERVER['CONTENT_TYPE']) ? strtolower((string)$_SERVER['CONTENT_TYPE']) : '';
$HZ_FORM_POST = strpos($HZ_CT, 'application/x-www-form-urlencoded') === 0
    || strpos($HZ_CT, 'multipart/form-data') === 0;

function hz_frame_page($ok, $text, $code = '')
{
    global $HZ_ALLOWED_ORIGINS;
    http_response_code(200);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    // Разрешаем показывать ответ во фрейме только на сайте магазина.
    // frame-ancestors отменяет X-Frame-Options, если его добавляет сервер.
    header('Content-Security-Policy: frame-ancestors ' . implode(' ', $HZ_ALLOWED_ORIGINS));
    // theme=dark - форма на тёмном фоне (попап «Уведомить»): светлый текст.
    $dark = isset($_POST['theme']) && $_POST['theme'] === 'dark';
    $color = $ok ? ($dark ? '#FFFFFF' : '#232429') : ($dark ? '#FF6B6B' : '#E0282E');
    if ($code !== '') {
        $text .= ': ' . substr(preg_replace('/[^a-z0-9_ ().:-]/i', '', $code), 0, 40);
    }
    $msg = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    $state = $ok ? 'ok' : 'error';
    echo '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
        . '<meta name="color-scheme" content="light">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<style>'
        . 'html,body{margin:0;padding:0;background:transparent;overflow:hidden}'
        . 'p{margin:0;padding:6px 0 0;font-family:"Helvetica","Helvetica Neue",Arial,sans-serif;'
        . 'font-weight:400;font-size:12px;line-height:140%;letter-spacing:2px;text-transform:uppercase;'
        . 'color:' . $color . ';opacity:0;animation:hz-in .35s ease forwards,hz-out .6s ease 10s forwards}'
        . '@media (max-width:420px){p{font-size:10px;letter-spacing:1px}}'
        . '@keyframes hz-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}'
        . '@keyframes hz-out{from{opacity:1}to{opacity:0}}'
        . '</style></head><body><p>' . $msg . '</p>'
        . '<script>try{parent.postMessage({hzNewsletter:"' . $state . '"},"*")}catch(e){}</script>'
        . '</body></html>';
    exit;
}

function hz_respond($code, array $data)
{
    global $HZ_FORM_POST;
    if ($HZ_FORM_POST) {
        if (!empty($data['ok'])) {
            hz_frame_page(true, 'Письмо уже у вас на почте - подтвердите подписку');
        }
        $err = isset($data['error']) ? $data['error'] : '';
        if ($err === 'bad_email') {
            hz_frame_page(false, 'Проверьте правильность e-mail');
        }
        if ($err === 'too_many_attempts') {
            hz_frame_page(false, 'Слишком много попыток, попробуйте позже');
        }
        // Короткий код причины - чтобы по скриншоту было понятно, что сломалось.
        $detail = isset($data['detail']) ? (string)$data['detail'] : '';
        hz_frame_page(false, 'Не получилось подписаться', $err . ($detail !== '' ? ' ' . $detail : ''));
    }
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data);
    exit;
}

// --- CORS ---
$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
$originAllowed = in_array($origin, $HZ_ALLOWED_ORIGINS, true);
if ($originAllowed) {
    header('Access-Control-Allow-Origin: ' . $origin);
}
header('Vary: Origin');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Max-Age: 86400');

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== 'POST') {
    hz_respond(405, ['error' => 'method_not_allowed']);
}
if (!$originAllowed) {
    hz_respond(403, ['error' => 'forbidden_origin', 'detail' => '(' . ($origin === '' ? 'empty' : $origin) . ')']);
}

// --- Тело запроса: JSON (text/plain или application/json) или обычный form POST ---
$body = [];
$raw = file_get_contents('php://input');
if ($HZ_FORM_POST) {
    $body = $_POST;
} elseif ($raw !== false && $raw !== '') {
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) {
        $body = $decoded;
    }
}

// Honeypot: невидимое поле, человек его не заполняет. Боту отвечаем "успехом".
if (!empty($body['website'])) {
    hz_respond(200, ['ok' => true, 'status' => 'confirm']);
}

$email = strtolower(trim(isset($body['email']) ? (string)$body['email'] : ''));
if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    hz_respond(400, ['error' => 'bad_email']);
}

$source = isset($body['source']) ? (string)$body['source'] : 'footer';
$tags = [];
if (!isset($HZ_LISTS[$source])) {
    $source = 'footer';
}
$tags[] = 'site_' . $source;

// Для «Уведомить о наличии»: метка товара, чтобы при поступлении выбрать в списке 71
// только тех, кто ждал именно этот товар. Берём латинский адрес товара из ссылки
// (/product/capital-distressed-t-shirt -> restock_capital-distressed-t-shirt).
if ($source === 'restock' && !empty($body['product_url'])) {
    $path = (string)parse_url((string)$body['product_url'], PHP_URL_PATH);
    $slug = strtolower(preg_replace('/[^a-z0-9-]+/i', '', basename($path)));
    if ($slug !== '') {
        $tags[] = substr('restock_' . $slug, 0, 60);
    }
}

$apiKey = '';
$keyFile = __DIR__ . '/hz-newsletter-key.php';
if (is_file($keyFile)) {
    $loaded = include $keyFile;
    if (is_string($loaded)) {
        $apiKey = trim($loaded);
    }
}
if ($apiKey === 'ВСТАВЬТЕ_КЛЮЧ_СЮДА') {
    $apiKey = '';
}
if ($apiKey === '') {
    $apiKey = trim((string)getenv('UNISENDER_API_KEY'));
}
if ($apiKey === '') {
    error_log('HZ_NEWSLETTER: UNISENDER_API_KEY is not set');
    hz_respond(500, ['error' => 'not_configured']);
}

// --- Лимит запросов по IP (файловый счётчик во временной папке, в имени только хэш IP) ---
function hz_rate_limited($max, $window)
{
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
    $dir = rtrim(sys_get_temp_dir(), '/') . '/hz_newsletter_rl';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        return false; // не удалось создать папку - не блокируем подписку
    }
    $fp = @fopen($dir . '/' . md5($ip . '|hz') . '.txt', 'c+');
    if (!$fp) {
        return false;
    }
    flock($fp, LOCK_EX);
    $now = time();
    $hits = array_filter(
        array_map('intval', explode(',', (string)stream_get_contents($fp))),
        function ($t) use ($now, $window) { return $t > $now - $window; }
    );
    $hits[] = $now;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, implode(',', $hits));
    flock($fp, LOCK_UN);
    fclose($fp);
    return count($hits) > $max;
}

if (hz_rate_limited($HZ_RATE_LIMIT_MAX, $HZ_RATE_LIMIT_WINDOW)) {
    hz_respond(429, ['error' => 'too_many_attempts']);
}

// --- Запрос в Unisender ---
// double_optin=0: Unisender сам отправит письмо "подтвердите подписку", контакт
// станет активным в списке только после клика по ссылке. request_ip -
// доказательство, откуда и когда пришла подписка (IP посетителя: браузер обращается
// к этому файлу напрямую).
// overwrite=0: если контакт уже есть, его данные не затираются.
$params = http_build_query([
    'api_key'       => $apiKey,
    'list_ids'      => (string)$HZ_LISTS[$source],
    'fields[email]' => $email,
    'tags'          => implode(',', $tags),
    'double_optin'  => 0,
    'request_ip'    => isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '',
    'overwrite'     => 0,
]);

$responseBody = false;
$httpCode = 0;
if (function_exists('curl_init')) {
    $ch = curl_init($HZ_UNISENDER_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $params,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => 12,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
    ]);
    $responseBody = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
} else {
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/x-www-form-urlencoded\r\n",
        'content'       => $params,
        'timeout'       => 12,
        'ignore_errors' => true,
    ]]);
    $responseBody = @file_get_contents($HZ_UNISENDER_URL, false, $ctx);
    $httpCode = $responseBody === false ? 0 : 200;
}

$result = is_string($responseBody) ? json_decode($responseBody, true) : null;

if ($httpCode !== 200 || !is_array($result) || !empty($result['error']) || !isset($result['result'])) {
    // Ключ в лог не попадает: логируем только ответ Unisender.
    error_log('HZ_NEWSLETTER: unisender failed, http=' . $httpCode . ' body=' . substr((string)$responseBody, 0, 500));
    $uniCode = is_array($result) && isset($result['code']) ? (string)$result['code'] : 'http_' . $httpCode;
    hz_respond(502, ['error' => 'save_failed', 'detail' => $uniCode]);
}

hz_respond(200, ['ok' => true, 'status' => 'confirm']);
