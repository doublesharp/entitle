<?php
// Run only through wp eval-file in a disposable real WordPress installation.
if (!defined('WP_CLI') || !WP_CLI || getenv('ENTITLE_INTEGRATION') !== '1') { throw new RuntimeException('Disposable WP-CLI integration only.'); }
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
require dirname(__DIR__) . '/entitle-example/class-entitle-client.php';
function de_hook_assert($condition, $message) { if (!$condition) { WP_CLI::error($message); } }
define('ENTITLE_ALLOW_HTTP', true);
define('WP_TEMP_DIR', '/wp-tmp');
$base = 'http://host.docker.internal:3213/api/v1/tenants/primary';
update_option('entitle_api_url', $base);
update_option('entitle_token', 'fixture_token');
$client = new Entitle_Client(WP_PLUGIN_DIR . '/entitle-example/entitle-example.php', '1.0.0');
$client->register();
$own = array('plugin' => 'entitle-example/entitle-example.php');
$foreign = array('plugin' => 'other-plugin/pro.php');
$package = $base . '/packages/fixture';
$metadata = array('slug' => 'entitle-example', 'version' => '1.1.0', 'download_url' => $package, 'requires' => '6.0', 'requires_php' => '7.4', 'min_free' => '0.0.0', 'sha256' => hash('sha256', 'Doublesharp Entitle hook fixture'));
$cache = 'entitle_meta_' . md5($base . '|entitle-example|fixture_token');
set_site_transient($cache, array('checked_at' => time(), 'data' => $metadata), DAY_IN_SECONDS);
// Only this disposable fixture host and port are permitted through safe HTTP checks.
add_filter('http_request_host_is_external', function ($external, $host) { return $host === 'host.docker.internal' ? true : $external; }, 10, 2);
add_filter('http_allowed_safe_ports', function ($ports) { $ports[] = 3213; return $ports; });
$upgrader = new WP_Upgrader(new Automatic_Upgrader_Skin());
$file = $upgrader->download_package($package, false, $own);
de_hook_assert(!is_wp_error($file) && is_file($file) && hash_file('sha256', $file) === $metadata['sha256'], 'Real owned download must authenticate and verify its bytes.' . (is_wp_error($file) ? ' [' . $file->get_error_code() . ': ' . $file->get_error_message() . ']' : ''));
wp_delete_file($file);
$args = apply_filters('http_request_args', array('headers' => array()), $package);
de_hook_assert(empty($args['headers']['Authorization']), 'Token scope must end after owned download.');
// A later handler must still receive foreign or unattributed packages, even on this service.
$sentinel = function ($reply) { return $reply === false ? 'other-handler-result' : $reply; };
add_filter('upgrader_pre_download', $sentinel, 20);
de_hook_assert($upgrader->download_package($base . '/packages/other-release', false, $foreign) === 'other-handler-result', 'Foreign plugin handler must remain in control.');
de_hook_assert($upgrader->download_package($base . '/packages/other-release') === 'other-handler-result', 'Unattributed other-product download must remain untouched.');
remove_filter('upgrader_pre_download', $sentinel, 20);
update_option('entitle_api_url', 'https://changed.example.test/api/v1');
$result = $upgrader->download_package($package, false, $own);
de_hook_assert(is_wp_error($result) && $result->get_error_code() === 'entitle_package', 'Changed endpoint must stop core fallback.');
update_option('entitle_api_url', 'http://invalid.example.test?bad=config');
$result = $upgrader->download_package($package, false, $own);
de_hook_assert(is_wp_error($result) && $result->get_error_code() === 'entitle_package', 'Invalid configuration must stop core fallback.');
$earlier = function () { return __FILE__; };
add_filter('upgrader_pre_download', $earlier, 5);
$result = $upgrader->download_package($package, false, $own);
de_hook_assert(is_wp_error($result) && $result->get_error_code() === 'entitle_package', 'Earlier handler file must not bypass own checksum verification.');
remove_filter('upgrader_pre_download', $earlier, 5);
delete_site_transient($cache);
delete_option('entitle_token');
delete_option('entitle_api_url');
WP_CLI::success('Real WordPress upgrader: authenticated SHA-256 download, token scope, foreign handler, unattributed package, changed/invalid endpoint and prior-file guards passed.');
