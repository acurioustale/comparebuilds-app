<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Guards the schema DDL that ensure_share_schema() issues. Runs against a PDO
 * mock that records every exec(), so no database is needed.
 */
final class ShareSchemaTest extends TestCase
{
    /**
     * Every statement ensure_share_schema() executes, in order, with the
     * information_schema collation lookup answered by $collation (false models a
     * lookup that returned no row).
     *
     * @return string[]
     */
    private function capturedDdl(string|false $collation): array
    {
        $statements = [];

        $lookup = $this->createStub(PDOStatement::class);
        $lookup->method('fetchColumn')->willReturn($collation);

        $pdo = $this->createStub(PDO::class);
        $pdo->method('query')->willReturnCallback(function (string $sql) use ($lookup, &$statements) {
            // Only the collation lookup is expected to go through query(); anything
            // else would silently receive this stub's canned answer.
            $this->assertStringContainsString('information_schema.COLUMNS', $sql);
            $statements[] = $sql;
            return $lookup;
        });
        $pdo->method('exec')->willReturnCallback(function (string $sql) use (&$statements) {
            $statements[] = $sql;
            return 0;
        });

        ensure_share_schema($pdo);
        return $statements;
    }

    private const MODIFY_RE = '/MODIFY COLUMN layout_hash VARCHAR\(16\) COLLATE utf8mb4_bin/';

    /**
     * comparebuilds_layout_history.layout_hash is utf8mb4_bin, so the shares
     * column it joins against must be too. A mismatch makes every prune
     * subquery fail with error 1267 and retention silently stops pruning.
     */
    public function testLayoutHashColumnsShareTheBinaryCollation(): void
    {
        $ddl = implode("\n", $this->capturedDdl('utf8mb4_general_ci'));

        $this->assertMatchesRegularExpression(
            '/ADD COLUMN IF NOT EXISTS\s+layout_hash\s+VARCHAR\(16\)\s+COLLATE utf8mb4_bin/',
            $ddl,
            'shares.layout_hash must be added with COLLATE utf8mb4_bin'
        );
        $this->assertMatchesRegularExpression(
            '/layout_hash\s+VARCHAR\(16\) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY/',
            $ddl,
            'layout_history.layout_hash must stay utf8mb4_bin'
        );
    }

    /** A deployment still on the old case-insensitive collation gets repaired. */
    public function testRepairsAWrongLayoutHashCollation(): void
    {
        $this->assertMatchesRegularExpression(
            self::MODIFY_RE,
            implode("\n", $this->capturedDdl('utf8mb4_general_ci'))
        );
    }

    /**
     * The repair must NOT run once the column is already correct. MariaDB
     * rebuilds the table (and idx_layout_accessed) for a collation MODIFY even
     * when the definition is unchanged, so an ungated repair would take a
     * metadata lock against live share traffic on every deploy, forever.
     */
    public function testSkipsTheRepairWhenTheCollationIsAlreadyCorrect(): void
    {
        $this->assertDoesNotMatchRegularExpression(
            self::MODIFY_RE,
            implode("\n", $this->capturedDdl('utf8mb4_bin'))
        );
    }

    /**
     * An unreadable collation (no information_schema row) repairs anyway: a
     * needless rebuild is recoverable, a silently broken join is not.
     */
    public function testRepairsWhenTheCollationCannotBeRead(): void
    {
        $this->assertMatchesRegularExpression(
            self::MODIFY_RE,
            implode("\n", $this->capturedDdl(false))
        );
    }
}
