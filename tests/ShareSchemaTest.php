<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Guards the schema DDL that ensure_share_schema() issues. Runs against a PDO
 * mock that records every exec(), so no database is needed.
 */
final class ShareSchemaTest extends TestCase
{
    /** @return string[] Every statement ensure_share_schema() executes, in order. */
    private function capturedDdl(): array
    {
        $statements = [];
        $pdo        = $this->createStub(PDO::class);
        $pdo->method('exec')->willReturnCallback(function (string $sql) use (&$statements) {
            $statements[] = $sql;
            return 0;
        });
        ensure_share_schema($pdo);
        return $statements;
    }

    /**
     * comparebuilds_layout_history.layout_hash is utf8mb4_bin, so the shares
     * column it joins against must be too. A mismatch makes every prune
     * subquery fail with error 1267 and retention silently stops pruning.
     */
    public function testLayoutHashColumnsShareTheBinaryCollation(): void
    {
        $ddl = implode("\n", $this->capturedDdl());

        $this->assertMatchesRegularExpression(
            '/ADD COLUMN IF NOT EXISTS\s+layout_hash\s+VARCHAR\(16\)\s+COLLATE utf8mb4_bin/',
            $ddl,
            'shares.layout_hash must be added with COLLATE utf8mb4_bin'
        );
        $this->assertMatchesRegularExpression(
            '/MODIFY COLUMN layout_hash VARCHAR\(16\) COLLATE utf8mb4_bin/',
            $ddl,
            'deployments migrated before the COLLATE was added must be repaired'
        );
        $this->assertMatchesRegularExpression(
            '/layout_hash\s+VARCHAR\(16\) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY/',
            $ddl,
            'layout_history.layout_hash must stay utf8mb4_bin'
        );
    }
}
