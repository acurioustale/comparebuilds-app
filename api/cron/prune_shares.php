<?php

declare(strict_types=1);

// Ensure this script can only be run via command line (cron), not over the web
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

// Retention for the per-IP request-log tables (share + OG). Single source of
// truth for their prune window, replacing the magic 86400s literals below. Must
// stay >= the rate-limit windows in share.php (RATE_LIMIT_WINDOW) and og.php
// (OG_RATE_LIMIT_WINDOW) so a sliding-window count never loses rows it still
// needs; 24h leaves ample margin over the 1h rate windows.
const REQUEST_LOG_PRUNE_WINDOW = 86400; // seconds (24 hours)

// Defense-in-depth cap on how many share rows a single run may delete. The shares
// prune treats "no live layout matches this hash" as superseded, so a bug that
// wrongly marks a *current* layout superseded (a mis-generated manifest, a botched
// migration, a manual DB edit) could otherwise mass-delete live builds in one run.
// Steady-state expiry is a trickle — only shares crossing BOTH 180-day thresholds
// on a given day — so this ceiling sits far above normal volume: hitting it means
// something is wrong. On reaching it the prune stops early and logs loudly; the
// remaining rows simply retry on the next daily run (shares only accumulate,
// recoverably), buying an operator time to notice before more are removed. The
// request-log prunes are uncapped: they legitimately delete large volumes and
// carry no data-loss risk.
const MAX_SHARE_PRUNE_PER_RUN = 5000;

/**
 * Deletes matching rows in batches, pausing between batches so concurrent
 * queries and replication can breathe. A missing table (the log tables only
 * exist once share.php has created them) counts as "nothing to prune". Any
 * other error is logged and reported by returning false, never rethrown, so one
 * table's transient failure (a lock-wait timeout or deadlock) can't abort the
 * remaining independent prune steps.
 *
 * @param int|null $maxTotal Stop after deleting at least this many rows and log
 *   loudly (a per-run safety cap); null leaves the prune uncapped.
 * @return bool True on success (or a cleanly-skipped missing table), false on error.
 */
function prune_batched(PDO $pdo, string $sql, string $label, ?int $maxTotal = null): bool
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
            if ($maxTotal !== null && $total >= $maxTotal) {
                error_log(
                    'Share pruning cron: ' . $label . ' hit the per-run safety cap of '
                    . $maxTotal . ' rows and stopped early. This is far above normal '
                    . 'steady-state volume — verify layout supersession is correct '
                    . '(a mis-superseded current layout would delete live builds) before '
                    . 'it drains further. Remaining rows retry next run.'
                );
                echo 'Pruned ' . $total . ' expired ' . $label . " (per-run safety cap reached).\n";
                return true;
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

// When included for unit testing (with PRUNE_SHARES_NO_MAIN defined), stop here:
// everything above is pure (the batched-delete helper) and testable; everything
// below needs config.php and a live database connection.
if (defined('PRUNE_SHARES_NO_MAIN')) {
    return;
}

require_once __DIR__ . '/../../../config.php';

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
    //
    // Safety valve, symmetric to reconcile_layout_history()'s empty-manifest
    // guard: the shares prune below treats "no live layout matches this hash" as
    // superseded, so if the layout-history table has *zero* live layouts (e.g.
    // ensure_schema never reconciled a manifest, or the table was truncated) it
    // would consider every layout stale and delete every idle share — including
    // ones on the current layout. Skipping is the safe direction (shares only
    // accumulate, recoverably); over-deleting is not. A missing table counts as
    // zero live layouts. Any error here is logged and also skips, never deletes.
    $liveLayouts = null;
    try {
        $liveLayouts = (int) $pdo->query(
            'SELECT COUNT(*) FROM comparebuilds_layout_history WHERE superseded_at IS NULL'
        )->fetchColumn();
    } catch (PDOException $e) {
        if (($e->errorInfo[0] ?? '') === '42S02' || ($e->errorInfo[1] ?? 0) === 1146) {
            $liveLayouts = 0; // table not created yet — treat as no known-live layouts
        } else {
            error_log('Share pruning cron: live-layout count failed: ' . $e->getMessage());
            $failed = true;
        }
    }

    // Supersession-gated retention. A share is deleted only when ALL hold:
    //   1. unused for the retention window (last_accessed old enough), AND
    //   2. its layout is NOT currently live — i.e. no comparebuilds_layout_history
    //      row with superseded_at IS NULL matches its layout_hash (a live layout is
    //      never pruned, no matter how old); AND
    //   3. the layout has been superseded for at least the window too, so the whole
    //      unused period falls *after* supersession. Two non-live cases differ:
    //      a share with NO layout_hash (legacy, pre-tracking) has no supersession
    //      date and ages out on the unused clock alone; a share WITH a layout_hash
    //      but NO history row is treated as unknown and KEPT — never epoch-pruned.
    //      That is the per-hash mirror of the zero-live-layouts valve: a manifest
    //      that omits a still-current layout leaves its hash without a live history
    //      row, and epoch-superseding it (the old COALESCE default) would delete
    //      that live layout's idle shares. Over-retaining is the safe direction.
    //      The correlated subqueries read comparebuilds_layout_history (a different
    //      table), which is permitted while deleting from _shares.
    if ($liveLayouts === 0) {
        error_log(
            'Share pruning cron: layout-history has zero live layouts — skipping '
            . 'the shares prune to avoid deleting current builds. Check that '
            . 'ensure_schema.php reconciled api/current_layouts.json.'
        );
        echo "No live layouts known — skipping shares prune (safety valve).\n";
    } elseif ($liveLayouts !== null && !prune_batched(
        $pdo,
        'DELETE FROM comparebuilds_shares'
        . ' WHERE last_accessed < NOW() - INTERVAL 180 DAY'
        . '   AND NOT EXISTS ('
        . '     SELECT 1 FROM comparebuilds_layout_history h'
        . '     WHERE h.layout_hash = comparebuilds_shares.layout_hash AND h.superseded_at IS NULL'
        . '   )'
        . '   AND ('
        . '     comparebuilds_shares.layout_hash IS NULL'
        . '     OR EXISTS ('
        . '       SELECT 1 FROM comparebuilds_layout_history h2'
        . '       WHERE h2.layout_hash = comparebuilds_shares.layout_hash'
        . '         AND h2.superseded_at < NOW() - INTERVAL 180 DAY'
        . '     )'
        . '   )'
        . ' LIMIT 1000',
        'shares',
        MAX_SHARE_PRUNE_PER_RUN
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
