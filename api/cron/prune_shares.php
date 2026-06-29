<?php

declare(strict_types=1);

// Ensure this script can only be run via command line (cron), not over the web
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('CLI only');
}

require_once __DIR__ . '/../../../config.php';

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

    // Prune shares older than 180 days (~6 months)
    $stmt = $pdo->prepare('DELETE FROM comparebuilds_shares WHERE created_at < NOW() - INTERVAL 180 DAY');
    $stmt->execute();

    echo 'Pruned ' . $stmt->rowCount() . " expired shares successfully.\n";
} catch (Throwable $e) {
    error_log('Share pruning cron failed: ' . $e->getMessage());
    exit(1);
}
