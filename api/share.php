<?php
declare(strict_types=1);

// ─── Runtime hardening ─────────────────────────────────────────────────────────
// Never leak PHP errors/stack traces to clients; log them server-side instead.
ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store');
// No CORS headers are sent on purpose: the browser will block cross-origin reads
// and writes, so only the site itself (same origin) can use this API.

// ─── Limits / config ───────────────────────────────────────────────────────────
// MAX_BUILDS / MAX_BUILD_LEN are mirrored client-side in src/store/buildsStore.js.
// This file is the authority (the client only validates early for nicer errors);
// keep the two in sync if either limit changes.
const MAX_BODY_BYTES    = 16384; // raw POST body cap (5 builds * 2000 + overhead)
const MAX_BUILD_LEN     = 2000;
const MIN_BUILDS        = 2;
const MAX_BUILDS        = 5;
const RATE_LIMIT_MAX    = 20;    // max shares one IP may create per window
const RATE_LIMIT_WINDOW = 3600;  // window length in seconds (1 hour)
const SHARE_TTL_DAYS    = 90;    // rows older than this are pruned
const ID_LEN            = 6;
const ID_ALPHABET       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// Build strings are base64 (RFC 4648 alphabet, optional padding).
const BUILD_PATTERN     = '/^[A-Za-z0-9+\/]{1,2000}={0,2}$/';

/** Emit a JSON error and stop. */
function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

/**
 * The client IP used for rate limiting.
 *
 * Direct hosting: REMOTE_ADDR is the real client. Behind a reverse proxy or CDN
 * (Cloudflare, etc.) REMOTE_ADDR is the proxy, collapsing every visitor into one
 * rate-limit bucket — so the real client is the first hop in X-Forwarded-For.
 * That header is client-spoofable, so it is ONLY trusted when the operator opts
 * in by defining TRUST_PROXY truthy in config.php (i.e. you know a trusted proxy
 * always sets it). Defaults to REMOTE_ADDR.
 */
function client_ip(): string {
    if (defined('TRUST_PROXY') && TRUST_PROXY && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $first = trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
        if (filter_var($first, FILTER_VALIDATE_IP) !== false) {
            return $first;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '';
}

/** Salted hash of the client IP, used only for rate limiting (not reversible to an IP in practice). */
function client_ip_hash(): string {
    $salt = defined('SHARE_IP_SALT') ? SHARE_IP_SALT : 'comparebuilds-default-salt';
    return hash('sha256', $salt . '|' . client_ip());
}

// ─── DB connection ────────────────────────────────────────────────────────────
// config.php lives one level above the web root so it is never publicly
// accessible. Adjust the path if your host's directory layout differs.
require_once __DIR__ . '/../../config.php';

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ],
    );

    // Create table on first run — cheap no-op afterwards.
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS comparebuilds_shares (
            id         CHAR(6)    NOT NULL PRIMARY KEY,
            data       MEDIUMTEXT NOT NULL,
            ip_hash    CHAR(64)   NULL,
            created_at TIMESTAMP  NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_created (created_at),
            INDEX idx_ip_created (ip_hash, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    ");
} catch (Throwable $e) {
    fail(500, 'Database unavailable');
}

// ─── Route ────────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ── GET ?id=xxxxxx ────────────────────────────────────────────────────────────
// Read-only. The 56-billion-value ID space makes enumeration impractical, so GET
// is not rate limited here (rely on the host/CDN for raw request flooding).
if ($method === 'GET') {
    $id = $_GET['id'] ?? '';

    if (!is_string($id) || !preg_match('/^[A-Za-z0-9]{6}$/', $id)) {
        fail(400, 'Invalid ID format');
    }

    try {
        $stmt = $pdo->prepare('SELECT data FROM comparebuilds_shares WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
    } catch (Throwable $e) {
        fail(500, 'Database error');
    }

    if (!$row) {
        fail(404, 'Share not found or has expired');
    }

    // Share payloads are immutable once written, so let browsers/CDNs cache the
    // hit (overrides the global no-store, which only matters for POST). Capped at
    // a day so a since-pruned link recovers to a 404 reasonably soon.
    header('Cache-Control: public, max-age=86400');

    // Stored blob was validated on write — return it verbatim.
    echo $row['data'];
    exit;
}

// ── POST ──────────────────────────────────────────────────────────────────────
if ($method === 'POST') {
    // Reject oversized bodies before reading them into memory.
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
    if (!is_array($body)) {
        fail(400, 'Expected a JSON object');
    }

    // ── Field validation ─────────────────────────────────────────────────────
    $classId = $body['classId'] ?? null;
    $specId  = $body['specId']  ?? null;
    $builds  = $body['builds']  ?? null;

    if (!is_int($classId) || $classId <= 0 || $classId > 1000000 ||
        !is_int($specId)  || $specId  <= 0 || $specId  > 1000000) {
        fail(400, 'classId and specId must be positive integers');
    }
    if (!is_array($builds)) {
        fail(400, 'builds must be a JSON array');
    }
    if (count($builds) < MIN_BUILDS || count($builds) > MAX_BUILDS) {
        fail(400, 'builds must contain ' . MIN_BUILDS . '–' . MAX_BUILDS . ' entries');
    }
    foreach ($builds as $b) {
        if (!is_string($b) || !preg_match(BUILD_PATTERN, $b)) {
            fail(400, 'Each build must be a base64 build string ≤ ' . MAX_BUILD_LEN . ' chars');
        }
    }

    $ipHash = client_ip_hash();

    // ── Per-IP rate limit ────────────────────────────────────────────────────
    try {
        $cutoff = date('Y-m-d H:i:s', time() - RATE_LIMIT_WINDOW);
        $rl = $pdo->prepare(
            'SELECT COUNT(*) AS c FROM comparebuilds_shares WHERE ip_hash = ? AND created_at > ?'
        );
        $rl->execute([$ipHash, $cutoff]);
        if ((int) $rl->fetch()['c'] >= RATE_LIMIT_MAX) {
            header('Retry-After: ' . RATE_LIMIT_WINDOW);
            fail(429, 'Too many shares created — please try again later');
        }
    } catch (Throwable $e) {
        fail(500, 'Database error');
    }

    // ── Prune expired rows (best-effort) ─────────────────────────────────────
    try {
        $prune = $pdo->prepare('DELETE FROM comparebuilds_shares WHERE created_at < ?');
        $prune->execute([date('Y-m-d H:i:s', time() - SHARE_TTL_DAYS * 86400)]);
    } catch (Throwable $e) {
        // Non-fatal — proceed even if cleanup fails.
    }

    // ── Generate a unique ID and insert ──────────────────────────────────────
    $stored = json_encode(
        ['classId' => $classId, 'specId' => $specId, 'builds' => $builds],
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES,
    );

    try {
        $check = $pdo->prepare('SELECT 1 FROM comparebuilds_shares WHERE id = ?');
        $insert = $pdo->prepare('INSERT INTO comparebuilds_shares (id, data, ip_hash) VALUES (?, ?, ?)');
        $max = strlen(ID_ALPHABET) - 1;
        $id = null;

        for ($attempt = 0; $attempt < 10; $attempt++) {
            $candidate = '';
            for ($j = 0; $j < ID_LEN; $j++) {
                $candidate .= ID_ALPHABET[random_int(0, $max)];
            }
            $check->execute([$candidate]);
            if (!$check->fetch()) {
                $insert->execute([$candidate, $stored, $ipHash]);
                $id = $candidate;
                break;
            }
        }
    } catch (Throwable $e) {
        fail(500, 'Database error');
    }

    if ($id === null) {
        fail(500, 'Could not generate a unique share ID — please retry');
    }

    echo json_encode(['id' => $id]);
    exit;
}

// ── Method not allowed ────────────────────────────────────────────────────────
fail(405, 'Method not allowed');
