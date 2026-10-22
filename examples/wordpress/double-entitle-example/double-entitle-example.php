<?php
/**
 * Plugin Name: Double Entitle example
 * Description: Native WordPress activation and authenticated update example. Installed features never depend on remote license checks.
 * Version: 1.0.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Update URI: https://double-entitle.example/double-entitle-example
 * License: MIT
 * License URI: https://opensource.org/license/mit
 */
if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/class-double-entitle-client.php';
$GLOBALS['double_entitle_client'] = new Double_Entitle_Client(__FILE__, '1.0.0');
// Register first. Place real product PHP/WP/Free feature compatibility gates below this line.
$GLOBALS['double_entitle_client']->register();
// This harmless installed feature has no dependency on license or service availability.
add_shortcode('double_entitle_example', function () { return 'Double Entitle installed features are available.'; });
