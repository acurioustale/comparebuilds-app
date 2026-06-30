<?php

declare(strict_types=1);

use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use PHPUnit\Framework\TestCase;

/**
 * Covers the share API's public-input validation surface — the security-relevant
 * logic a malicious or buggy client can reach. The helpers are pure (no DB, no
 * output), loaded via tests/bootstrap.php with the request handler guarded off.
 */
final class ShareValidationTest extends TestCase
{
    public function testValidShareIdAcceptsEightToSixteenAlnum(): void
    {
        $this->assertTrue(valid_share_id('abc123xyz'));
        $this->assertTrue(valid_share_id('ABCxyz123456'));
    }

    public function testValidShareIdRejectsMalformed(): void
    {
        $this->assertFalse(valid_share_id('abc1234')); // too short (7)
        $this->assertFalse(valid_share_id('abc12345678901234')); // too long (17)
        $this->assertFalse(valid_share_id('abc-12345'));  // illegal char
        $this->assertFalse(valid_share_id(''));        // empty
    }

    public function testValidInputReturnsNormalisedPayload(): void
    {
        $result = validate_share_input([
            'classId' => 6,
            'specId' => 250,
            'builds' => ['AAAA', 'BBBB'],
        ]);
        $this->assertArrayNotHasKey('error', $result);
        $this->assertSame(6, $result['payload']['classId']);
        $this->assertSame(['AAAA', 'BBBB'], $result['payload']['builds']);
        $this->assertArrayNotHasKey('labels', $result['payload']);
    }

    public function testRejectsNonArrayBody(): void
    {
        $this->assertSame('Expected a JSON object', validate_share_input('nope')['error']);
    }

    public function testRejectsBadClassOrSpecId(): void
    {
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 0, 'specId' => 1, 'builds' => ['AA', 'BB']]));
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 'x', 'builds' => ['AA', 'BB']]));
    }

    public function testEnforcesBuildCount(): void
    {
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA']]));
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['A', 'B', 'C', 'D', 'E', 'F']]));
    }

    public function testRejectsInvalidBuildString(): void
    {
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', '!!!']]));
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', str_repeat('A', 2001)]]));
        // 2000 data chars + 2 padding chars matches BUILD_PATTERN but exceeds the
        // 2000-char total cap, so the length check must reject it.
        $this->assertArrayHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', str_repeat('A', 2000) . '==']]));
        // Exactly at the cap is accepted.
        $this->assertArrayNotHasKey('error', validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', str_repeat('A', 2000)]]));
    }

    public function testLabelsMustParallelBuilds(): void
    {
        $r = validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB'], 'labels' => ['only one']]);
        $this->assertArrayHasKey('error', $r);
    }

    public function testRejectsOverlongLabel(): void
    {
        $r = validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB'], 'labels' => ['ok', str_repeat('x', 41)]]);
        $this->assertArrayHasKey('error', $r);
    }

    public function testDropsAllEmptyLabels(): void
    {
        $r = validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB'], 'labels' => ['', '']]);
        $this->assertArrayNotHasKey('error', $r);
        $this->assertArrayNotHasKey('labels', $r['payload']);
    }

    public function testKeepsNonEmptyLabelsAndNames(): void
    {
        $r = validate_share_input([
            'classId' => 1,
            'specId' => 1,
            'builds' => ['AA', 'BB'],
            'labels' => ['ST', ''],
            'className' => 'Mage',
            'specName' => 'Frost',
        ]);
        $this->assertSame(['ST', ''], $r['payload']['labels']);
        $this->assertSame('Mage', $r['payload']['className']);
        $this->assertSame('Frost', $r['payload']['specName']);
    }

    public function testRejectsOverlongName(): void
    {
        $r = validate_share_input(['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB'], 'className' => str_repeat('x', 65)]);
        $this->assertArrayHasKey('error', $r);
    }

    public function testClientIpFallsBackToRemoteAddr(): void
    {
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        unset($_SERVER['HTTP_X_FORWARDED_FOR']);
        $this->assertSame('203.0.113.7', client_ip());
    }

    public function testClientIpIgnoresForwardedHeaderWhenProxyUntrusted(): void
    {
        // TRUST_PROXY is undefined under test, so X-Forwarded-For must be ignored.
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.1';
        $this->assertSame('203.0.113.7', client_ip());
    }

    // Runs in a separate process: TRUST_PROXY is a constant, so defining it here
    // would otherwise leak into every other client_ip test in this process.
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpUsesLastForwardedHopWhenProxyTrusted(): void
    {
        define('TRUST_PROXY', true);
        define('TRUSTED_PROXIES', ['203.0.113.7']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        // An attacker prepends a forged hop; the trusted proxy appends the real
        // client as the rightmost entry. Taking the last hop ignores the forgery,
        // so the spoofed value can't mint a fresh rate-limit key per request.
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4, 198.51.100.9';
        $this->assertSame('198.51.100.9', client_ip());
    }

    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpUsesCfConnectingIpWhenProxyTrusted(): void
    {
        define('TRUST_PROXY', true);
        define('TRUST_CLOUDFLARE', true);
        define('TRUSTED_PROXIES', ['203.0.113.7']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        $_SERVER['HTTP_CF_CONNECTING_IP'] = '198.51.100.10';
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4, 198.51.100.9';
        $this->assertSame('198.51.100.10', client_ip());
    }

    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpUsesXRealIpWhenProxyTrusted(): void
    {
        define('TRUST_PROXY', true);
        define('TRUST_X_REAL_IP', true);
        define('TRUSTED_PROXIES', ['203.0.113.7']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        $_SERVER['HTTP_X_REAL_IP'] = '198.51.100.11';
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4, 198.51.100.9';
        $this->assertSame('198.51.100.11', client_ip());
    }

    // A trusted proxy that appends a non-IP (or the header is otherwise garbage)
    // must fall back to REMOTE_ADDR rather than rate-limiting on junk.
    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpFallsBackWhenTrustedForwardedHopIsNotAnIp(): void
    {
        define('TRUST_PROXY', true);
        define('TRUSTED_PROXIES', ['203.0.113.7']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.9, not-an-ip';
        $this->assertSame('203.0.113.7', client_ip());
    }

    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpIgnoresForwardedHeaderWhenNotInTrustedProxies(): void
    {
        define('TRUST_PROXY', true);
        define('TRUSTED_PROXIES', ['10.0.0.0/8', '192.168.1.1']);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7'; // Untrusted proxy IP
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4, 198.51.100.9';
        $this->assertSame('203.0.113.7', client_ip());
    }

    #[RunInSeparateProcess]
    #[PreserveGlobalState(false)]
    public function testClientIpUsesForwardedHeaderWhenInTrustedProxies(): void
    {
        define('TRUST_PROXY', true);
        define('TRUSTED_PROXIES', ['10.0.0.0/8', '192.168.1.1']);
        $_SERVER['REMOTE_ADDR'] = '10.0.5.5'; // Trusted proxy IP
        $_SERVER['HTTP_X_FORWARDED_FOR'] = '1.2.3.4, 198.51.100.9';
        $this->assertSame('198.51.100.9', client_ip());
    }

    public function testClientIpHashIsDeterministicAndIpDependent(): void
    {
        $_SERVER['REMOTE_ADDR'] = '203.0.113.7';
        unset($_SERVER['HTTP_X_FORWARDED_FOR']);
        $first = client_ip_hash();
        $this->assertSame($first, client_ip_hash());
        $this->assertMatchesRegularExpression('/^[0-9a-f]{64}$/', $first);
        $_SERVER['REMOTE_ADDR'] = '203.0.113.8';
        $this->assertNotSame($first, client_ip_hash());
    }

    public function testKeepsValidLayoutHash(): void
    {
        $r = validate_share_input([
            'classId' => 1,
            'specId' => 1,
            'builds' => ['AA', 'BB'],
            'layoutHash' => 'abcdef12',
        ]);
        $this->assertSame('abcdef12', $r['payload']['layoutHash']);
    }

    public function testRejectsOverlongLayoutHash(): void
    {
        $r = validate_share_input([
            'classId' => 1,
            'specId' => 1,
            'builds' => ['AA', 'BB'],
            'layoutHash' => str_repeat('a', 17),
        ]);
        $this->assertArrayHasKey('error', $r);
    }

    public function testRejectsNonHexLayoutHash(): void
    {
        $r = validate_share_input([
            'classId' => 1,
            'specId' => 1,
            'builds' => ['AA', 'BB'],
            'layoutHash' => '<script>alert(1)',
        ]);
        $this->assertArrayHasKey('error', $r);
    }

    public function testBase62EncodeSha256IsDeterministic(): void
    {
        $first = base62_encode_sha256('test');
        $this->assertSame($first, base62_encode_sha256('test'));
        // base62 of a 256-bit hash is variable length (it has no fixed-width
        // padding beyond the ID_LEN floor): ~43 chars, but 42 (and rarely 41)
        // occur when the high base62 digit is zero, so don't pin an exact length.
        $this->assertGreaterThanOrEqual(8, strlen($first));
        $this->assertLessThanOrEqual(43, strlen($first));
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9]+$/', $first);
    }

    public function testBase62FallbackMatchesGmp(): void
    {
        if (!function_exists('gmp_init')) {
            $this->markTestSkipped('GMP not available to compare against');
        }
        // The pure-PHP fallback (used on hosts without GMP) must produce byte-for-
        // byte identical ids to the GMP path, or the same payload would address
        // different rows depending on the host.
        foreach (['test', '', 'a', 'hello world', 'probe-0', 'probe-42', '{"classId":1}'] as $in) {
            $hex = hash('sha256', $in);
            $this->assertSame(
                base62_from_hex_gmp($hex),
                base62_from_hex_php($hex),
                "GMP and fallback base62 diverge for input: $in"
            );
        }
    }

    public function testBase62FallbackBcmathMatchesGmp(): void
    {
        if (!function_exists('gmp_init')) {
            $this->markTestSkipped('GMP not available to compare against');
        }
        if (!function_exists('bcdiv')) {
            $this->markTestSkipped('BCMath not available to compare against');
        }
        foreach (['test', '', 'a', 'hello world', 'probe-0', 'probe-42', '{"classId":1}'] as $in) {
            $hex = hash('sha256', $in);
            $this->assertSame(
                base62_from_hex_gmp($hex),
                base62_from_hex_bcmath($hex),
                "GMP and BCMath base62 diverge for input: $in"
            );
        }
    }

    public function testBase62FallbackTerminatesAndIsAlphanumeric(): void
    {
        // Directly exercises the pure-PHP fallback (the GMP path is what runs in
        // CI, so without this the fallback would ship untested).
        for ($i = 0; $i < 50; $i++) {
            $out = base62_from_hex_php(hash('sha256', "fallback-$i"));
            $this->assertGreaterThanOrEqual(8, strlen($out));
            $this->assertMatchesRegularExpression('/^[A-Za-z0-9]+$/', $out);
        }
    }

    public function testCanonicalizePayloadIsKeyOrderIndependent(): void
    {
        $a = canonicalize_payload(['classId' => 1, 'specId' => 2, 'builds' => ['AA', 'BB']]);
        $b = canonicalize_payload(['builds' => ['AA', 'BB'], 'specId' => 2, 'classId' => 1]);
        $this->assertSame($a, $b);
    }

    public function testBase62OutputUsesFullLowercaseAlphabet(): void
    {
        // Ensure the base62 output can contain letters beyond 'v' (w, x, y, z),
        // which gmp_strval(n, 62) does NOT produce — verifying the fix for the
        // GMP alphabet mismatch.
        $chars = '';
        for ($i = 0; $i < 200; $i++) {
            $chars .= base62_encode_sha256("probe-$i");
        }
        // With 200 hashes (~8600 base62 chars), the probability of never seeing
        // any of w/x/y/z is vanishingly small (~1e-60 per letter).
        $this->assertMatchesRegularExpression(
            '/[wxyz]/',
            $chars,
            'base62 output should use the full a-z range, not the GMP a-v subset'
        );
    }

    public function testSameOriginWriteAcceptsSameOriginSignals(): void
    {
        $site = site_origin();
        // Sec-Fetch-Site is authoritative and not script-settable.
        $this->assertTrue(is_same_origin_write('same-origin', null, null));
        // Origin fallback matches the canonical site exactly.
        $this->assertTrue(is_same_origin_write(null, $site, null));
        // Referer fallback under our origin.
        $this->assertTrue(is_same_origin_write(null, null, $site . '/s/abc123xy'));
    }

    public function testSameOriginWriteRejectsCrossOriginAndMissingSignals(): void
    {
        $site = site_origin();
        // The CSRF case: a cross-site simple-request POST.
        $this->assertFalse(is_same_origin_write('cross-site', null, null));
        // A spoofed Origin from an attacker page.
        $this->assertFalse(is_same_origin_write(null, 'https://evil.example', null));
        // Referer on a look-alike host that merely starts with the site string.
        $this->assertFalse(is_same_origin_write(null, null, $site . '.evil.example/x'));
        // No origin signal at all → fail closed to enforce strict same-origin policy.
        $this->assertFalse(is_same_origin_write(null, null, null));
    }
}
