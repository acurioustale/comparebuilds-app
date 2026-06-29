<?php

declare(strict_types=1);

// ─── Runtime hardening ─────────────────────────────────────────────────────────
// Never leak PHP errors/stack traces to clients; log them server-side instead.
ini_set('display_errors', '0');
error_reporting(E_ALL);

// Response headers are only emitted when share.php handles a request itself.
// When included by og.php (via SHARE_API_NO_MAIN) for helper functions only,
// skip them so og.php can set its own Content-Type.
if (!defined('SHARE_API_NO_MAIN')) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('Cache-Control: no-store');
    // No CORS headers are sent on purpose: the browser will block cross-origin reads
    // and writes, so only the site itself (same origin) can use this API.
}

// ─── Limits / config ───────────────────────────────────────────────────────────
// MAX_BUILDS / MAX_BUILD_LEN are mirrored client-side in src/store/buildsStore.js.
// This file is the authority (the client only validates early for nicer errors);
// keep the two in sync if either limit changes.
const MAX_BODY_BYTES    = 16384; // raw POST body cap (5 builds * 2000 + overhead)
const MAX_BUILD_LEN     = 2000;
const MIN_BUILDS        = 2;
const MAX_BUILDS        = 5;
const MAX_LABEL_LEN     = 40;    // per-slot name cap; mirrors MAX_BUILD_NAME_LEN client-side
const MAX_NAME_LEN      = 64;    // class/spec display-name cap (used by the OG image)
const RATE_LIMIT_MAX    = 20;    // max shares one IP may create per window
const RATE_LIMIT_WINDOW = 3600;  // window length in seconds (1 hour)
const ID_LEN            = 8;
const MAX_ID_LEN        = 16;   // max chars after collision extension
// Content-address id alphabet (base62). Self-consistent across the GMP and
// pure-PHP encoders below; deliberately not the ordering gmp_strval(…, 62) uses.
const BASE62_ALPHABET   = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Build strings are base64 (RFC 4648 alphabet, optional padding).
const BUILD_PATTERN     = '/^[A-Za-z0-9+\/]{1,2000}={0,2}$/';
const SHARE_ID_PATTERN  = '/^[A-Za-z0-9]{8,16}$/';

/**
 * A share-creation failure the client should see verbatim (rate limit, server
 * busy, id exhaustion). Carrying the HTTP status and optional Retry-After on the
 * exception lets the request handler map failures structurally instead of
 * matching on message strings; unexpected DB/runtime errors stay plain
 * Throwables so they land on the generic "Database error" path and never leak.
 */
class ShareException extends RuntimeException
{
    public function __construct(
        public readonly int $httpStatus,
        string $clientMessage,
        public readonly ?int $retryAfter = null,
    ) {
        parent::__construct($clientMessage);
    }
}

/** Emit a JSON error and stop. */
function fail(int $code, string $msg): void
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

/** The canonical site origin (overridable in config.php for staging). */
function site_origin(): string
{
    $origin = defined('SITE_ORIGIN') ? SITE_ORIGIN : 'https://comparebuilds.app';
    return rtrim($origin, '/');
}

/**
 * Whether a state-changing request came from our own origin. Pure: takes the
 * relevant request headers, returns bool — so it is unit-testable.
 *
 * The API sends no CORS headers, which blocks cross-origin *reads*, but a
 * "simple" cross-origin POST (e.g. Content-Type: text/plain) is delivered
 * without a preflight, so the write side effect would still run (CSRF). Reject
 * any write that isn't same-origin. Prefer Sec-Fetch-Site (sent by modern
 * browsers and not script-settable), fall back to Origin, then Referer. With no
 * origin signal at all, fail closed: a real same-origin fetch always sends at
 * least one of these.
 */
function is_same_origin_write(?string $secFetchSite, ?string $origin, ?string $referer): bool
{
    $site = site_origin();

    if ($secFetchSite !== null && $secFetchSite !== '') {
        return $secFetchSite === 'same-origin';
    }
    if ($origin !== null && $origin !== '') {
        return $origin === $site;
    }
    if ($referer !== null && $referer !== '') {
        return $referer === $site || str_starts_with($referer, $site . '/');
    }
    return false;
}

/**
 * Renders the HTML share page served at /s/<id>. Crawlers read the Open Graph
 * tags + generated image; humans are redirected to the SPA (#id) via a meta
 * refresh — no inline script, so it stays within the site's strict CSP.
 * `$data` may be null (share missing/expired) — then a generic card is shown.
 */
function render_share_page(string $id, ?array $data): void
{
    $origin = site_origin();
    $count  = is_array($data['builds'] ?? null) ? count($data['builds']) : 0;
    $class  = is_string($data['className'] ?? null) ? $data['className'] : '';
    $spec   = is_string($data['specName'] ?? null) ? $data['specName'] : '';

    $name  = trim("$spec $class");
    $title = $name !== '' ? "$name — Compare Builds" : 'Compare Builds — WoW talent build comparison';
    $desc  = $count >= 2
        ? "$count " . ($class !== '' ? "$class " : '') . 'talent builds compared on comparebuilds.app.'
        : 'A World of Warcraft talent build on comparebuilds.app.';
    $image   = "$origin/api/og.php?id=$id";
    $appUrl  = "$origin/#$id";
    $pageUrl = "$origin/s/$id";

    $e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none';");
    header('Cache-Control: public, max-age=86400');
    echo "<!doctype html>\n<html lang=\"en\">\n<head>\n"
       . "<meta charset=\"utf-8\">\n"
       . "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
       . "<title>" . $e($title) . "</title>\n"
       . "<meta name=\"description\" content=\"" . $e($desc) . "\">\n"
       . "<link rel=\"canonical\" href=\"" . $e($pageUrl) . "\">\n"
       . "<meta property=\"og:type\" content=\"website\">\n"
       . "<meta property=\"og:site_name\" content=\"Compare Builds\">\n"
       . "<meta property=\"og:title\" content=\"" . $e($title) . "\">\n"
       . "<meta property=\"og:description\" content=\"" . $e($desc) . "\">\n"
       . "<meta property=\"og:url\" content=\"" . $e($pageUrl) . "\">\n"
       . "<meta property=\"og:image\" content=\"" . $e($image) . "\">\n"
       . "<meta property=\"og:image:width\" content=\"1200\">\n"
       . "<meta property=\"og:image:height\" content=\"630\">\n"
       . "<meta name=\"twitter:card\" content=\"summary_large_image\">\n"
       . "<meta name=\"twitter:title\" content=\"" . $e($title) . "\">\n"
       . "<meta name=\"twitter:description\" content=\"" . $e($desc) . "\">\n"
       . "<meta name=\"twitter:image\" content=\"" . $e($image) . "\">\n"
       . "<meta http-equiv=\"refresh\" content=\"0; url=" . $e($appUrl) . "\">\n"
       . "</head>\n<body>\n"
       . "<p>Opening this build in <a href=\"" . $e($appUrl) . "\">Compare Builds</a>…</p>\n"
       . "</body>\n</html>\n";
    exit;
}

/**
 * The client IP used for rate limiting.
 *
 * Direct hosting: REMOTE_ADDR is the real client. Behind a reverse proxy or CDN
 * (Cloudflare, etc.) REMOTE_ADDR is the proxy, collapsing every visitor into one
 * rate-limit bucket. Prefers dedicated untamperable headers like CF-Connecting-IP
 * or X-Real-IP. If falling back to X-Forwarded-For, the real client is the LAST
 * hop: the trusted proxy appends the IP it actually saw connect as the rightmost
 * entry, while any earlier entries are client-supplied and spoofable. Taking the
 * first entry instead would let an attacker forge a fresh rate-limit key per request.
 * The headers are ONLY trusted when the operator opts in by defining TRUST_PROXY
 * truthy in config.php (i.e. you know a trusted proxy always sets/appends them).
 * Defaults to REMOTE_ADDR.
 */
function is_ip_in_cidr(string $ip, string $cidr): bool
{
    if (str_contains($cidr, '/')) {
        list($subnet, $bits) = explode('/', $cidr, 2);
        $bits = (int) $bits;
        $ipCalc = ip2long($ip);
        $subnetCalc = ip2long($subnet);
        if ($ipCalc === false || $subnetCalc === false) {
            return false;
        }
        $mask = -1 << (32 - $bits);
        return ($ipCalc & $mask) === ($subnetCalc & $mask);
    }
    return $ip === $cidr;
}

function is_trusted_proxy(string $ip): bool
{
    if (!defined('TRUSTED_PROXIES') || !is_array(TRUSTED_PROXIES)) {
        return true;
    }
    foreach (TRUSTED_PROXIES as $proxy) {
        if (is_ip_in_cidr($ip, $proxy)) {
            return true;
        }
    }
    return false;
}

function client_ip(): string
{
    $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
    if (defined('TRUST_PROXY') && TRUST_PROXY && is_trusted_proxy($remoteAddr)) {
        if (defined('TRUST_CLOUDFLARE') && TRUST_CLOUDFLARE && !empty($_SERVER['HTTP_CF_CONNECTING_IP'])) {
            return $_SERVER['HTTP_CF_CONNECTING_IP'];
        }
        if (defined('TRUST_X_REAL_IP') && TRUST_X_REAL_IP && !empty($_SERVER['HTTP_X_REAL_IP'])) {
            return $_SERVER['HTTP_X_REAL_IP'];
        }
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ips = array_map('trim', explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']));
            $realIp = end($ips);
            if (filter_var($realIp, FILTER_VALIDATE_IP) !== false) {
                return $realIp;
            }
        }
    }
    return $remoteAddr;
}

/** Salted hash of the client IP, used only for rate limiting (not reversible to an IP in practice). */
function client_ip_hash(): string
{
    $salt = defined('SHARE_IP_SALT') ? SHARE_IP_SALT : 'comparebuilds-default-salt';
    return hash('sha256', $salt . '|' . client_ip());
}

/**
 * Whether a string is a well-formed share id (8–16 alphanumeric chars). The
 * pattern is mirrored in src/lib/route.js and api/og.php; shareIdParity.test.js
 * keeps the three copies in sync across the two languages.
 */
function valid_share_id(string $id): bool
{
    return preg_match(SHARE_ID_PATTERN, $id) === 1;
}

/**
 * Validates a decoded POST body for share creation. Pure: no DB, no superglobals,
 * no output — so it is unit-testable. Returns ['error' => string] on the first
 * failure (always a 400-class client error), or ['payload' => array] with the
 * normalised, storable payload on success.
 */
function validate_share_input(mixed $body): array
{
    if (!is_array($body)) {
        return ['error' => 'Expected a JSON object'];
    }

    $classId = $body['classId'] ?? null;
    $specId  = $body['specId']  ?? null;
    $builds  = $body['builds']  ?? null;

    if (
        !is_int($classId) || $classId <= 0 || $classId > 1000000 ||
        !is_int($specId) || $specId <= 0 || $specId > 1000000
    ) {
        return ['error' => 'classId and specId must be positive integers'];
    }
    if (!is_array($builds)) {
        return ['error' => 'builds must be a JSON array'];
    }
    if (count($builds) < MIN_BUILDS || count($builds) > MAX_BUILDS) {
        return ['error' => 'builds must contain ' . MIN_BUILDS . '–' . MAX_BUILDS . ' entries'];
    }
    foreach ($builds as $b) {
        // BUILD_PATTERN allows up to 2000 base64 data chars plus padding (2002
        // total); cap the overall length too so the server agrees with the
        // documented MAX_BUILD_LEN and the client's per-string limit.
        if (!is_string($b) || strlen($b) > MAX_BUILD_LEN || !preg_match(BUILD_PATTERN, $b)) {
            return ['error' => 'Each build must be a base64 build string ≤ ' . MAX_BUILD_LEN . ' chars'];
        }
    }

    // Optional per-slot labels: must parallel builds, each a short string.
    $labels = $body['labels'] ?? null;
    if ($labels !== null) {
        if (!is_array($labels) || count($labels) !== count($builds)) {
            return ['error' => 'labels, when present, must be an array parallel to builds'];
        }
        foreach ($labels as $l) {
            if (!is_string($l) || mb_strlen($l) > MAX_LABEL_LEN) {
                return ['error' => 'Each label must be a string ≤ ' . MAX_LABEL_LEN . ' chars'];
            }
        }
        // Drop an all-empty labels array so we never store noise.
        if (count(array_filter($labels, fn ($l) => $l !== '')) === 0) {
            $labels = null;
        }
    }

    // Optional class/spec display names (used by the OG image so it needs no
    // class index of its own). Validated as short plain strings.
    $className = $body['className'] ?? null;
    $specName  = $body['specName']  ?? null;
    foreach (['className' => $className, 'specName' => $specName] as $k => $v) {
        if ($v !== null && (!is_string($v) || mb_strlen($v) > MAX_NAME_LEN)) {
            return ['error' => "$k, when present, must be a string ≤ " . MAX_NAME_LEN . ' chars'];
        }
    }

    $layoutHash = $body['layoutHash'] ?? null;
    if ($layoutHash !== null && (!is_string($layoutHash) || !preg_match('/^[a-fA-F0-9]{1,16}$/', $layoutHash))) {
        return ['error' => 'layoutHash, when present, must be a hex string 1–16 chars'];
    }

    $payload = ['classId' => $classId, 'specId' => $specId, 'builds' => $builds];
    if ($labels !== null) {
        $payload['labels'] = $labels;
    }
    if ($className !== null) {
        $payload['className'] = $className;
    }
    if ($specName !== null) {
        $payload['specName'] = $specName;
    }
    if ($layoutHash !== null) {
        $payload['layoutHash'] = $layoutHash;
    }

    return ['payload' => $payload];
}

/**
 * Base62-encodes the SHA-256 hash of a string — the content-address id space.
 * Prefers GMP; falls back to pure-PHP big-integer division so it works on hosts
 * without the extension. The two paths are pinned to identical output by
 * ShareValidationTest (testBase62FallbackMatchesGmp).
 */
function base62_encode_sha256(string $input): string
{
    return base62_from_hex(hash('sha256', $input));
}

/** Dispatches to the GMP or pure-PHP base62 encoder for a hex string. */
function base62_from_hex(string $hex): string
{
    return function_exists('gmp_init')
        ? base62_from_hex_gmp($hex)
        : base62_from_hex_php($hex);
}

/** GMP-backed base62 of a hex string (left-padded to a minimum of ID_LEN). */
function base62_from_hex_gmp(string $hex): string
{
    $num = gmp_init($hex, 16);
    $base62 = '';
    while (gmp_cmp($num, 0) > 0) {
        list($num, $rem) = gmp_div_qr($num, 62);
        $base62 = BASE62_ALPHABET[gmp_intval($rem)] . $base62;
    }
    return str_pad($base62, ID_LEN, '0', STR_PAD_LEFT);
}

/**
 * Pure-PHP base62 of a hex string. Long-divides the number by 62 one hex nibble
 * at a time (most-significant first), so place value stays exact regardless of
 * the running quotient's length and the per-nibble accumulator never overflows a
 * PHP int (61*16+15 = 991). Output is identical to the GMP path.
 */
function base62_from_hex_php(string $hex): string
{
    $digits = array_map('hexdec', str_split($hex)); // base-16 digits, MSB first
    $len = count($digits);
    $start = 0;
    $base62 = '';
    while ($start < $len) {
        $remainder = 0;
        for ($i = $start; $i < $len; $i++) {
            $acc = $remainder * 16 + $digits[$i];
            $digits[$i] = intdiv($acc, 62);
            $remainder = $acc % 62;
        }
        $base62 = BASE62_ALPHABET[$remainder] . $base62;
        // Drop leading zero digits the division has consumed.
        while ($start < $len && $digits[$start] === 0) {
            $start++;
        }
    }
    return str_pad($base62, ID_LEN, '0', STR_PAD_LEFT);
}

/**
 * Deterministically canonicalizes the payload for content-addressing.
 */
function canonicalize_payload(array $payload): string
{
    $ordered = [];
    foreach (['classId', 'specId', 'className', 'specName', 'layoutHash', 'builds', 'labels'] as $key) {
        if (isset($payload[$key])) {
            $ordered[$key] = $payload[$key];
        }
    }
    return json_encode($ordered, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/**
 * Opens a new PDO connection to the share database. Schema creation is a
 * separate step (ensure_share_schema) run during deployment/migration, so
 * live endpoints don't pay a DDL round-trip or acquire metadata locks on
 * every request.
 */
function get_db_connection(): PDO
{
    return new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ],
    );
}

/**
 * Opens a Redis connection if configured and available, returning null on failure or if unconfigured.
 */
function get_redis_connection(): ?object
{
    if (!defined('REDIS_HOST') || !class_exists('Redis')) {
        return null;
    }
    try {
        $redis = new Redis();
        $port = defined('REDIS_PORT') ? REDIS_PORT : 6379;
        if (@$redis->connect(REDIS_HOST, $port, 1.0)) {
            return $redis;
        }
    } catch (Throwable $e) {
        // Fall back gracefully to MySQL if Redis is down or unreachable.
    }
    return null;
}

/** Creates the shares table if it doesn't exist. Cheap no-op once present. */
function ensure_share_schema(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS comparebuilds_shares (
            id         VARCHAR(32) NOT NULL PRIMARY KEY,
            data       MEDIUMTEXT  NOT NULL,
            ip_hash    CHAR(64)    NULL,
            created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created (created_at),
            INDEX idx_ip_created (ip_hash, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS comparebuilds_og_requests (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            ip_hash    CHAR(64)  NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_ip_created (ip_hash, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
}

/** True if a PDOException is a MySQL duplicate-key (ER_DUP_ENTRY) violation. */
function is_duplicate_key_error(PDOException $e): bool
{
    return ($e->errorInfo[1] ?? null) === 1062;
}

/**
 * Stores a share payload and returns its content-addressed id. Identical content
 * deduplicates to the same id — idempotently, even against a concurrent write of
 * the same build from another IP. Enforces the per-IP rate limit and prunes
 * expired rows. Throws ShareException for client-visible failures.
 */
function store_share(PDO $pdo, array $payload, string $ipHash, ?object $redis = null): string
{
    // Serialize the rate-limit check and the insert per IP via an advisory lock
    // so a burst from one IP can't each read a below-limit count before any of
    // them inserts (a TOCTOU race that would let the per-IP cap be exceeded).
    $lockName = 'cb_share_' . substr($ipHash, 0, 48);
    $lockToken = bin2hex(random_bytes(16));
    $usedRedisLock = false;

    if ($redis !== null) {
        try {
            if (!$redis->set($lockName, $lockToken, ['nx', 'ex' => 5])) {
                throw new ShareException(503, 'Server busy — please try again', 5);
            }
            $usedRedisLock = true;
        } catch (ShareException $e) {
            throw $e;
        } catch (Throwable $e) {
            // Redis connection dropped/failed during set — fall back to MySQL lock.
            $redis = null;
        }
    }

    if (!$usedRedisLock) {
        $lk = $pdo->prepare('SELECT GET_LOCK(?, 1)');
        $lk->execute([$lockName]);
        if ((int) $lk->fetchColumn() !== 1) {
            throw new ShareException(503, 'Server busy — please try again', 5);
        }
    }

    $id = null;
    try {
        // ── Per-IP rate limit ────────────────────────────────────────────────
        $rateLimited = false;
        if ($redis !== null) {
            try {
                $rlKey = 'cb_rl_share_' . $ipHash;
                $current = $redis->get($rlKey);
                if ($current !== false && (int) $current >= RATE_LIMIT_MAX) {
                    $rateLimited = true;
                } else {
                    $count = $redis->incr($rlKey);
                    if ($count === 1) {
                        $redis->expire($rlKey, RATE_LIMIT_WINDOW);
                    }
                }
            } catch (Throwable $e) {
                // Fall back to MySQL rate limit check
                $redis = null;
            }
        }

        if ($rateLimited) {
            throw new ShareException(429, 'Too many shares created — please try again later', RATE_LIMIT_WINDOW);
        }

        if ($redis === null) {
            // Bound the window against the DB clock (NOW()), not a PHP timestamp, so a
            // timezone/DST skew can't shift it. The window is a trusted constant.
            $rl = $pdo->prepare(
                'SELECT COUNT(*) AS c FROM comparebuilds_shares '
                . 'WHERE ip_hash = ? AND created_at > NOW() - INTERVAL ' . RATE_LIMIT_WINDOW . ' SECOND'
            );
            $rl->execute([$ipHash]);
            if ((int) $rl->fetch()['c'] >= RATE_LIMIT_MAX) {
                throw new ShareException(429, 'Too many shares created — please try again later', RATE_LIMIT_WINDOW);
            }
        }

        // ── Content-addressing & deduplication ───────────────────────────────
        // The stored blob IS the canonical form, so the bytes we hash for the id,
        // the bytes we compare on collision, and the bytes we persist are one and
        // the same string — identical content always dedupes to the same id.
        $stored = canonicalize_payload($payload);
        $baseId = base62_encode_sha256($stored);

        $check  = $pdo->prepare('SELECT data FROM comparebuilds_shares WHERE id = ?');
        $insert = $pdo->prepare('INSERT INTO comparebuilds_shares (id, data, ip_hash) VALUES (?, ?, ?)');

        // Use the 8-char prefix of the hash; on a collision with *different*
        // content, lengthen the prefix (10, 12, … up to MAX_ID_LEN) and retry.
        $maxLen = min(strlen($baseId), MAX_ID_LEN);
        for ($len = ID_LEN; $len <= $maxLen; $len += 2) {
            $candidate = substr($baseId, 0, $len);
            $check->execute([$candidate]);
            $row = $check->fetch();

            if ($row) {
                if ($row['data'] === $stored) {
                    $id = $candidate; // identical content already stored
                    break;
                }
                continue; // different content at this prefix — lengthen
            }

            // Claim the id. The per-IP lock can't serialize a concurrent write of
            // the same content from a *different* IP (same content → same id), so
            // treat a duplicate-key violation as a dedup hit rather than a 500.
            try {
                $insert->execute([$candidate, $stored, $ipHash]);
                $id = $candidate;
                break;
            } catch (PDOException $e) {
                if (!is_duplicate_key_error($e)) {
                    throw $e;
                }
                $check->execute([$candidate]);
                $row = $check->fetch();
                if ($row && $row['data'] === $stored) {
                    $id = $candidate; // raced to the same content — dedup
                    break;
                }
                // Raced to *different* content — lengthen the prefix and retry.
            }
        }
    } finally {
        if ($usedRedisLock && $redis !== null) {
            try {
                $lua = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
                $redis->eval($lua, [$lockName, $lockToken], 1);
            } catch (Throwable $e) {
            }
        } else {
            $rel = $pdo->prepare('SELECT RELEASE_LOCK(?)');
            $rel->execute([$lockName]);
        }
    }

    if ($id === null) {
        // The id is a deterministic function of the content, so retrying the same
        // payload would hit the same exhausted prefix chain — a hard failure.
        throw new ShareException(500, 'Could not generate a unique share ID');
    }

    return $id;
}

/**
 * Retrieves the raw JSON data for a share ID, or null if not found.
 */
function get_share(PDO $pdo, string $id): ?string
{
    $stmt = $pdo->prepare('SELECT data FROM comparebuilds_shares WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? $row['data'] : null;
}

// When this file is included for unit testing (with SHARE_API_NO_MAIN defined),
// stop here: everything above is pure and testable, everything below opens a DB
// connection and handles the live request.
if (defined('SHARE_API_NO_MAIN')) {
    return;
}

// ─── DB connection ────────────────────────────────────────────────────────────
require_once __DIR__ . '/../../config.php';

try {
    $pdo = get_db_connection();
} catch (Throwable $e) {
    fail(500, 'Database unavailable');
}

// ─── Route ────────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ── GET ?id=xxxxxx ────────────────────────────────────────────────────────────
if ($method === 'GET') {
    $id = $_GET['id'] ?? '';
    $pageMode = isset($_GET['page']);

    if (!is_string($id) || !valid_share_id($id)) {
        if ($pageMode) {
            http_response_code(400);
            render_share_page('', null);
        }
        fail(400, 'Invalid ID format');
    }

    try {
        $data = get_share($pdo, $id);
    } catch (Throwable $e) {
        if ($pageMode) {
            http_response_code(500);
            render_share_page($id, null);
        }
        fail(500, 'Database error');
    }

    if (!$data) {
        if ($pageMode) {
            http_response_code(404);
            render_share_page($id, null);
        }
        fail(404, 'Share not found or has expired');
    }

    if ($pageMode) {
        render_share_page($id, json_decode($data, true) ?: null);
    }

    header('Cache-Control: public, max-age=86400');

    // Validated-on-write JSON blob, returned verbatim as application/json with
    // X-Content-Type-Options: nosniff — the browser won't render it as HTML, so
    // this is not an XSS sink (the /s/<id> page mode above escapes via
    // render_share_page; the SPA consumes this as data).
    echo $data; // nosemgrep: php.lang.security.injection.echoed-request.echoed-request
    exit;
}

// ── POST ──────────────────────────────────────────────────────────────────────
if ($method === 'POST') {
    // Reject cross-origin writes: no CORS headers are sent, so reads are blocked,
    // but a simple-request POST would otherwise create a share cross-origin.
    if (!is_same_origin_write(
        $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null,
        $_SERVER['HTTP_ORIGIN'] ?? null,
        $_SERVER['HTTP_REFERER'] ?? null,
    )) {
        fail(403, 'Cross-origin requests are not allowed');
    }

    $declaredLen = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($declaredLen > MAX_BODY_BYTES) {
        fail(413, 'Payload too large');
    }

    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'Payload too large');
    }

    try {
        $body = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    } catch (Throwable $e) {
        fail(400, 'Expected a valid JSON body');
    }
    $result = validate_share_input($body);
    if (isset($result['error'])) {
        fail(400, $result['error']);
    }
    $payload = $result['payload'];

    $ipHash = client_ip_hash();

    try {
        $id = store_share($pdo, $payload, $ipHash, get_redis_connection());
    } catch (ShareException $e) {
        // Client-visible failures carry their own status/message/Retry-After.
        if ($e->retryAfter !== null) {
            header('Retry-After: ' . $e->retryAfter);
        }
        fail($e->httpStatus, $e->getMessage());
    } catch (Throwable $e) {
        // Anything else (DB/driver errors) stays generic — never leak details.
        fail(500, 'Database error');
    }

    echo json_encode(['id' => $id]); // nosemgrep: php.lang.security.injection.echoed-request.echoed-request
    exit;
}

// ── Method not allowed ────────────────────────────────────────────────────────
fail(405, 'Method not allowed');
