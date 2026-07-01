<?php

declare(strict_types=1);

// Ensure this script can only be run via command line (cron), not over the web
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require_once __DIR__ . '/../../../config.php';

// Retention for the per-IP request-log tables (share + OG). Single source of
// truth for their prune window, replacing the magic 86400s literals below. Must
// stay >= the rate-limit windows in share.php (RATE_LIMIT_WINDOW) and og.php
// (OG_RATE_LIMIT_WINDOW) so a sliding-window count never loses rows it still
// needs; 24h leaves ample margin over the 1h rate windows.
const REQUEST_LOG_PRUNE_WINDOW = 86400; // seconds (24 hours)

/**
 * Deletes matching rows in batches, pausing between batches so concurrent
 * queries and replication can breathe. A missing table (the log tables only
 * exist once share.php has created them) counts as "nothing to prune". Any
 * other error is logged and reported by returning false, never rethrown, so one
 * table's transient failure (a lock-wait timeout or deadlock) can't abort the
 * remaining independent prune steps.
 *
 * @return bool True on success (or a cleanly-skipped missing table), false on error.
 */
function prune_batched(PDO $pdo, string $sql, string $label): bool
{
    try {
        $stmt = $pdo->prepare($sql);
        $total = 0;
        do {
            $stmt->execute();
            $count = $stmt->rowCount();
            $total += $count;
            if ($count > 0) {
                usleep(50000); // 50ms pause to let concurrent queries and replication breathe
            }
        } while ($count === 1000);
        echo 'Pruned ' . $total . ' expired ' . $label . " successfully.\n";
        return true;
    } catch (PDOException $e) {
        if (($e->errorInfo[0] ?? '') === '42S02' || ($e->errorInfo[1] ?? 0) === 1146) {
            echo 'Table for ' . $label . " does not exist yet - skipping.\n";
            return true;
        }
        error_log('Share pruning cron: failed to prune ' . $label . ': ' . $e->getMessage());
        return false;
    }
}

$failed = false;

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ],
    );

    // Each prune is independent: a transient error on one table must not skip the
    // others. The request-log tables feed the rate-limit COUNT queries in
    // share.php/og.php, so leaving them unpruned bloats those queries.
    if (!prune_batched(
        $pdo,
        'DELETE FROM comparebuilds_shares WHERE created_at < NOW() - INTERVAL 180 DAY ORDER BY created_at ASC LIMIT 1000',
        'shares'
    )) {
        $failed = true;
    }
    if (!prune_batched(
        $pdo,
        'DELETE FROM comparebuilds_share_requests WHERE created_at < NOW() - INTERVAL ' . REQUEST_LOG_PRUNE_WINDOW . ' SECOND LIMIT 1000',
        'share requests'
    )) {
        $failed = true;
    }
    if (!prune_batched(
        $pdo,
        'DELETE FROM comparebuilds_og_requests WHERE created_at < NOW() - INTERVAL ' . REQUEST_LOG_PRUNE_WINDOW . ' SECOND LIMIT 1000',
        'OG requests'
    )) {
        $failed = true;
    }
} catch (Throwable $e) {
    // A connection failure (or anything else around the DB prunes) aborts them,
    // but the filesystem cache_og cleanup below can still run independently.
    error_log('Share pruning cron: database step failed: ' . $e->getMessage());
    $failed = true;
}

// Prune cache_og image files older than 180 days. Filesystem-only, so it runs
// even when the database was unreachable above.
try {
    $cacheDir = __DIR__ . '/../../../cache_og';
    if (is_dir($cacheDir)) {
        $expireTime = time() - (180 * 86400);
        $iterator = new DirectoryIterator($cacheDir);
        $imgCount = 0;
        foreach ($iterator as $fileinfo) {
            if ($fileinfo->isFile() && $fileinfo->getMTime() < $expireTime) {
                @unlink($fileinfo->getPathname());
                $imgCount++;
            }
        }
        echo 'Pruned ' . $imgCount . " expired OG cached images successfully.\n";
    }
} catch (Throwable $e) {
    error_log('Share pruning cron: cache_og cleanup failed: ' . $e->getMessage());
    $failed = true;
}

exit($failed ? 1 : 0);
