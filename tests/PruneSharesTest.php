<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

// Load prune_shares.php's pure batched-delete helper without running the cron.
// The PRUNE_SHARES_NO_MAIN guard returns before requiring config.php or opening a
// database connection, so no credentials or MySQL instance are needed.
define('PRUNE_SHARES_NO_MAIN', true);
require_once __DIR__ . '/../api/cron/prune_shares.php';

/**
 * Covers prune_batched's per-run safety cap — the defense-in-depth ceiling that
 * bounds how many share rows one run may delete, so a bug that mis-marks a current
 * layout superseded can't mass-delete live builds in a single pass.
 */
final class PruneSharesTest extends TestCase
{
    private function seed(int $rows): PDO
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
        $insert = $pdo->prepare('INSERT INTO t (id) VALUES (?)');
        $pdo->beginTransaction();
        for ($i = 1; $i <= $rows; $i++) {
            $insert->execute([$i]);
        }
        $pdo->commit();
        return $pdo;
    }

    private function remaining(PDO $pdo): int
    {
        return (int) $pdo->query('SELECT COUNT(*) FROM t')->fetchColumn();
    }

    // A 1000-row batch delete, portable to SQLite (LIMIT lives in the subselect).
    private const BATCH_SQL = 'DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 1000)';

    public function testUncappedPruneDeletesEveryRow(): void
    {
        $pdo = $this->seed(2500);
        $this->assertTrue(prune_batched($pdo, self::BATCH_SQL, 'test'));
        $this->assertSame(0, $this->remaining($pdo), 'no cap → drains fully');
    }

    public function testCapStopsEarlyAndLeavesTheRemainderForNextRun(): void
    {
        $pdo = $this->seed(2500);
        // Cap at 2000: two 1000-row batches reach the cap, so 500 rows are left.
        $this->assertTrue(prune_batched($pdo, self::BATCH_SQL, 'shares', 2000));
        $this->assertSame(
            500,
            $this->remaining($pdo),
            'cap must stop further deletion, leaving the remainder for the next run',
        );
    }

    public function testCapNotReachedDrainsNormally(): void
    {
        $pdo = $this->seed(1500);
        // Cap well above the row count: the prune completes normally.
        $this->assertTrue(prune_batched($pdo, self::BATCH_SQL, 'shares', 5000));
        $this->assertSame(0, $this->remaining($pdo));
    }
}
