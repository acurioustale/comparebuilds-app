<?php

declare(strict_types=1);

// ─── Open Graph card generator ─────────────────────────────────────────────────
// Renders a 1200×630 PNG for a shared build, so links unfurl with a branded card
// in Discord/Slack/etc. Driven by the stored share row (api/share.php). Stays
// within share.php's hardening posture: strict id validation, generic errors,
// prepared statement, no error leakage, cache headers.

ini_set('display_errors', '0');
error_reporting(E_ALL);
// A 1200×630 truecolor image needs a few MB; some shared hosts default to a tiny
// memory_limit. Nudge it up where allowed (no-op if disabled).
@ini_set('memory_limit', '256M');

// Canonical class id → [display name, hex colour]. Hardcoded so the card renders
// for every share (old ones included) without needing the class data on the server.
const CLASS_INFO = [
    1  => ['Warrior',      '#C69B6D'],
    2  => ['Paladin',      '#F48CBA'],
    3  => ['Hunter',       '#AAD372'],
    4  => ['Rogue',        '#FFF468'],
    5  => ['Priest',       '#FFFFFF'],
    6  => ['Death Knight', '#C41E3A'],
    7  => ['Shaman',       '#0070DD'],
    8  => ['Mage',         '#3FC7EB'],
    9  => ['Warlock',      '#8788EE'],
    10 => ['Monk',         '#00FF98'],
    11 => ['Druid',        '#FF7C0A'],
    12 => ['Demon Hunter', '#A330C9'],
    13 => ['Evoker',       '#33937F'],
];

const OG_RATE_LIMIT_MAX    = 60;    // max OG images generated per IP per window
const OG_RATE_LIMIT_WINDOW = 3600;  // window length in seconds (1 hour)
// The comparebuilds_og_requests rows this window counts are pruned after 24h by
// api/cron/prune_shares.php (REQUEST_LOG_PRUNE_WINDOW) — the single source for the
// retention. It must stay >= OG_RATE_LIMIT_WINDOW so the count never misses rows.

function bail(int $code): void
{
    http_response_code($code);
    exit;
}

/** Allocates a colour from "#RRGGBB". */
function hexcolor($img, string $hex)
{
    $hex = ltrim($hex, '#');
    if (strlen($hex) !== 6) {
        $hex = 'c8a84b';
    }
    return imagecolorallocate($img, (int) hexdec(substr($hex, 0, 2)), (int) hexdec(substr($hex, 2, 2)), (int) hexdec(substr($hex, 4, 2)));
}

/**
 * First usable bold TTF: a config override, then the fonts that ship on common
 * Linux hosts (DejaVu/Liberation), then macOS (local dev). null → no TTF.
 */
function find_font(): ?string
{
    $candidates = [];
    if (defined('OG_FONT_PATH')) {
        $candidates[] = OG_FONT_PATH;
    }
    // Bundled font (api/fonts/) — shipped so the card has crisp text even on hosts
    // with no system fonts installed.
    $candidates[] = __DIR__ . '/fonts/DejaVuSans-Bold.ttf';
    array_push(
        $candidates,
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
        '/Library/Fonts/Arial Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    );
    foreach ($candidates as $f) {
        if (is_string($f) && $f !== '' && is_file($f)) {
            return $f;
        }
    }
    return null;
}

/**
 * Draws text at a left x / baseline y, using the TTF if present, else a scaled
 * built-in font.
 *
 * The fallback only runs on the rare GD build that has neither FreeType nor a
 * usable TTF (the card normally ships its own bold TTF, so this path is almost
 * never taken). It scales the largest built-in glyph up via a temp tile. The tile
 * is filled with the card background colour (not transparency) because
 * imagecopyresized does not blend source alpha — a transparent tile would
 * composite as an opaque black box behind the text. Every caller draws onto the
 * flat $bg-coloured card area, so an opaque $bg tile is invisible at its edges.
 */
function draw_text($img, ?string $font, float $size, int $x, int $yBaseline, $color, string $text, string $bg = '#0d0d14'): void
{
    // Use TrueType only when the font exists AND this GD build has FreeType.
    if ($font !== null && function_exists('imagettftext')) {
        imagettftext($img, $size, 0, $x, $yBaseline, $color, $font, $text);
        return;
    }
    // Fallback: the largest built-in font, scaled up so it is at least legible.
    $scale = max(1, (int) round($size / 7));
    $w = imagefontwidth(5) * strlen($text) * $scale;
    $h = imagefontheight(5) * $scale;
    $tmp = imagecreatetruecolor(max(1, imagefontwidth(5) * strlen($text)), imagefontheight(5));
    imagefilledrectangle($tmp, 0, 0, imagesx($tmp), imagesy($tmp), hexcolor($tmp, $bg));
    $rgb = imagecolorsforindex($img, $color);
    $c2 = imagecolorallocate($tmp, $rgb['red'], $rgb['green'], $rgb['blue']);
    imagestring($tmp, 5, 0, 0, $text, $c2);
    imagecopyresized($img, $tmp, $x, $yBaseline - $h, 0, 0, $w, $h, imagesx($tmp), imagesy($tmp));
    imagedestroy($tmp);
}

// When this file is included for unit testing (with OG_API_NO_MAIN defined), stop
// here: everything above is pure (font discovery, hex parsing) and testable;
// everything below reads the request, opens a DB connection, and emits an image.
if (defined('OG_API_NO_MAIN')) {
    return;
}

// ── Look up the share ───────────────────────────────────────────────────────────
// Pull in share.php (helpers only — request handling is guarded off) so id
// validation and DB access share one implementation. valid_share_id is the
// single source of truth for the id format (mirrored to route.js; pinned by
// shareIdParity.test.js).
require_once __DIR__ . '/../../config.php';
define('SHARE_API_NO_MAIN', true);
require_once __DIR__ . '/share.php';

$id = $_GET['id'] ?? '';
if (!is_string($id) || !valid_share_id($id)) {
    bail(400);
}

// Pick an output encoder the host's GD actually supports. Some shared builds ship
// GD without PNG, so fall back through the other formats. Order is by how widely
// link-preview crawlers accept them: PNG/JPEG/GIF unfurl everywhere (Facebook,
// LinkedIn, Slack, …); WebP is a last resort (spottier support). The card is flat
// colour + text, so GIF's 256-colour palette looks effectively identical.
if (function_exists('imagepng')) {
    $mime = 'image/png';
    $ext  = 'png';
    $emit = static fn ($im, ?string $path = null) => $path !== null ? imagepng($im, $path) : imagepng($im);
} elseif (function_exists('imagejpeg')) {
    $mime = 'image/jpeg';
    $ext  = 'jpg';
    $emit = static fn ($im, ?string $path = null) => $path !== null ? imagejpeg($im, $path, 90) : imagejpeg($im, null, 90);
} elseif (function_exists('imagegif')) {
    $mime = 'image/gif';
    $ext  = 'gif';
    $emit = static fn ($im, ?string $path = null) => $path !== null ? imagegif($im, $path) : imagegif($im);
} elseif (function_exists('imagewebp')) {
    $mime = 'image/webp';
    $ext  = 'webp';
    $emit = static fn ($im, ?string $path = null) => $path !== null ? imagewebp($im, $path) : imagewebp($im);
} else {
    bail(500);
}

// ── Check cache ─────────────────────────────────────────────────────────────────
// Serve cached OpenGraph image if it was already generated, bypassing database
// queries, rate-limiting locks, and heavy GD compression.
//
// The cache lives one level ABOVE the web root (alongside config.php, `../../`
// from this api/ file), NOT inside it. Two reasons: deploy.sh mirrors the web
// root with `rsync --delete` and never stages cache_og, so an in-root cache
// would be wiped on every deploy; and prune_shares.php resolves the same
// `../../../cache_og` from api/cron/, so an in-root path here (`../cache_og`)
// meant the daily prune cleaned a directory this file never wrote to.
$cacheDir = __DIR__ . '/../../cache_og';
// Use basename() to explicitly clear static analysis taint tracking (valid_share_id already enforces alnum).
// nosemgrep: php.lang.security.injection.tainted-filename.tainted-filename
$cacheFile = $cacheDir . '/' . basename($id) . '.' . $ext;
// filemtime() returns false if the file is unlinked between the is_file() check
// and here (a concurrent prune/rename race). Treat that as a cache miss and fall
// through to regenerate, rather than emitting a bogus ETag (md5 of "false") and a
// 1970 Last-Modified over a since-deleted file.
$mtime = is_file($cacheFile) ? filemtime($cacheFile) : false;
if ($mtime !== false) {
    $etag = '"' . md5($id . $mtime) . '"';

    header("Content-Type: $mime");
    header('Cache-Control: public, max-age=31536000, immutable');
    header('X-Content-Type-Options: nosniff');
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
    header('ETag: ' . $etag);

    if (
        (isset($_SERVER['HTTP_IF_NONE_MATCH']) && trim($_SERVER['HTTP_IF_NONE_MATCH']) === $etag) ||
        (isset($_SERVER['HTTP_IF_MODIFIED_SINCE']) && @strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE']) >= $mtime)
    ) {
        http_response_code(304);
        exit;
    }

    // nosemgrep: php.lang.security.injection.tainted-filename.tainted-filename
    readfile($cacheFile);
    exit;
}

// Number of concurrent OG image renders allowed across all IPs at any one time.
// This caps total GD/CPU resource use regardless of how many distinct IPs are
// requesting simultaneously. Adjust via config.php (OG_CONCURRENCY_SLOTS) if needed.
const OG_CONCURRENCY_SLOTS = 4;
// TTL (seconds) for the advisory locks below on the Redis path. Both the global
// slot and the per-IP lock are held across the GD render at the bottom of this
// file, so this must exceed the worst-case render time — a Redis lock auto-expires
// after its TTL, and too short a value would let a second request seize a slot
// that is still mid-render (the MySQL GET_LOCK path is connection-scoped instead).
const OG_LOCK_TTL = 30;

try {
    $pdo = get_db_connection();
    $redis = get_redis_connection();

    // ── Global concurrency guard ─────────────────────────────────────────────
    // GD true-color image generation is CPU-intensive. Without this, a flood of
    // requests from many different IPs (each below their per-IP rate limit) could
    // exhaust all PHP-FPM workers. We try to acquire one of OG_CONCURRENCY_SLOTS
    // advisory locks (cb_og_global_0 … cb_og_global_N); if none is free we return
    // 503 immediately rather than queuing.
    //
    // Both this slot and the per-IP lock are held all the way through the render
    // at the bottom of the file — that render is the expensive work the slot
    // exists to bound, so releasing before it (as the old finally did) left it
    // unbounded. bail() calls exit(), which skips finally, so the only release
    // that runs on every path (503/429/404/500, a GD fatal, or normal completion)
    // is this shutdown handler. It reads the lock names by reference, releasing
    // whatever was actually acquired and no-oping for names still null (e.g. an
    // early throw from client_ip_hash() before the per-IP lock is taken — the
    // gap that previously stranded the global slot on the persistent connection).
    $globalLockName = null;
    $globalLockToken = bin2hex(random_bytes(16));
    $lockName = null;
    $lockToken = bin2hex(random_bytes(16));
    register_shutdown_function(static function () use ($pdo, &$redis, &$globalLockName, $globalLockToken, &$lockName, $lockToken) {
        if ($lockName !== null) {
            RateLimiter::releaseLock($pdo, $redis, $lockName, $lockToken);
        }
        if ($globalLockName !== null) {
            RateLimiter::releaseLock($pdo, $redis, $globalLockName, $globalLockToken);
        }
    });

    for ($slot = 0; $slot < OG_CONCURRENCY_SLOTS; $slot++) {
        $candidate = 'cb_og_global_' . $slot;
        if (RateLimiter::acquireLock($pdo, $redis, $candidate, $globalLockToken, OG_LOCK_TTL)) {
            $globalLockName = $candidate;
            break;
        }
    }
    if ($globalLockName === null) {
        header('Retry-After: 5');
        bail(503);
    }

    // ── Concurrency throttling & rate limiting ──────────────────────────────
    $ipHash = client_ip_hash();
    $ipLockName = 'cb_og_' . substr($ipHash, 0, 48);

    // Only record $lockName once the lock is actually held, so the shutdown handler
    // never tries to release a per-IP lock this request didn't acquire.
    if (!RateLimiter::acquireLock($pdo, $redis, $ipLockName, $lockToken, OG_LOCK_TTL)) {
        header('Retry-After: 5');
        bail(503);
    }
    $lockName = $ipLockName;

    // Resolved only on the non-throttled path; the rate-limited path bails before
    // ever reading it.
    $data = null;
    $rateLimited = false;
    // NOTE: the Redis and MySQL rate limiters are independent counters, not a
    // write-through cache. When Redis answers (checkRedis returns non-null) the
    // request is counted ONLY in Redis and is NOT written to
    // comparebuilds_og_requests below — that INSERT lives in the `$redis === null`
    // fallback branch. So if Redis is restarted or the key is evicted early, the
    // window resets to zero (the MySQL table holds no Redis-path history to fall
    // back on). This is an accepted trade-off: the OG endpoint is cache-fronted
    // and idempotent, so a rare window reset only permits a brief burst of image
    // regenerations, never a data-integrity problem.
    $currentCountRedis = RateLimiter::checkRedis($redis, 'cb_rl_og_' . $ipHash, OG_RATE_LIMIT_MAX, OG_RATE_LIMIT_WINDOW, false);

    if ($currentCountRedis !== null) {
        if ($currentCountRedis - 1 >= OG_RATE_LIMIT_MAX) {
            $rateLimited = true;
        }
    } elseif ($redis === null) {
        $count = 0;
        try {
            $rl = $pdo->prepare(
                'SELECT COUNT(*) AS c FROM comparebuilds_og_requests '
                . 'WHERE ip_hash = ? AND created_at > NOW() - INTERVAL ' . OG_RATE_LIMIT_WINDOW . ' SECOND'
            );
            $rl->execute([$ipHash]);
            $count = (int) $rl->fetch()['c'];
        } catch (PDOException $e) {
            // A missing table reads as a zero count, silently disabling the
            // OG rate limit. Surface the failure so schema drift or a failed
            // migration is visible instead of quietly lifting the cap.
            error_log('Failed to read OG rate-limit count: ' . $e->getMessage());
        }
        if ($count >= OG_RATE_LIMIT_MAX) {
            $rateLimited = true;
        }

        if ($count <= OG_RATE_LIMIT_MAX * 2) {
            // Count every valid-id request, whether or not the share exists, so a
            // flood of nonexistent ids is still bounded — matching the Redis path,
            // which increments its counter before the share lookup. Logging
            // continues past the cap (up to 2x) so the window keeps reflecting an
            // ongoing flood rather than freezing at the limit.
            try {
                $logReq = $pdo->prepare('INSERT INTO comparebuilds_og_requests (ip_hash) VALUES (?)');
                $logReq->execute([$ipHash]);
            } catch (PDOException $e) {
                // Losing this row under-counts the window and weakens the
                // rate limit; surface the failure so schema drift or a failed
                // migration is visible instead of silently relaxing the cap.
                error_log('Failed to log OG request: ' . $e->getMessage());
            }
        } else {
            // Already at the per-IP row cap (2x the limit) and still hammering.
            // Inserting another row would grow the table unbounded, but dropping
            // the request outright lets the sliding window drain: as the oldest
            // rows age out the count falls back under the cap and the abuser
            // regains capacity while still hammering. Instead slide this IP's
            // oldest logged request forward to now — the row count stays bounded
            // while the recovery horizon is pushed out for as long as the abuse
            // continues, mirroring share.php's over-limit penalty (see #270).
            try {
                $slide = $pdo->prepare(
                    'UPDATE comparebuilds_og_requests SET created_at = NOW() '
                    . 'WHERE ip_hash = ? ORDER BY created_at ASC LIMIT 1'
                );
                $slide->execute([$ipHash]);
            } catch (PDOException $e) {
                error_log('Failed to slide OG request window: ' . $e->getMessage());
            }
        }
    }

    // Skip the (relatively costly) share lookup when throttled.
    if (!$rateLimited) {
        $data = get_share($pdo, $id);
    }

    // The shutdown handler frees both locks on exit, so bail() here is safe.
    if ($rateLimited) {
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $xff = preg_replace('/[\r\n]+/', ' ', $_SERVER['HTTP_X_FORWARDED_FOR']);
            error_log('Rate limit hit for IP Hash ' . $ipHash . ' | X-Forwarded-For: ' . $xff);
        }
        header('Retry-After: ' . OG_RATE_LIMIT_WINDOW);
        bail(429);
    }
} catch (Throwable $e) {
    bail(500);
}
if (!$data) {
    bail(404);
}

$data      = json_decode($data, true) ?: [];
$classId   = (int) ($data['classId'] ?? 0);
$builds    = is_array($data['builds'] ?? null) ? $data['builds'] : [];
$className  = is_string($data['className'] ?? null) && $data['className'] !== ''
    ? $data['className'] : (CLASS_INFO[$classId][0] ?? 'World of Warcraft');
$specName  = is_string($data['specName'] ?? null) ? $data['specName'] : '';
$color     = CLASS_INFO[$classId][1] ?? '#c8a84b';

// ── Render ──────────────────────────────────────────────────────────────────────
if (!function_exists('imagecreatetruecolor')) {
    bail(500);
}

$limit = ini_get('memory_limit');
if ($limit !== false && $limit !== '' && $limit !== '-1') {
    // Parse as float, not int: on a 32-bit PHP build an int caps near 2.1e9, so a
    // "2G"+ limit would overflow when scaled to bytes below (wrapping negative and
    // tripping the "insufficient memory" guard on a host that has plenty). Floats
    // represent these byte counts exactly well past any real memory_limit.
    $val = (float) $limit;
    $last = strtolower(substr(trim($limit), -1));
    if ($last === 'g') {
        $val *= 1024 * 1024 * 1024;
    } elseif ($last === 'm') {
        $val *= 1024 * 1024;
    } elseif ($last === 'k') {
        $val *= 1024;
    }

    // We want at least 8MB of headroom for the GD buffer and overhead.
    $required = 8 * 1024 * 1024;
    if ($val > 0 && ($val - memory_get_usage()) < $required) {
        error_log('Insufficient memory to render OG image (limit: ' . $limit . ')');
        bail(500);
    }
}

$W = 1200;
$H = 630;
$img = @imagecreatetruecolor($W, $H);
if ($img === false) {
    bail(500);
}

try {
    imagefilledrectangle($img, 0, 0, $W, $H, hexcolor($img, '#0d0d14'));

    $accent = hexcolor($img, $color);
    $gold   = hexcolor($img, '#c8a84b');
    $muted  = hexcolor($img, '#9a8a6a');
    $white  = hexcolor($img, '#f0e6c8');

    // Top accent bar + left rule in the class colour.
    imagefilledrectangle($img, 0, 0, $W, 12, $accent);
    imagefilledrectangle($img, 90, 150, 96, 470, $accent);

    $font = find_font();
    $x = 130;

    draw_text($img, $font, 22, $x, 150, $gold, 'COMPAREBUILDS.APP');
    $title = trim("$specName $className");
    draw_text($img, $font, 64, $x, 320, $accent, $title !== '' ? $title : 'Talent Build');
    $subtitle = count($builds) >= 2 ? (count($builds) . ' builds compared') : 'WoW talent build';
    draw_text($img, $font, 30, $x, 380, $white, $subtitle);
    draw_text($img, $font, 22, $x, 470, $muted, 'Import, build and compare WoW talent loadouts');
} catch (Throwable $e) {
    // Any drawing failure: still return a valid (if plainer) PNG rather than a 500,
    // so the link at least unfurls with the class-coloured background.
}

header("Content-Type: $mime");
header('Cache-Control: public, max-age=31536000, immutable');
header('X-Content-Type-Options: nosniff');

$emit($img);
if (function_exists('fastcgi_finish_request')) {
    fastcgi_finish_request();
}

if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0755, true);
}
if (is_dir($cacheDir)) {
    // Write atomically: encode into a unique temp file in the same directory,
    // then rename() into place. rename is atomic on one filesystem, so a reader
    // (and crawlers caching for a day) only ever sees a fully written file —
    // never a truncated image from an interrupted encode, a full disk, or two
    // IPs racing to generate the same uncached id. Best-effort: any failure
    // unlinks the temp file, leaves no partial file at the real path, and never
    // breaks image serving (the error suppression is preserved for that reason).
    // nosemgrep: php.lang.security.injection.tainted-filename.tainted-filename
    $tmpFile = @tempnam($cacheDir, 'og_');
    if ($tmpFile !== false) {
        // tempnam ignores the extension, but the read path only ever serves
        // $cacheFile, so the temp file's own name is irrelevant.
        // nosemgrep: php.lang.security.injection.tainted-filename.tainted-filename
        if (@$emit($img, $tmpFile) && @rename($tmpFile, $cacheFile)) {
            @chmod($cacheFile, 0644);
        } else {
            @unlink($tmpFile);
        }
    }
}
imagedestroy($img);
