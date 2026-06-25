<?php

// PHP CS Fixer config. The share API is already PSR-12, so this just keeps it
// that way. config.php.example is a credentials template, not shipped code, so
// it is left out of the finder (php -l still syntax-checks it in CI).

$finder = PhpCsFixer\Finder::create()
    ->in([__DIR__ . '/api', __DIR__ . '/tests'])
    ->name('*.php');

return (new PhpCsFixer\Config())
    ->setRules(['@PSR12' => true])
    ->setFinder($finder);
