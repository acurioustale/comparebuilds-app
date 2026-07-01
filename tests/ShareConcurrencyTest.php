<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ShareConcurrencyTest extends TestCase
{
    public function testStoreShareThrowsServerBusyWhenGetLockFails(): void
    {
        $stmt = $this->createMock(PDOStatement::class);
        $stmt->expects($this->once())
             ->method('execute')
             ->willReturn(true);
        $stmt->expects($this->once())
             ->method('fetchColumn')
             ->willReturn(0); // GET_LOCK failed / timed out

        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())
            ->method('prepare')
            ->with('SELECT GET_LOCK(?, 1)')
            ->willReturn($stmt);

        try {
            store_share($pdo, ['classId' => 1, 'specId' => 1, 'builds' => ['AA', 'BB']], 'dummy-ip-hash');
            $this->fail('Expected ShareException was not thrown');
        } catch (ShareException $e) {
            $this->assertSame(503, $e->httpStatus);
            $this->assertSame('Server busy — please try again', $e->getMessage());
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
        // First check returns false (not found); second check (after insert race) returns the stored data
        $checkStmt->method('fetch')->willReturnOnConsecutiveCalls(false, ['data' => $stored]);

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
            public function incr($key)
            {
                $this->count++;
                return 1;
            }
            public function expire($key, $ttl)
            {
                return true;
            }
            public function del($key)
            {
                $this->unlocked = true;
                return true;
            }
            public function eval($script, $args, $numKeys)
            {
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
}
