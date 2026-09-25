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

// API-ключ Unisender (Настройки аккаунта, раздел Интеграция и API).
// Заменить ВСТАВЬТЕ_КЛЮЧ_СЮДА на ключ, кавычки оставить. Править файл только
// в Блокноте/редакторе кода и загружать заново, НЕ во встроенном редакторе Битрикса.
// В репозиторий ключ не коммитить.
$HZ_UNISENDER_API_KEY = 'ВСТАВЬТЕ_КЛЮЧ_СЮДА';

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

function hz_respond($code, array $data)
{
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
    hz_respond(403, ['error' => 'forbidden_origin']);
}

// --- Тело запроса: JSON (text/plain или application/json) или обычный form POST ---
$body = [];
$raw = file_get_contents('php://input');
if ($raw !== false && $raw !== '') {
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) {
        $body = $decoded;
    }
}
if (!$body && !empty($_POST)) {
    $body = $_POST;
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
if (!isset($HZ_LISTS[$source])) {
    $source = 'footer';
}

$apiKey = trim($HZ_UNISENDER_API_KEY);
if ($apiKey === 'ВСТАВЬТЕ_КЛЮЧ_СЮДА') {
    $apiKey = (string)getenv('UNISENDER_API_KEY');
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
    'tags'          => 'site_' . $source,
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
    hz_respond(502, ['error' => 'save_failed']);
}

hz_respond(200, ['ok' => true, 'status' => 'confirm']);
