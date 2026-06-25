<?php
declare(strict_types=1);

// ─── Open Graph card generator ─────────────────────────────────────────────────
// Renders a 1200×630 PNG for a shared build, so links unfurl with a branded card
// in Discord/Slack/etc. Driven by the stored share row (api/share.php). Stays
// within share.php's hardening posture: strict id validation, generic errors,
// prepared statement, no error leakage, cache headers.

ini_set('display_errors', '0');
error_reporting(E_ALL);

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

function bail(int $code): void { http_response_code($code); exit; }

/** Allocates a colour from "#RRGGBB". */
function hexcolor($img, string $hex) {
    $hex = ltrim($hex, '#');
    if (strlen($hex) !== 6) $hex = 'c8a84b';
    return imagecolorallocate($img, (int) hexdec(substr($hex, 0, 2)), (int) hexdec(substr($hex, 2, 2)), (int) hexdec(substr($hex, 4, 2)));
}

/**
 * First usable bold TTF: a config override, then the fonts that ship on common
 * Linux hosts (DejaVu/Liberation), then macOS (local dev). null → no TTF.
 */
function find_font(): ?string {
    $candidates = [];
    if (defined('OG_FONT_PATH')) $candidates[] = OG_FONT_PATH;
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
        if (is_string($f) && $f !== '' && is_file($f)) return $f;
    }
    return null;
}

/** Draws text at a left x / baseline y, using the TTF if present, else a scaled built-in font. */
function draw_text($img, ?string $font, float $size, int $x, int $yBaseline, $color, string $text): void {
    if ($font !== null) {
        imagettftext($img, $size, 0, $x, $yBaseline, $color, $font, $text);
        return;
    }
    // Fallback: the largest built-in font, scaled up so it is at least legible.
    $scale = max(1, (int) round($size / 7));
    $w = imagefontwidth(5) * strlen($text) * $scale;
    $h = imagefontheight(5) * $scale;
    $tmp = imagecreatetruecolor(max(1, imagefontwidth(5) * strlen($text)), imagefontheight(5));
    imagealphablending($tmp, false);
    imagefilledrectangle($tmp, 0, 0, imagesx($tmp), imagesy($tmp), imagecolorallocatealpha($tmp, 0, 0, 0, 127));
    $rgb = imagecolorsforindex($img, $color);
    $c2 = imagecolorallocate($tmp, $rgb['red'], $rgb['green'], $rgb['blue']);
    imagestring($tmp, 5, 0, 0, $text, $c2);
    imagecopyresized($img, $tmp, $x, $yBaseline - $h, 0, 0, $w, $h, imagesx($tmp), imagesy($tmp));
    imagedestroy($tmp);
}

// ── Validate id ────────────────────────────────────────────────────────────────
$id = $_GET['id'] ?? '';
if (!is_string($id) || !preg_match('/^[A-Za-z0-9]{6}$/', $id)) bail(400);

// ── Look up the share ───────────────────────────────────────────────────────────
require_once __DIR__ . '/../../config.php';
try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false],
    );
    $stmt = $pdo->prepare('SELECT data FROM comparebuilds_shares WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch();
} catch (Throwable $e) {
    bail(500);
}
if (!$row) bail(404);

$data      = json_decode($row['data'], true) ?: [];
$classId   = (int) ($data['classId'] ?? 0);
$builds    = is_array($data['builds'] ?? null) ? $data['builds'] : [];
$className  = is_string($data['className'] ?? null) && $data['className'] !== ''
    ? $data['className'] : (CLASS_INFO[$classId][0] ?? 'World of Warcraft');
$specName  = is_string($data['specName'] ?? null) ? $data['specName'] : '';
$color     = CLASS_INFO[$classId][1] ?? '#c8a84b';

// ── Render ──────────────────────────────────────────────────────────────────────
$W = 1200; $H = 630;
$img = imagecreatetruecolor($W, $H);
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

draw_text($img, $font, 22, $x, 150, $gold,  'COMPAREBUILDS.APP');
$title = trim("$specName $className");
draw_text($img, $font, 64, $x, 320, $accent, $title !== '' ? $title : 'Talent Build');
$subtitle = count($builds) >= 2 ? (count($builds) . ' builds compared') : 'WoW talent build';
draw_text($img, $font, 30, $x, 380, $white, $subtitle);
draw_text($img, $font, 22, $x, 470, $muted, 'Import, build and compare WoW talent loadouts');

header('Content-Type: image/png');
header('Cache-Control: public, max-age=86400');
header('X-Content-Type-Options: nosniff');
imagepng($img);
imagedestroy($img);
