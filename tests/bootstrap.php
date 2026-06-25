<?php

declare(strict_types=1);

// Load the share API's pure helpers (validation, id check, ip hashing) without
// running the request handler. The SHARE_API_NO_MAIN guard in share.php returns
// before the DB connection and routing, so no config.php or database is needed.
define('SHARE_API_NO_MAIN', true);
require_once __DIR__ . '/../api/share.php';
