<?php
/**
 * Plugin Name: Doublesharp Entitle example
 * Description: Native WordPress activation and authenticated update example. Installed features never depend on remote license checks.
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Update URI: https://entitle.example/entitle-example
 * License: MIT
 * License URI: https://opensource.org/license/mit
 */
// Step 1: load only inside WordPress, then include the reusable update client.
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/class-entitle-client.php';
// Step 2: identify this plugin/version and register native update and settings hooks.
$GLOBALS['entitle_client'] = new Entitle_Client(__FILE__, '1.0.0');
// Register first. Place real product PHP/WP/Free feature compatibility gates below this line.
$GLOBALS['entitle_client']->register();
// Step 3: register installed functionality independently of update-license status.
/**
 * Render [entitle_example] without contacting the licensing service.
 *
 * @return string Example content that remains available after update access expires.
 */
add_shortcode('entitle_example', function () { return 'Doublesharp Entitle installed features are available.'; });
