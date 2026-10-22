<?php
// Small API doubles for isolated security and persistence checks. Real WordPress is tested separately.
define('ABSPATH', __DIR__ . '/');
define('HOUR_IN_SECONDS', 3600);
define('DAY_IN_SECONDS', 86400);
$GLOBALS['options'] = array();
$GLOBALS['transients'] = array();
$GLOBALS['requests'] = array();
$GLOBALS['filters'] = array();
function add_filter($name, $callback, $priority = 10, $accepted = 1) { $GLOBALS['filters'][$name][] = $callback; }
function add_action($name, $callback, $priority = 10, $accepted = 1) { add_filter($name, $callback, $priority, $accepted); }
function get_option($key, $default = false) { return isset($GLOBALS['options'][$key]) ? $GLOBALS['options'][$key] : $default; }
function add_option($key, $value, $deprecated = '', $autoload = null) { if (isset($GLOBALS['options'][$key])) return false; $GLOBALS['options'][$key] = $value; return true; }
function update_option($key, $value, $autoload = null) { $GLOBALS['options'][$key] = $value; }
function delete_option($key) { unset($GLOBALS['options'][$key]); }
function get_site_transient($key) { return isset($GLOBALS['transients'][$key]) ? $GLOBALS['transients'][$key] : false; }
function set_site_transient($key, $value, $ttl) { $GLOBALS['transients'][$key] = $value; }
function delete_site_transient($key) { unset($GLOBALS['transients'][$key]); }
function wp_generate_uuid4() { return '73418cab-0dda-410d-85fd-c3f1d553fd5d'; }
function plugin_basename($file) { return 'entitle-example/' . basename($file); }
function home_url() { return 'https://example.test'; }
function wp_parse_url($url) { return parse_url($url); }
function wp_json_encode($value) { return json_encode($value); }
function wp_remote_request($url, $args) { $GLOBALS['requests'][] = array($url, $args); return $GLOBALS['reply']; }
function wp_remote_retrieve_response_code($reply) { return $reply['response']['code']; }
function wp_remote_retrieve_body($reply) { return $reply['body']; }
function is_wp_error($value) { return $value instanceof WP_Error; }
function download_url($url) { $GLOBALS['download_calls'][] = $url; $GLOBALS['download_headers'] = $GLOBALS['test_client']->package_headers(array('headers' => array()), $url); return __FILE__; }
function wp_delete_file($file) { $GLOBALS['deleted_download'] = $file; }
function wp_kses_post($value) { return strip_tags($value, '<p><a><strong>'); }
class WP_Error { public $code; public $message; function __construct($code, $message) { $this->code = $code; $this->message = $message; } function get_error_message() { return $this->message; } function get_error_code() { return $this->code; } }
class Entitle_Guard_Error extends RuntimeException {}
function current_user_can($capability) { return !empty($GLOBALS['can_manage']) && $capability === 'manage_options'; }
function wp_die($message, $title = '', $args = array()) { throw new Entitle_Guard_Error($message, isset($args['response']) ? $args['response'] : 0); }
function check_admin_referer($action) { if ($action !== 'entitle_license' || empty($GLOBALS['valid_nonce'])) throw new Entitle_Guard_Error('Invalid nonce', 403); }
function expect_guard($callback, $message) {
    $caught = null;
    try { $callback(); } catch (Entitle_Guard_Error $error) { $caught = $error; }
    // Assertions stay outside the catch: their failures cannot satisfy the guard test.
    check($caught instanceof Entitle_Guard_Error && $caught->getCode() === 403 && $caught->getMessage() === $message, 'Expected exact capability/nonce guard: ' . $message);
}
function check($value, $message) { if (!$value) throw new Exception($message); }
$client_path = dirname(__DIR__) . '/entitle-example/class-entitle-client.php';
check(file_exists($client_path), 'WordPress client implementation must exist');
require $client_path;
$client = new Entitle_Client(dirname(__DIR__) . '/entitle-example/entitle-example.php', '1.0.0');
$client->register();
$GLOBALS['test_client'] = $client;
check(isset($GLOBALS['filters']['http_request_args']), 'package authentication must register outside admin');
check($client->installation_id() === $client->installation_id(), 'installation UUID must persist');
$GLOBALS['reply'] = array('response' => array('code' => 200), 'body' => json_encode(array('token' => 'fixture_token', 'installationId' => $client->installation_id())));
check(true === $client->activate('fixture_license'), 'activation succeeds');
check(strpos($GLOBALS['requests'][0][0], 'fixture_license') === false, 'key must stay out of URLs');
check(get_option('entitle_token') === 'fixture_token', 'activation token persists');
check(!get_option('entitle_license_key'), 'raw license key is not stored');
$base = $client->api_base();
$package = $base . '/packages/fixture-release';
$args = $client->package_headers(array('headers' => array(), 'redirection' => 5), $package);
check(!isset($args['headers']['Authorization']), 'unattributed HTTP requests must not receive this plugin token');
foreach (array($package . '?token=no', $package . '#fragment', $package . '/extra', $package . '%2fextra', str_replace('licenses.example.com', 'licenses.example.com.attacker.test', $package), str_replace('/api/v1', '/api/v10', $package), $base . '/packages/', $base . '/packages/../evil', str_replace('://', '://fixture_token@', $package), str_replace('licenses.example.com', 'attacker.test', $package), $base . '/updates/entitle-example') as $url) {
    check(!isset($client->package_headers(array('headers' => array()), $url)['headers']['Authorization']), 'Bearer must not reach unrelated URL: ' . $url);
}
$metadata = array('name' => 'Example', 'slug' => 'entitle-example', 'version' => '1.1.0', 'download_url' => $package, 'requires' => '6.0', 'requires_php' => '7.4', 'min_free' => '2.0', 'tested' => '6.8', 'sections' => array('changelog' => '<p>Fixture</p>'), 'sha256' => str_repeat('a', 64));
$GLOBALS['reply']['body'] = json_encode($metadata);
check($client->metadata(true)['version'] === '1.1.0', 'valid metadata is available');
$GLOBALS['reply'] = new WP_Error('network', 'Sensitive provider details fixture_token');
check($client->metadata(true)['version'] === '1.1.0', 'outage preserves cached offer');
$offer = $client->updates((object) array('checked' => array('entitle-example/entitle-example.php' => '1.0.0')));
check(isset($offer->response['entitle-example/entitle-example.php']), 'incompatible Free version must not hide update');
check($offer->response['entitle-example/entitle-example.php']->min_free === '2.0', 'minimum Free version retained');
$GLOBALS['reply'] = array('response' => array('code' => 403), 'body' => '{"error":{"message":"fixture_token secret"}}');
check($client->metadata(true) === false, 'explicit entitlement denial clears cached offer');
check(get_option('entitle_token') === 'fixture_token', 'denial does not disable or delete installed activation');
$GLOBALS['reply']['response']['code'] = 200;
$metadata['download_url'] = 'https://attacker.test/package.zip';
$GLOBALS['reply']['body'] = json_encode($metadata);
check($client->metadata(true) === false, 'reject untrusted package origin');
$metadata['download_url'] = $package;
$metadata['min_free'] = array('invalid');
$GLOBALS['reply']['body'] = json_encode($metadata);
check($client->metadata(true) === false, 'malformed optional compatibility metadata must be rejected');
$metadata['download_url'] = $package;
$metadata['min_free'] = null;
$metadata['sha256'] = hash_file('sha256', __FILE__);
$GLOBALS['reply']['body'] = json_encode($metadata);
$client->metadata(true);
$GLOBALS['wp_version'] = '6.8';
check($client->compatibility_error(array('min_free' => '0.0.0')) === '', 'zero minimum Free version must not require a Free plugin');
// Hook attribution must prevent both fallback for this plugin and interception of others.
$own_hook = array('plugin' => 'entitle-example/entitle-example.php');
$foreign_hook = array('plugin' => 'another-plugin/pro.php');
$before_requests = count($GLOBALS['requests']);
check($client->download(false, $package, null, $foreign_hook) === false, 'foreign plugin must retain its own download handler');
check(count($GLOBALS['requests']) === $before_requests, 'foreign plugin must not trigger licensing requests');
check($client->download(false, $base . '/packages/other-product-release') === false, 'unattributed other-product package remains untouched');
$sentinel = new WP_Error('other_handler', 'Keep prior handler result');
check($client->download($sentinel, $package, null, $foreign_hook) === $sentinel, 'foreign handler reply is preserved');
check($client->download(false, 'https://unrelated.test/plugin.zip') === false, 'unattributed unrelated download remains untouched');
$blocked = $client->download(__FILE__, $package, null, $own_hook);
check(is_wp_error($blocked) && $blocked->get_error_code() === 'entitle_package', 'own plugin cannot accept an unverified prior-handler file');
check($client->download($sentinel, $package, null, $own_hook) === $sentinel, 'prior handler error remains an error');
update_option('entitle_api_url', 'https://changed.example.test/api/v1');
$blocked = $client->download(false, $package, null, $own_hook);
check(is_wp_error($blocked) && $blocked->get_error_code() === 'entitle_package', 'own cached package must fail closed after API endpoint change');
update_option('entitle_api_url', 'http://insecure.example.test/api/v1');
$blocked = $client->download(false, $package, null, $own_hook);
check(is_wp_error($blocked) && $blocked->get_error_code() === 'entitle_package', 'own package must fail closed with invalid service configuration');
delete_option('entitle_api_url');
$GLOBALS['wp_version'] = '6.8';
check($client->download(false, $package) === __FILE__, 'download verifies actual SHA-256 bytes');
check($GLOBALS['download_headers']['headers']['Authorization'] === 'Bearer fixture_token' && $GLOBALS['download_headers']['redirection'] === 0, 'owned download receives scoped Bearer without redirects');
check(!isset($client->package_headers(array('headers' => array()), $package)['headers']['Authorization']), 'download authorization scope ends after transport returns');
$metadata['requires_php'] = '99.0';
$GLOBALS['reply']['body'] = json_encode($metadata);
$client->metadata(true);
check(is_wp_error($client->download(false, $package)), 'incompatible PHP must block installation without hiding metadata');
$metadata['requires_php'] = '7.4';
$metadata['min_free'] = '9.0';
$GLOBALS['reply']['body'] = json_encode($metadata);
$client->metadata(true);
check(is_wp_error($client->download(false, $package)), 'incompatible Free version must block installation');
$metadata['min_free'] = null;
$metadata['sha256'] = str_repeat('b', 64);
$GLOBALS['reply']['body'] = json_encode($metadata);
$client->metadata(true);
check(is_wp_error($client->download(false, $package)), 'checksum mismatch must block package installation');
check($GLOBALS['deleted_download'] === __FILE__, 'checksum mismatch cleans the downloaded temporary file');
$GLOBALS['reply'] = new WP_Error('network', 'secret');
check(is_wp_error($client->deactivate()), 'outage during deactivation retains activation');
check(get_option('entitle_token') === 'fixture_token', 'failed deactivation retains token for retry');
$GLOBALS['reply'] = array('response' => array('code' => 200), 'body' => '{"ok":true}');
check($client->deactivate() === true, 'deactivation succeeds');
check(!get_option('entitle_token'), 'deactivation clears token');
check($client->installation_id() === '73418cab-0dda-410d-85fd-c3f1d553fd5d', 'deactivation must not change installation UUID');
$before_requests = count($GLOBALS['requests']);
$GLOBALS['can_manage'] = false;
expect_guard(array($client, 'save_license'), 'Access denied.');
$GLOBALS['can_manage'] = true;
$GLOBALS['valid_nonce'] = false;
expect_guard(array($client, 'save_license'), 'Invalid nonce');
check(count($GLOBALS['requests']) === $before_requests, 'capability and nonce rejection must precede licensing requests');
echo "PASS WordPress client security, caching, activation and update checks\n";
