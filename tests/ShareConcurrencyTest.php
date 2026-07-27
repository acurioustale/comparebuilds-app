<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ShareConcurrencyTest extends TestCase
{
    public function testStoreShareThrowsServerBusyWhenGetLockFails(): void
    {
        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('execute')->willReturn(true);
        $lockStmt->method('fetchColumn')->willReturn(0); // GET_LOCK failed / timed out

        // A lock-timeout must still record the attempt against the limiter, so a
        // sustained lock-contention flood can't slip past the rate limit
        // uncounted. Under the row cap here, so the attempt is logged. (The
        // count runs through RateLimiter::countDbWindow, which fetches a
        // c/oldest row.)
        $rlStmt = $this->createMock(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 5, 'oldest' => null]);

        $logged = false;
        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->expects($this->once())
                   ->method('execute')
                   ->willReturnCallback(function () use (&$logged) {
                       $logged = true;
                       return true;
                   });

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $insertStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'INSERT INTO comparebuilds_share_requests')) {
                return $insertStmt;
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        try {
            store_share($pdo, ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']], 'dummy-ip-hash');
            $this->fail('Expected ShareException was not thrown');
        } catch (ShareException $e) {
            $this->assertSame(503, $e->httpStatus);
            $this->assertSame('Server busy — please try again', $e->getMessage());
        }
        $this->assertTrue($logged, 'a lock-timeout attempt must still be counted');
    }

    public function testThrottledAttemptSlidesInsteadOfLoggingPastRowCap(): void
    {
        // On a lock-timeout with the IP already past the 2x row cap, inserting
        // another row would grow the table unbounded, so no new row is written —
        // instead the oldest logged request is slid forward to now, mirroring the
        // in-lock over-cap penalty so a contention flood can't drain the window.
        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('execute')->willReturn(true);
        $lockStmt->method('fetchColumn')->willReturn(0);

        $rlStmt = $this->createMock(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 999, 'oldest' => 1700000000]);

        $slideStmt = $this->createMock(PDOStatement::class);
        $slideStmt->expects($this->once())->method('execute')->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $slideStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'UPDATE comparebuilds_share_requests SET created_at')) {
                return $slideStmt;
            }
            if (str_starts_with($query, 'INSERT INTO comparebuilds_share_requests')) {
                throw new RuntimeException('must not log a new request row past the cap');
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        try {
            store_share($pdo, ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']], 'dummy-ip-hash');
            $this->fail('Expected ShareException was not thrown');
        } catch (ShareException $e) {
            $this->assertSame(503, $e->httpStatus);
        }
    }

    public function testStoreShareHandlesDuplicateKeyExceptionAsDeduplication(): void
    {
        $payload = ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']];
        $stored = canonicalize_payload($payload);
        $baseId = base62_encode_sha256($stored);
        $candidate = substr($baseId, 0, 8);

        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createMock(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 0, 'oldest' => null]);

        $checkStmt = $this->createMock(PDOStatement::class);
        // The dedup fast-path (find_existing_share_id) fetches first and must miss
        // (false) so the request proceeds to the claim loop; then the claim loop's
        // own check misses (false → attempt insert), the insert raises the
        // duplicate-key race, and the re-check finds the stored data (dedup hit).
        $checkStmt->method('fetch')->willReturnOnConsecutiveCalls(false, false, ['data' => $stored]);

        $e = new PDOException('Duplicate entry');
        $e->errorInfo = ['23000', 1062, 'Duplicate entry'];

        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->method('execute')->willThrowException($e);

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $checkStmt, $insertStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'INSERT INTO')) {
                return $insertStmt;
            }
            if (str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $lockStmt;
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        $id = store_share($pdo, $payload, 'dummy-ip-hash');
        $this->assertSame($candidate, $id);
    }

    public function testDedupHitSkipsRateLimitAndReturnsExistingId(): void
    {
        // Re-POSTing content that is already stored creates no new row, so it must
        // not consume a per-IP rate-limit slot: the fast-path returns the existing
        // id under the lock, before the limiter is ever consulted. The mock makes
        // any rate-limit query fatal, so touching the limiter fails the test.
        $payload = ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']];
        $stored = canonicalize_payload($payload);
        $baseId = base62_encode_sha256($stored);
        $candidate = substr($baseId, 0, 8);

        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1); // GET_LOCK / RELEASE_LOCK

        // Already stored at the base (8-char) prefix → dedup fast-path hit.
        $checkStmt = $this->createMock(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(['data' => $stored]);

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $checkStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK') || str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')
                || str_starts_with($query, 'INSERT INTO comparebuilds_share_requests')
                || str_starts_with($query, 'UPDATE comparebuilds_share_requests')) {
                throw new RuntimeException("rate limiter must not be touched on a dedup hit: $query");
            }
            if (str_starts_with($query, 'INSERT INTO comparebuilds_shares')) {
                throw new RuntimeException('a dedup hit must not insert a new share row');
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        $id = store_share($pdo, $payload, 'dummy-ip-hash');
        $this->assertSame($candidate, $id);
    }

    public function testStoreShareUsesRedisWhenAvailable(): void
    {
        $payload = ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']];
        $stored = canonicalize_payload($payload);
        $baseId = base62_encode_sha256($stored);
        $candidate = substr($baseId, 0, 8);

        $redis = new class () {
            public bool $locked = false;
            public bool $unlocked = false;
            public int $count = 0;

            public function set($key, $val, $opts)
            {
                $this->locked = true;
                return true;
            }
            public function get($key)
            {
                return false;
            }
            public function del($key)
            {
                $this->unlocked = true;
                return true;
            }
            public function eval($script, $args, $numKeys)
            {
                // The rate-limit check runs its INCR/EXPIRE as one atomic Lua
                // script; the lock release is a separate script. Distinguish them
                // by content so this mock mirrors both call sites.
                if (str_contains($script, 'incr')) {
                    $this->count++;
                    return 1; // first hit, within the limit
                }
                $this->unlocked = true;
                return 1;
            }
        };

        $checkStmt = $this->createMock(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->method('execute')->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($checkStmt, $insertStmt) {
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'INSERT INTO')) {
                return $insertStmt;
            }
            throw new RuntimeException("Unexpected MySQL query called when Redis should be used: $query");
        });

        $id = store_share($pdo, $payload, 'dummy-ip-hash', $redis);
        $this->assertSame($candidate, $id);
        $this->assertTrue($redis->locked);
        $this->assertTrue($redis->unlocked);
        $this->assertSame(1, $redis->count);
    }

    public function testStoreShareFallsBackToMysqlWhenRedisFails(): void
    {
        $payload = ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']];
        $stored = canonicalize_payload($payload);
        $baseId = base62_encode_sha256($stored);
        $candidate = substr($baseId, 0, 8);

        $redis = new class () {
            public function set($key, $val, $opts)
            {
                throw new RuntimeException('Redis connection dropped');
            }
        };

        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createMock(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 0, 'oldest' => null]);

        $checkStmt = $this->createMock(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->method('execute')->willReturn(true);

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $checkStmt, $insertStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'INSERT INTO')) {
                return $insertStmt;
            }
            if (str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $lockStmt;
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        $id = store_share($pdo, $payload, 'dummy-ip-hash', $redis);
        $this->assertSame($candidate, $id);
    }

    public function testStoreShareSlidesOldestRequestForwardWhenOverRowCap(): void
    {
        // An IP past 2x the limit is rate-limited AND past the row-log cap. The
        // request must not be INSERTed (unbounded growth) but must slide the
        // oldest logged row forward so the window can't drain while the abuse
        // continues — then still be rejected with 429.
        $lockStmt = $this->createMock(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createMock(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 50, 'oldest' => time() - 10]);

        // The dedup fast-path runs first: this content is NOT already stored, so
        // it misses and the request falls through to the rate limiter, which is
        // where the over-cap slide + 429 under test happens.
        $checkStmt = $this->createMock(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $slid = false;
        $slideStmt = $this->createMock(PDOStatement::class);
        $slideStmt->expects($this->once())
                  ->method('execute')
                  ->willReturnCallback(function () use (&$slid) {
                      $slid = true;
                      return true;
                  });

        $pdo = $this->createMock(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $checkStmt, $slideStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'UPDATE comparebuilds_share_requests')) {
                return $slideStmt;
            }
            if (str_starts_with($query, 'INSERT INTO comparebuilds_share_requests')) {
                throw new RuntimeException('must not log a new request row past the cap');
            }
            if (str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $lockStmt;
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        try {
            store_share($pdo, ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']], 'dummy-ip-hash');
            $this->fail('Expected 429 ShareException was not thrown');
        } catch (ShareException $e) {
            $this->assertSame(429, $e->httpStatus);
        }
        $this->assertTrue($slid, 'oldest request row should be slid forward');
    }
}
