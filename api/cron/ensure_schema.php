<?php

declare(strict_types=1);

// Ensure this script can only be run via command line (cron/migration), not over the web
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require_once __DIR__ . '/../../../config.php';
define('SHARE_API_NO_MAIN', true);
require_once __DIR__ . '/../share.php';

try {
    $pdo = get_db_connection();
    ensure_share_schema($pdo);
    echo "Schema ensured successfully.\n";

    // Reconcile the layout-history table from the manifest deployed alongside the
    // API (api/current_layouts.json, resolved as ../current_layouts.json from
    // api/cron/). This is what lets the prune job tell a superseded layout from a
    // current one. A missing or unusable manifest is deliberately non-fatal:
    // load_current_layouts() returns null and reconcile is skipped, leaving the
    // history table untouched rather than risking a mass supersession.
    $manifest = load_current_layouts(__DIR__ . '/../current_layouts.json');
    if ($manifest === null) {
        echo "No current_layouts.json manifest found — skipping layout reconciliation.\n";
    } else {
        reconcile_layout_history($pdo, $manifest);
        echo 'Reconciled ' . count($manifest) . " current layout hashes.\n";
    }
} catch (Throwable $e) {
    error_log('Schema migration failed: ' . $e->getMessage());
    exit(1);
}
