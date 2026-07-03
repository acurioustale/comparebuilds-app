<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

// Load the OG image endpoint's pure helpers (font discovery + hex parsing)
// without running the request handler. The OG_API_NO_MAIN guard in og.php returns
// before reading the request, opening a DB connection, or emitting an image, so
// no config.php, database, or GET parameter is needed.
define('OG_API_NO_MAIN', true);
require_once __DIR__ . '/../api/og.php';

/**
 * Covers og.php's pure helpers — the parts most likely to silently regress
 * (a missing bundled font, or a hex-colour parse going wrong on the share card).
 */
final class OgRenderTest extends TestCase
{
    public function testFindFontReturnsBundledFont(): void
    {
        $font = find_font();
        $this->assertNotNull($font, 'a bundled bold TTF should always be found');
        $this->assertSame('DejaVuSans-Bold.ttf', basename($font));
        $this->assertFileExists($font);
    }

    public function testHexcolorParsesValidHex(): void
    {
        if (!function_exists('imagecreatetruecolor')) {
            $this->markTestSkipped('GD not available');
        }
        $img = imagecreatetruecolor(1, 1);
        $rgb = imagecolorsforindex($img, hexcolor($img, '#ff8000'));
        $this->assertSame(255, $rgb['red']);
        $this->assertSame(128, $rgb['green']);
        $this->assertSame(0, $rgb['blue']);
    }

    public function testHexcolorFallsBackOnMalformedHex(): void
    {
        if (!function_exists('imagecreatetruecolor')) {
            $this->markTestSkipped('GD not available');
        }
        $img = imagecreatetruecolor(1, 1);
        // Not six hex digits → falls back to the gold accent #c8a84b.
        $rgb = imagecolorsforindex($img, hexcolor($img, 'nope'));
        $this->assertSame(0xC8, $rgb['red']);
        $this->assertSame(0xA8, $rgb['green']);
        $this->assertSame(0x4B, $rgb['blue']);
    }

    public function testSanitizeRenderTextStripsBidiAndControlCodepoints(): void
    {
        // A right-to-left override (U+202E) would reverse the rendered card text;
        // control bytes and zero-width joiners garble or spoof it. All are removed.
        $this->assertSame('Blood', sanitize_render_text("\u{202E}Blood"));
        $this->assertSame('Death Knight', sanitize_render_text("Death\u{200D} Knight\u{0007}"));
        $this->assertSame('Fire', sanitize_render_text("Fire\u{200B}"));
    }

    public function testSanitizeRenderTextKeepsOrdinaryAndNonLatinText(): void
    {
        // Ordinary letters, punctuation, and non-Latin scripts must survive.
        $this->assertSame('Beast Mastery', sanitize_render_text('Beast Mastery'));
        $this->assertSame('闇の騎士', sanitize_render_text('闇の騎士'));
    }

    public function testSanitizeRenderTextCollapsesToEmptyWhenAllStripped(): void
    {
        // A value that was only format/control chars becomes empty, so the render
        // path falls back to the trusted class name instead of a lone override.
        $this->assertSame('', sanitize_render_text("\u{202E}\u{200B}\u{0007}"));
    }
}
