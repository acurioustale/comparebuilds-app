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
        $lockStmt = $this->createMock(PDOStatement::class);
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

        $pdo = $this->createMock(PDO::class);
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
}
