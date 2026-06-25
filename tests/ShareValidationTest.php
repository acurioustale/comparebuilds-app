<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Covers the share API's public-input validation surface — the security-relevant
 * logic a malicious or buggy client can reach. The helpers are pure (no DB, no
 * output), loaded via tests/bootstrap.php with the request handler guarded off.
 */
final class ShareValidationTest extends TestCase
{
    public function testValidShareIdAcceptsSixAlnum(): void
    {
        $this->assertTrue(valid_share_id('abc123'));
        $this->assertTrue(valid_share_id('ABCxyz'));
    }

    public function testValidShareIdRejectsMalformed(): void
    {
        $this->assertFalse(valid_share_id('abc'));     // too short
        $this->assertFalse(valid_share_id('abc1234')); // too long
        $this->assertFalse(valid_share_id('abc-12'));  // illegal char
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
}
