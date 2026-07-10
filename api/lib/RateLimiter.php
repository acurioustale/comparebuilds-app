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
     * @param int $ttl Redis lock expiry in seconds. Must exceed the critical
     *   section's worst-case duration so the lock cannot auto-expire while still
     *   held (the MySQL GET_LOCK path is connection-scoped and ignores this).
     * @param bool|null &$usedRedis Set to true when the lock was taken on Redis,
     *   false when taken via MySQL GET_LOCK. The caller must remember this and
     *   pass it back to releaseLock so the release targets the SAME backend even
     *   if $redis is later nulled by a mid-request failure.
     * @return bool True if acquired, false if busy.
     */
    public static function acquireLock(PDO $pdo, ?object &$redis, string $lockName, string $lockToken, int $ttl = 5, ?bool &$usedRedis = null): bool
    {
        $usedRedis = false;
        $usedRedisLock = false;

        if ($redis !== null) {
            try {
                if (!$redis->set($lockName, $lockToken, ['nx', 'ex' => $ttl])) {
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

        $usedRedis = $usedRedisLock;
        return true;
    }

    /**
     * Releases a distributed lock.
     *
     * @param PDO $pdo The MySQL connection.
     * @param object|null $redis The Redis connection.
     * @param string $lockName The name of the lock.
     * @param string $lockToken The random token for the lock.
     * @param bool|null $viaRedis The backend that acquired the lock, as reported
     *   by acquireLock's &$usedRedis out-param. Release MUST target the same
     *   backend: inferring it from the live $redis handle is unsafe because a
     *   mid-request Redis failure nulls the shared handle, which would divert a
     *   Redis-acquired lock's release to a MySQL RELEASE_LOCK (a no-op on a lock
     *   MySQL never held) and strand the real Redis lock until its TTL — 503-ing
     *   that IP meanwhile. When null, the backend is inferred from $redis for
     *   best effort (legacy callers).
     */
    public static function releaseLock(PDO $pdo, ?object $redis, string $lockName, string $lockToken, ?bool $viaRedis = null): void
    {
        $viaRedis ??= ($redis !== null);

        if ($viaRedis) {
            // Acquired on Redis. Only Redis can release it; if the handle is gone
            // the lock lapses at its TTL — never issue a MySQL RELEASE_LOCK for a
            // lock MySQL never held.
            if ($redis !== null) {
                try {
                    $lua = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
                    $redis->eval($lua, [$lockName, $lockToken], 1);
                } catch (Throwable $e) {
                    // Redis vanished during release; the lock lapses at its TTL.
                }
            }
            return;
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

        // INCR the window counter and (re)apply its TTL atomically in one Lua
        // script, so nothing can interleave between the INCR and the EXPIRE and
        // leave the key without an expiry — a counter that would then never reset
        // and permanently rate-limit the IP. Semantics mirror the previous PHP
        // sequence exactly: set the TTL on the first hit, or whenever it is
        // missing (ttl < 0, e.g. after a PERSIST); and, when penalising, extend
        // the window to 2x once the limit is exceeded.
        $script = <<<'LUA'
            local val = redis.call('incr', KEYS[1])
            if val == 1 or redis.call('ttl', KEYS[1]) < 0 then
                redis.call('expire', KEYS[1], ARGV[1])
            end
            if ARGV[3] == '1' and val > tonumber(ARGV[2]) then
                redis.call('expire', KEYS[1], tonumber(ARGV[1]) * 2)
            end
            return val
            LUA;

        try {
            $count = $redis->eval($script, [$rlKey, $window, $limit, $penalty ? '1' : '0'], 1);
            return (int) $count;
        } catch (Throwable $e) {
            $redis = null;
            return null;
        }
    }

    /**
     * One in-window COUNT for the DB sliding-window limiter, shared by
     * share.php and og.php so their window reads cannot drift.
     *
     * @param PDO $pdo The MySQL connection.
     * @param string $table The request-log table. Interpolated into SQL, so it
     *   MUST be one of the module's own constant table names, never input.
     * @param string $ipHash The salted IP hash the window is keyed on.
     * @param int $window The window length in seconds. Bounded against the DB
     *   clock (NOW()), not a PHP timestamp, so timezone/DST skew can't shift it.
     * @return array{count: int, oldest: ?int} In-window request count, plus the
     *   UNIX time of the oldest still-in-window request (null when the window
     *   is empty) — a caller at the cap regains a slot at oldest + window, the
     *   true sliding reset instant for the X-RateLimit-Reset header.
     * @throws PDOException The caller chooses the failure posture: og.php
     *   fails closed, share.php's in-lock path lets it surface as a 500, and
     *   record_throttled_attempt swallows it (best-effort accounting).
     */
    public static function countDbWindow(PDO $pdo, string $table, string $ipHash, int $window): array
    {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) AS c, UNIX_TIMESTAMP(MIN(created_at)) AS oldest FROM ' . $table
            . ' WHERE ip_hash = ? AND created_at > NOW() - INTERVAL ' . ((int) $window) . ' SECOND'
        );
        $stmt->execute([$ipHash]);
        $row = $stmt->fetch();
        $oldest = $row['oldest'] ?? null;
        return [
            'count'  => (int) $row['c'],
            'oldest' => $oldest !== null ? (int) $oldest : null,
        ];
    }

    /**
     * The DB limiter's write-side accounting, shared by share.php's in-lock
     * path, its lock-contention fallback (record_throttled_attempt), and
     * og.php — previously three hand-synchronized copies. Given the in-window
     * $count the caller just read: INSERT the request while this IP holds at
     * most 2x $max rows (the window keeps reflecting an ongoing flood instead
     * of freezing at the limit), otherwise slide the IP's oldest logged
     * request forward to now — the row count stays bounded while the recovery
     * horizon is pushed out for as long as the abuse continues, mirroring the
     * Redis path's over-limit penalty.
     *
     * Best-effort by contract: each write failure is logged (labelled with
     * $logLabel, e.g. "share request" / "OG request") and never thrown, so
     * accounting can't mask the caller's own response — but it IS surfaced,
     * because losing rows under-counts the window and silently relaxes the
     * cap (schema drift and failed migrations must be visible in the logs).
     *
     * @param PDO $pdo The MySQL connection.
     * @param string $table The request-log table (constant name, never input).
     * @param string $ipHash The salted IP hash the window is keyed on.
     * @param int $count The in-window count the caller read via countDbWindow.
     * @param int $max The rate limit (row cap is 2x this).
     * @param string $logLabel Log noun for failures, e.g. "share request".
     */
    public static function recordDbRequest(PDO $pdo, string $table, string $ipHash, int $count, int $max, string $logLabel): void
    {
        if ($count <= $max * 2) {
            try {
                $ins = $pdo->prepare('INSERT INTO ' . $table . ' (ip_hash) VALUES (?)');
                $ins->execute([$ipHash]);
            } catch (PDOException $e) {
                error_log('Failed to log ' . $logLabel . ': ' . $e->getMessage());
            }
        } else {
            try {
                $slide = $pdo->prepare(
                    'UPDATE ' . $table . ' SET created_at = NOW() '
                    . 'WHERE ip_hash = ? ORDER BY created_at ASC LIMIT 1'
                );
                $slide->execute([$ipHash]);
            } catch (PDOException $e) {
                error_log('Failed to slide ' . $logLabel . ' window: ' . $e->getMessage());
            }
        }
    }
}
