<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ShareConcurrencyTest extends TestCase
{
    public function testStoreShareThrowsServerBusyWhenGetLockFails(): void
    {
        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('execute')->willReturn(true);
        $lockStmt->method('fetchColumn')->willReturn(0); // GET_LOCK failed / timed out

        // A lock-timeout must still record the attempt against the limiter, so a
        // sustained lock-contention flood can't slip past the rate limit
        // uncounted. Under the row cap here, so the attempt is logged. (The
        // count runs through RateLimiter::countDbWindow, which fetches a
        // c/oldest row.)
        $rlStmt = $this->createStub(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 5, 'oldest' => null]);

        $logged = false;
        $insertStmt = $this->createMock(PDOStatement::class);
        $insertStmt->expects($this->once())
                   ->method('execute')
                   ->willReturnCallback(function () use (&$logged) {
                       $logged = true;
                       return true;
                   });

        $pdo = $this->createStub(PDO::class);
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
        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('execute')->willReturn(true);
        $lockStmt->method('fetchColumn')->willReturn(0);

        $rlStmt = $this->createStub(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 999, 'oldest' => 1700000000]);

        $slideStmt = $this->createMock(PDOStatement::class);
        $slideStmt->expects($this->once())->method('execute')->willReturn(true);

        $pdo = $this->createStub(PDO::class);
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

        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createStub(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 0, 'oldest' => null]);

        $checkStmt = $this->createStub(PDOStatement::class);
        // The dedup fast-path (find_existing_share_id) fetches first and must miss
        // (false) so the request proceeds to the claim loop; then the claim loop's
        // own check misses (false → attempt insert), the insert raises the
        // duplicate-key race, and the re-check finds the stored data (dedup hit).
        $checkStmt->method('fetch')->willReturnOnConsecutiveCalls(false, false, ['data' => $stored]);

        $e = new PDOException('Duplicate entry');
        $e->errorInfo = ['23000', 1062, 'Duplicate entry'];

        $insertStmt = $this->createStub(PDOStatement::class);
        $insertStmt->method('execute')->willThrowException($e);

        // The row already existed, so returning its id is use — it must reset the
        // retention clock, exactly as the fast-path dedup does.
        $touched = [];
        $touchStmt = $this->createStub(PDOStatement::class);
        $touchStmt->method('execute')->willReturnCallback(function ($params) use (&$touched) {
            $touched[] = $params[0];
            return true;
        });

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $rlStmt, $checkStmt, $insertStmt, $touchStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT COUNT(*)')) {
                return $rlStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'UPDATE comparebuilds_shares SET last_accessed')) {
                return $touchStmt;
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
        $this->assertSame([$candidate], $touched);
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

        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1); // GET_LOCK / RELEASE_LOCK

        // Already stored at the base (8-char) prefix → dedup fast-path hit.
        $checkStmt = $this->createStub(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(['data' => $stored]);

        // A dedup hit still counts as use of the link, so its retention clock
        // must be reset — otherwise a re-shared, long-idle, superseded-layout
        // link can be pruned the same night it was handed out.
        $touched = [];
        $touchStmt = $this->createStub(PDOStatement::class);
        $touchStmt->method('execute')->willReturnCallback(function ($params) use (&$touched) {
            $touched[] = $params[0];
            return true;
        });

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $checkStmt, $touchStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK') || str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT data FROM')) {
                return $checkStmt;
            }
            if (str_starts_with($query, 'UPDATE comparebuilds_shares SET last_accessed')) {
                return $touchStmt;
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
        $this->assertSame([$candidate], $touched);
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

        $checkStmt = $this->createStub(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $insertStmt = $this->createStub(PDOStatement::class);
        $insertStmt->method('execute')->willReturn(true);

        $pdo = $this->createStub(PDO::class);
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

    public function testStoreShareLockOutlivesItsCriticalSection(): void
    {
        // Regression: the lock was taken with acquireLock's 5-second default. A
        // Redis lock auto-expires at its TTL, and the guarded section runs up to
        // ~11 database round-trips (dedup lookup, rate-limit count and insert, id
        // claim loop). Under database load it lapsed mid-section, letting a second
        // request from the same IP read the pre-insert count and re-open the very
        // TOCTOU race the lock exists to close.
        $payload = ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']];

        $redis = new class () {
            public array $setOpts = [];

            public function set($key, $val, $opts)
            {
                $this->setOpts = $opts;
                return true;
            }
            public function eval($script, $args, $numKeys)
            {
                return str_contains($script, 'incr') ? 1 : 1;
            }
        };

        $checkStmt = $this->createStub(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);
        $insertStmt = $this->createStub(PDOStatement::class);
        $insertStmt->method('execute')->willReturn(true);

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturnCallback(
            fn ($q) => str_starts_with($q, 'INSERT INTO') ? $insertStmt : $checkStmt
        );

        store_share($pdo, $payload, 'dummy-ip-hash', $redis);

        $this->assertSame(SHARE_LOCK_TTL, $redis->setOpts['ex'] ?? null, 'the lock must carry the sized TTL');
        $this->assertGreaterThanOrEqual(
            30,
            SHARE_LOCK_TTL,
            'the TTL must cover ~11 database round-trips on a contended server'
        );
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

        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createStub(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 0, 'oldest' => null]);

        $checkStmt = $this->createStub(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $insertStmt = $this->createStub(PDOStatement::class);
        $insertStmt->method('execute')->willReturn(true);

        $pdo = $this->createStub(PDO::class);
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
        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $rlStmt = $this->createStub(PDOStatement::class);
        $rlStmt->method('fetch')->willReturn(['c' => 50, 'oldest' => time() - 10]);

        // The dedup fast-path runs first: this content is NOT already stored, so
        // it misses and the request falls through to the rate limiter, which is
        // where the over-cap slide + 429 under test happens.
        $checkStmt = $this->createStub(PDOStatement::class);
        $checkStmt->method('fetch')->willReturn(false);

        $slid = false;
        $slideStmt = $this->createMock(PDOStatement::class);
        $slideStmt->expects($this->once())
                  ->method('execute')
                  ->willReturnCallback(function () use (&$slid) {
                      $slid = true;
                      return true;
                  });

        $pdo = $this->createStub(PDO::class);
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
