<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RateLimiterTest extends TestCase
{
    public function testRedisLockReportsRedisBackendAndReleasesOnRedis(): void
    {
        $redis = new class () {
            public bool $setCalled = false;
            public bool $evalDel = false;

            public function set($key, $val, $opts)
            {
                $this->setCalled = true;
                return true;
            }

            public function eval($script, $args, $numKeys)
            {
                $this->evalDel = true;
                return 1;
            }
        };

        // A Redis lock must never touch MySQL, on either acquire or release.
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('prepare');

        $usedRedis = null;
        $this->assertTrue(RateLimiter::acquireLock($pdo, $redis, 'cb_og_x', 'tok', 30, $usedRedis));
        $this->assertTrue($usedRedis, 'acquireLock must report the Redis backend');
        $this->assertTrue($redis->setCalled);

        RateLimiter::releaseLock($pdo, $redis, 'cb_og_x', 'tok', $usedRedis);
        $this->assertTrue($redis->evalDel, 'a Redis lock must be released via Redis');
    }

    public function testRedisLockIsNotReleasedViaMysqlAfterHandleLost(): void
    {
        // Regression: the shutdown/finally release used to pick its backend from
        // the live $redis handle. A mid-request Redis failure nulls that handle,
        // which diverted a Redis-held lock's release to a MySQL RELEASE_LOCK — a
        // no-op on a lock MySQL never held — stranding the real Redis lock until
        // its TTL and 503-ing that IP meanwhile. Tracking the acquiring backend
        // must stop the MySQL release entirely.
        $redis = new class () {
            public function set($key, $val, $opts)
            {
                return true;
            }
        };

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('prepare');

        $usedRedis = null;
        $this->assertTrue(RateLimiter::acquireLock($pdo, $redis, 'cb_og_x', 'tok', 30, $usedRedis));
        $this->assertTrue($usedRedis);

        // Redis dies after the lock was taken: the shared handle is nulled.
        $redis = null;

        // With the remembered backend, no MySQL RELEASE_LOCK is issued (the
        // $pdo->prepare never() assertion above enforces this); the Redis lock
        // simply lapses at its TTL.
        RateLimiter::releaseLock($pdo, $redis, 'cb_og_x', 'tok', $usedRedis);
    }

    public function testMysqlLockReportsMysqlBackendAndReleasesOnMysql(): void
    {
        $lockStmt = $this->createStub(PDOStatement::class);
        $lockStmt->method('execute')->willReturn(true);
        $lockStmt->method('fetchColumn')->willReturn(1);

        $released = false;
        $relStmt = $this->createMock(PDOStatement::class);
        $relStmt->expects($this->once())
            ->method('execute')
            ->willReturnCallback(function () use (&$released) {
                $released = true;
                return true;
            });

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturnCallback(function ($query) use ($lockStmt, $relStmt) {
            if (str_starts_with($query, 'SELECT GET_LOCK')) {
                return $lockStmt;
            }
            if (str_starts_with($query, 'SELECT RELEASE_LOCK')) {
                return $relStmt;
            }
            throw new RuntimeException("Unexpected query: $query");
        });

        $redis = null;
        $usedRedis = null;
        $this->assertTrue(RateLimiter::acquireLock($pdo, $redis, 'cb_share_x', 'tok', 5, $usedRedis));
        $this->assertFalse($usedRedis, 'a MySQL lock must report the MySQL backend');

        RateLimiter::releaseLock($pdo, $redis, 'cb_share_x', 'tok', $usedRedis);
        $this->assertTrue($released, 'a MySQL lock must be released via MySQL RELEASE_LOCK');
    }

    public function testBusyRedisLockReportsNotAcquired(): void
    {
        $redis = new class () {
            public function set($key, $val, $opts)
            {
                return false; // lock already held by someone else
            }
        };

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('prepare');

        $usedRedis = null;
        $this->assertFalse(RateLimiter::acquireLock($pdo, $redis, 'cb_og_x', 'tok', 30, $usedRedis));
        $this->assertFalse($usedRedis, 'a busy lock acquires no backend');
    }

    public function testRedisErrorReplyFallsBackToTheDbInsteadOfCountingZero(): void
    {
        // Regression: phpredis returns false (it does not throw) for a server
        // error reply — -OOM, -NOSCRIPT, -BUSY, a read-only replica. (int) false
        // is 0, which is non-null, so callers read a valid count of 0, compute
        // count-1 = -1, pass every limit, and skip the DB fallback branch: both
        // the share and OG limiters were disabled for as long as Redis stayed
        // unhealthy. An error reply must read as a Redis failure.
        $redis = new class () {
            public function eval($script, $args, $numKeys)
            {
                return false;
            }
        };

        $count = RateLimiter::checkRedis($redis, 'cb_rl_share_x', 20, 3600, true);

        $this->assertNull($count, 'an error reply must not read as a count of 0');
        $this->assertNull($redis, 'the handle must be dropped so callers use the DB limiter');
    }

    public function testRedisZeroCountIsStillARealCount(): void
    {
        // The false check must not swallow a genuine falsy count: Lua returning
        // 0 is a real answer and has to stay distinguishable from an error.
        $redis = new class () {
            public function eval($script, $args, $numKeys)
            {
                return 0;
            }
        };

        $this->assertSame(0, RateLimiter::checkRedis($redis, 'cb_rl_share_x', 20, 3600));
        $this->assertNotNull($redis, 'a successful reply must keep the handle');
    }

    public function testCountDbWindowReturnsCountAndOldest(): void
    {
        $stmt = $this->createMock(PDOStatement::class);
        $stmt->expects($this->once())->method('execute')->with(['hash123']);
        $stmt->method('fetch')->willReturn(['c' => '7', 'oldest' => '1700000000']);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())->method('prepare')
            ->with($this->logicalAnd(
                $this->stringContains('FROM comparebuilds_share_requests'),
                $this->stringContains('INTERVAL 3600 SECOND'),
            ))
            ->willReturn($stmt);

        $res = RateLimiter::countDbWindow($pdo, 'comparebuilds_share_requests', 'hash123', 3600);
        $this->assertSame(7, $res['count']);
        $this->assertSame(1700000000, $res['oldest']);
    }

    public function testCountDbWindowReportsNullOldestForAnEmptyWindow(): void
    {
        $stmt = $this->createStub(PDOStatement::class);
        $stmt->method('fetch')->willReturn(['c' => '0', 'oldest' => null]);

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturn($stmt);

        $res = RateLimiter::countDbWindow($pdo, 'comparebuilds_og_requests', 'hash123', 60);
        $this->assertSame(0, $res['count']);
        $this->assertNull($res['oldest']);
    }

    public function testRecordDbRequestInsertsWhileUnderTheRowCap(): void
    {
        $ins = $this->createMock(PDOStatement::class);
        $ins->expects($this->once())->method('execute')->with(['hash123']);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())->method('prepare')
            ->with($this->stringContains('INSERT INTO comparebuilds_share_requests'))
            ->willReturn($ins);

        // Exactly at the 2x cap still logs (the window must keep reflecting an
        // ongoing flood rather than freezing at the limit).
        RateLimiter::recordDbRequest($pdo, 'comparebuilds_share_requests', 'hash123', 10, 5, 'share request');
    }

    public function testRecordDbRequestSlidesTheOldestRowPastTheCap(): void
    {
        $slide = $this->createMock(PDOStatement::class);
        $slide->expects($this->once())->method('execute')->with(['hash123']);

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())->method('prepare')
            ->with($this->logicalAnd(
                $this->stringContains('UPDATE comparebuilds_og_requests SET created_at = NOW()'),
                $this->stringContains('ORDER BY created_at ASC LIMIT 1'),
            ))
            ->willReturn($slide);

        // Past the 2x row cap: no INSERT — the oldest row slides forward so the
        // abuser's recovery horizon keeps moving while the table stays bounded.
        RateLimiter::recordDbRequest($pdo, 'comparebuilds_og_requests', 'hash123', 11, 5, 'OG request');
    }

    public function testRecordDbRequestSwallowsWriteFailures(): void
    {
        // Best-effort by contract: a failed write is logged, never thrown, so
        // accounting can't mask the caller's own response (a 503/429 about to
        // be sent, or a share commit already made).
        $stmt = $this->createStub(PDOStatement::class);
        $stmt->method('execute')->willThrowException(new PDOException('gone'));

        $pdo = $this->createStub(PDO::class);
        $pdo->method('prepare')->willReturn($stmt);

        RateLimiter::recordDbRequest($pdo, 'comparebuilds_share_requests', 'hash123', 0, 5, 'share request');
        $this->addToAssertionCount(1); // reaching here means nothing threw
    }
}
