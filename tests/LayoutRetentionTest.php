<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Covers the supersession-retention helpers: load_current_layouts (reads the
 * deployed manifest) and reconcile_layout_history (updates the history table from
 * it). Both are pure enough to test without a live database — the reader against
 * temp files, the reconciler against a mocked PDO — loaded via tests/bootstrap.php
 * with the request handler guarded off.
 */
final class LayoutRetentionTest extends TestCase
{
    private function tmpManifest(string $contents): string
    {
        $path = tempnam(sys_get_temp_dir(), 'cb_manifest_');
        file_put_contents($path, $contents);
        return $path;
    }

    public function testLoadCurrentLayoutsReturnsHashMap(): void
    {
        $path = $this->tmpManifest(json_encode([
            'generatedAt' => '2026-07-01T00:00:00Z',
            'hashes'      => ['death_knight' => '6a9c38c6b2daa867', 'mage' => 'f05e7488c38ba213'],
        ]));
        $map = load_current_layouts($path);
        unlink($path);

        $this->assertSame(
            ['death_knight' => '6a9c38c6b2daa867', 'mage' => 'f05e7488c38ba213'],
            $map
        );
    }

    public function testLoadCurrentLayoutsSkipsMalformedHashes(): void
    {
        $path = $this->tmpManifest(json_encode([
            'hashes' => [
                'ok'       => 'abcdef0123456789',
                'too_long' => '0123456789abcdef0', // 17 chars
                'illegal'  => 'nothex!!',
                'nonstr'   => 42,
            ],
        ]));
        $map = load_current_layouts($path);
        unlink($path);

        $this->assertSame(['ok' => 'abcdef0123456789'], $map);
    }

    public function testLoadCurrentLayoutsReturnsNullOnMissingFile(): void
    {
        $this->assertNull(load_current_layouts('/no/such/manifest.json'));
    }

    public function testLoadCurrentLayoutsReturnsNullOnMalformedJson(): void
    {
        $path = $this->tmpManifest('{ not valid json');
        $result = load_current_layouts($path);
        unlink($path);
        $this->assertNull($result);
    }

    public function testLoadCurrentLayoutsReturnsNullWhenHashesKeyMissing(): void
    {
        $path = $this->tmpManifest(json_encode(['generatedAt' => 'x']));
        $result = load_current_layouts($path);
        unlink($path);
        $this->assertNull($result);
    }

    public function testReconcileEmptyManifestIsANoOp(): void
    {
        // An empty/broken manifest must never touch the table — otherwise it would
        // mark every layout superseded and trigger a mass prune.
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('prepare');

        reconcile_layout_history($pdo, []);
    }

    public function testTouchShareAccessRunsDebouncedUpdate(): void
    {
        $stmt = $this->createMock(PDOStatement::class);
        $stmt->expects($this->once())->method('execute')->with(['abc123xy'])->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())
            ->method('prepare')
            ->willReturnCallback(function (string $sql) use ($stmt) {
                // Debounced to at most one write/day so a hot link can't storm writes.
                $this->assertStringContainsString('UPDATE comparebuilds_shares SET last_accessed = NOW()', $sql);
                $this->assertStringContainsString('last_accessed < NOW() - INTERVAL 1 DAY', $sql);
                return $stmt;
            });

        touch_share_access($pdo, 'abc123xy');
    }

    public function testTouchShareAccessSwallowsErrors(): void
    {
        // Retention bookkeeping must never break serving a share, so a DB error
        // during the touch is swallowed rather than propagated.
        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willThrowException(new PDOException('db down'));

        // Returns normally (void) despite the thrown PDOException — no rethrow.
        $this->assertNull(touch_share_access($pdo, 'abc123xy'));
    }

    public function testReconcileInsertsCurrentHashesAndSupersedesTheRest(): void
    {
        $current = ['death_knight' => 'aaaa1111', 'mage' => 'bbbb2222'];

        $insertStmt = $this->createMock(PDOStatement::class);
        // One upsert per current hash, each marking it live (superseded_at NULL).
        $insertStmt->expects($this->exactly(2))
            ->method('execute')
            ->willReturnCallback(function ($args) {
                static $calls = [];
                $calls[] = $args;
                $this->assertContains($args, [['aaaa1111', 'death_knight'], ['bbbb2222', 'mage']]);
                return true;
            });

        $supersedeStmt = $this->createMock(PDOStatement::class);
        // The supersede sweep binds the current hashes (excluding them) followed
        // by the class keys it is allowed to supersede within.
        $supersedeStmt->expects($this->once())
            ->method('execute')
            ->with(['aaaa1111', 'bbbb2222', 'death_knight', 'mage'])
            ->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->exactly(2))
            ->method('prepare')
            ->willReturnCallback(function (string $sql) use ($insertStmt, $supersedeStmt) {
                if (str_contains($sql, 'INSERT INTO comparebuilds_layout_history')) {
                    $this->assertStringContainsString('ON DUPLICATE KEY UPDATE superseded_at = NULL', $sql);
                    return $insertStmt;
                }
                $this->assertStringContainsString('SET superseded_at = NOW()', $sql);
                $this->assertStringContainsString('NOT IN (?,?)', $sql);
                // Supersession is scoped to the classes the manifest carries.
                $this->assertStringContainsString('class_key IN (?,?)', $sql);
                return $supersedeStmt;
            });

        reconcile_layout_history($pdo, $current);
    }

    public function testReconcileScopesSupersessionToManifestClasses(): void
    {
        // A partial manifest that carries only one class must supersede old hashes
        // only within that class — a class dropped from the manifest keeps its live
        // hash rather than being superseded (its layout may still be current).
        $current = ['mage' => 'bbbb2222'];

        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->expects($this->once())
            ->method('execute')
            ->with(['bbbb2222', 'mage'])
            ->willReturn(true);

        $supersedeStmt = $this->createMock(PDOStatement::class);
        // Only 'mage' is eligible to be superseded within; death_knight, absent
        // from the manifest, is never touched.
        $supersedeStmt->expects($this->once())
            ->method('execute')
            ->with(['bbbb2222', 'mage'])
            ->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->exactly(2))
            ->method('prepare')
            ->willReturnCallback(function (string $sql) use ($insertStmt, $supersedeStmt) {
                if (str_contains($sql, 'INSERT INTO comparebuilds_layout_history')) {
                    return $insertStmt;
                }
                $this->assertStringContainsString('class_key IN (?)', $sql);
                return $supersedeStmt;
            });

        reconcile_layout_history($pdo, $current);
    }
}
