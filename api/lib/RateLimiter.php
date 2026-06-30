<?php

declare(strict_types=1);

class RateLimiter
{
    /**
     * Attempts to acquire a distributed lock (Redis with a MySQL fallback).
     *
     * @param PDO $pdo The MySQL connection.
     * @param object|null &$redis The Redis connection. May be set to null if it fails.
     * @param string $lockName The name of the lock.
     * @param string $lockToken The random token for the lock to ensure safe release.
     * @return bool True if acquired, false if busy.
     */
    public static function acquireLock(PDO $pdo, ?object &$redis, string $lockName, string $lockToken): bool
    {
        $usedRedisLock = false;

        if ($redis !== null) {
            try {
                if (!$redis->set($lockName, $lockToken, ['nx', 'ex' => 5])) {
                    return false;
                }
                $usedRedisLock = true;
            } catch (Throwable $e) {
                $redis = null;
            }
        }

        if (!$usedRedisLock) {
            $lk = $pdo->prepare('SELECT GET_LOCK(?, 1)');
            $lk->execute([$lockName]);
            if ((int) $lk->fetchColumn() !== 1) {
                return false;
            }
        }

        return true;
    }

    /**
     * Releases a distributed lock.
     *
     * @param PDO $pdo The MySQL connection.
     * @param object|null $redis The Redis connection.
     * @param string $lockName The name of the lock.
     * @param string $lockToken The random token for the lock.
     */
    public static function releaseLock(PDO $pdo, ?object $redis, string $lockName, string $lockToken): void
    {
        if ($redis !== null) {
            try {
                $lua = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
                $redis->eval($lua, [$lockName, $lockToken], 1);
                return;
            } catch (Throwable $e) {
                // Fallback to MySQL release
            }
        }

        $rel = $pdo->prepare('SELECT RELEASE_LOCK(?)');
        $rel->execute([$lockName]);
    }

    /**
     * Checks rate limits using Redis.
     *
     * @param object|null &$redis The Redis connection. May be set to null if it fails.
     * @param string $rlKey The rate limit key.
     * @param int $limit The maximum allowed requests.
     * @param int $window The time window in seconds.
     * @param bool $penalty Whether to double the window on limit exceed.
     * @return int|null The current count, or null if Redis failed (fallback to DB needed).
     */
    public static function checkRedis(?object &$redis, string $rlKey, int $limit, int $window, bool $penalty = false): ?int
    {
        if ($redis === null) {
            return null;
        }

        try {
            $current = $redis->get($rlKey);
            if ($current !== false && (int) $current >= $limit) {
                if ($penalty) {
                    $redis->expire($rlKey, $window * 2);
                }
                return (int) $current;
            }

            $count = $redis->incr($rlKey);
            if ($count === 1 || (int) $redis->ttl($rlKey) < 0) {
                $redis->expire($rlKey, $window);
            }
            return (int) $count;
        } catch (Throwable $e) {
            $redis = null;
            return null;
        }
    }
}
