<?php
/**
 * HEARTZ - подписка на рассылку из подвала магазина heartz.online (InSales).
 *
 * Куда положить: /local/ajax/hz-newsletter-subscribe.php на сайте heartz.immo
 * URL:           https://heartz.immo/local/ajax/hz-newsletter-subscribe.php
 *
 * Форма живёт на другом домене (heartz.online), поэтому запрос кросс-доменный:
 * отвечаем CORS-заголовками только для доменов магазина. Виджет шлёт JSON с
 * Content-Type: text/plain - это "простой" запрос, браузер не делает preflight.
 *
 * E-mail сохраняется в один из модулей Битрикса (что настроено ниже):
 *  - "Email-маркетинг" (sender)       - $HZ_SENDER_MAILING_IDS
 *  - "Подписка, рассылки" (subscribe) - $HZ_SUBSCRIBE_RUBRIC_IDS
 * Если заполнено и то, и другое - e-mail пишется в оба.
 *
 * Диагностика (узнать ID рассылок/рубрик и какие модули стоят):
 *   https://heartz.immo/local/ajax/hz-newsletter-subscribe.php?diag=<HZ_DIAG_KEY>
 */

// ===================== НАСТРОЙКИ =====================

// ID рассылок модуля "Email-маркетинг" (Маркетинг -> Рассылки), например [1]
$HZ_SENDER_MAILING_IDS = [];

// ID рубрик модуля "Подписка, рассылки" (Сервисы -> Рассылки -> Рубрики), например [1]
$HZ_SUBSCRIBE_RUBRIC_IDS = [];

// Ключ для ?diag=... Пустая строка - диагностика выключена.
$HZ_DIAG_KEY = '';

$HZ_ALLOWED_ORIGINS = [
    'https://heartz.online',
    'https://www.heartz.online',
    'https://myshop-cxk555.myinsales.ru',
];

// Не больше N запросов с одного IP за окно (секунд)
$HZ_RATE_LIMIT_MAX = 10;
$HZ_RATE_LIMIT_WINDOW = 600;

// =====================================================

define('NO_KEEP_STATISTIC', true);
define('NOT_CHECK_PERMISSIONS', true);
define('NO_AGENT_CHECK', true);
define('NO_AGENT_STATISTIC', true);
define('STOP_STATISTICS', true);
define('PUBLIC_AJAX_MODE', true);
define('DisableEventsCheck', true);

function hz_respond($code, array $data)
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data);
    die();
}

// --- CORS (до подключения ядра, чтобы OPTIONS отвечал мгновенно) ---
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
    die();
}

$isDiag = $method === 'GET' && $HZ_DIAG_KEY !== '' && isset($_GET['diag'])
    && hash_equals($HZ_DIAG_KEY, (string)$_GET['diag']);

if (!$isDiag) {
    if ($method !== 'POST') {
        hz_respond(405, ['error' => 'method_not_allowed']);
    }
    if (!$originAllowed) {
        hz_respond(403, ['error' => 'forbidden_origin']);
    }
}

require $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';


// --- Диагностика ---
if ($isDiag) {
    $out = [
        'sender_installed' => \Bitrix\Main\Loader::includeModule('sender'),
        'subscribe_installed' => \Bitrix\Main\Loader::includeModule('subscribe'),
        'configured_sender_mailing_ids' => $HZ_SENDER_MAILING_IDS,
        'configured_subscribe_rubric_ids' => $HZ_SUBSCRIBE_RUBRIC_IDS,
        'sender_mailings' => [],
        'subscribe_rubrics' => [],
    ];
    if ($out['sender_installed']) {
        try {
            $res = \Bitrix\Sender\MailingTable::getList([
                'select' => ['ID', 'NAME', 'ACTIVE', 'IS_PUBLIC'],
                'order' => ['ID' => 'ASC'],
            ]);
            while ($row = $res->fetch()) {
                $out['sender_mailings'][] = $row;
            }
        } catch (\Throwable $e) {
            $out['sender_mailings_error'] = $e->getMessage();
        }
    }
    if ($out['subscribe_installed']) {
        $res = \CRubric::GetList(['ID' => 'ASC'], []);
        while ($row = $res->Fetch()) {
            $out['subscribe_rubrics'][] = [
                'ID' => $row['ID'],
                'NAME' => $row['NAME'],
                'ACTIVE' => $row['ACTIVE'],
                'LID' => $row['LID'],
            ];
        }
    }
    hz_respond(200, $out);
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
    hz_respond(200, ['ok' => true, 'status' => 'subscribed']);
}

$email = strtolower(trim(isset($body['email']) ? (string)$body['email'] : ''));
if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    hz_respond(400, ['error' => 'bad_email']);
}

if (!$HZ_SENDER_MAILING_IDS && !$HZ_SUBSCRIBE_RUBRIC_IDS) {
    hz_respond(500, ['error' => 'not_configured']);
}

// --- Лимит запросов по IP (файловый счётчик, в файле только хэш IP) ---
function hz_rate_limited($max, $window)
{
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
    $dir = $_SERVER['DOCUMENT_ROOT'] . '/bitrix/cache/hz_newsletter_rl';
    if (!is_dir($dir) && !@mkdir($dir, BX_DIR_PERMISSIONS, true) && !is_dir($dir)) {
        return false; // не удалось создать папку - не блокируем подписку
    }
    $file = $dir . '/' . md5($ip . '|hz') . '.txt';
    $fp = @fopen($file, 'c+');
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

$saved = false;
$already = true;
$errors = [];

// --- Модуль "Email-маркетинг" (sender) ---
// \Bitrix\Sender\Subscription::add - тот же метод, что использует штатный
// компонент bitrix:sender.subscribe: создаёт контакт (если его нет) и подписывает
// его на указанные рассылки.
if ($HZ_SENDER_MAILING_IDS) {
    try {
        if (!\Bitrix\Main\Loader::includeModule('sender')) {
            throw new \Exception('sender_module_not_installed');
        }
        $contactId = \Bitrix\Sender\Subscription::add($email, array_map('intval', $HZ_SENDER_MAILING_IDS));
        if (!$contactId) {
            throw new \Exception('sender_add_failed');
        }
        $saved = true;
        $already = false; // модуль не сообщает, была ли подписка раньше
    } catch (\Throwable $e) {
        $errors[] = $e->getMessage();
    }
}

// --- Модуль "Подписка, рассылки" (subscribe) ---
if ($HZ_SUBSCRIBE_RUBRIC_IDS) {
    try {
        if (!\Bitrix\Main\Loader::includeModule('subscribe')) {
            throw new \Exception('subscribe_module_not_installed');
        }
        $rubricIds = array_map('intval', $HZ_SUBSCRIBE_RUBRIC_IDS);
        $subscription = new \CSubscription;
        $existing = \CSubscription::GetByEmail($email)->Fetch();

        if ($existing) {
            $current = array_map('intval', \CSubscription::GetRubricArray($existing['ID']));
            $merged = array_values(array_unique(array_merge($current, $rubricIds)));
            $needUpdate = count($merged) !== count($current)
                || $existing['ACTIVE'] !== 'Y'
                || $existing['CONFIRMED'] !== 'Y';
            if ($needUpdate) {
                $ok = $subscription->Update($existing['ID'], [
                    'ACTIVE' => 'Y',
                    'CONFIRMED' => 'Y',
                    'RUB_ID' => $merged,
                    'SEND_CONFIRM' => 'N',
                ]);
                if (!$ok) {
                    throw new \Exception('subscribe_update_failed: ' . $subscription->LAST_ERROR);
                }
                $already = false;
            }
        } else {
            $id = $subscription->Add([
                'USER_ID' => false,
                'FORMAT' => 'html',
                'EMAIL' => $email,
                'ACTIVE' => 'Y',
                'CONFIRMED' => 'Y',
                'SEND_CONFIRM' => 'N',
                'RUB_ID' => $rubricIds,
            ]);
            if (!$id) {
                throw new \Exception('subscribe_add_failed: ' . $subscription->LAST_ERROR);
            }
            $already = false;
        }
        $saved = true;
    } catch (\Throwable $e) {
        $errors[] = $e->getMessage();
    }
}

if (!$saved) {
    if (class_exists('\CEventLog')) {
        \CEventLog::Add([
            'SEVERITY' => 'ERROR',
            'AUDIT_TYPE_ID' => 'HZ_NEWSLETTER',
            'MODULE_ID' => 'main',
            'ITEM_ID' => '',
            'DESCRIPTION' => implode('; ', $errors),
        ]);
    }
    hz_respond(502, ['error' => 'save_failed']);
}

hz_respond(200, ['ok' => true, 'status' => $already ? 'already' : 'subscribed']);
