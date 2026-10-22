<?php
/**
 * Run with: wp --user=admin eval-file /workspace/scripts/wordpress-integration.php check
 * Local development only. No HTTP or upgrader mocks. See docs/wordpress.md.
 */
if (!defined('WP_CLI') || !WP_CLI) { throw new RuntimeException('Run this file through WP-CLI.'); }
if (getenv('ENTITLE_INTEGRATION') !== '1') { WP_CLI::error('Set ENTITLE_INTEGRATION=1 for this disposable test installation.'); }
$mode = isset($args[0]) ? $args[0] : 'check';
if ($mode === 'automatic' && !defined('DOING_CRON')) { define('DOING_CRON', true); }
if (!in_array($mode, array('check', 'manual', 'automatic', 'outage', 'deactivate'), true)) { WP_CLI::error('Mode must be check, manual, automatic, outage or deactivate.'); }
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
require_once ABSPATH . 'wp-admin/includes/update.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
require_once ABSPATH . 'wp-admin/includes/screen.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/list-table.php';
function de_assert($condition, $message) { if (!$condition) { WP_CLI::error($message); } }
function de_result($result, $message) { de_assert(!is_wp_error($result) && $result !== false && $result !== null, $message . (is_wp_error($result) ? ' [' . $result->get_error_code() . ']' : '')); }
de_assert(current_user_can('update_plugins'), 'Run WP-CLI with --user=admin or an administrator ID.');
de_assert(isset($GLOBALS['entitle_client']), 'Activate entitle-example before running this script.');
$client = $GLOBALS['entitle_client'];
$plugin = 'entitle-example/entitle-example.php';
$id = $client->installation_id();
if ($mode === 'outage') {
    $token = get_option('entitle_token');
    $probe = wp_remote_get($client->api_base() . '/catalog', array('timeout' => 3, 'redirection' => 0));
    de_assert(is_wp_error($probe), 'Outage test requires the local licensing relay to be stopped.');
    de_assert(is_array($client->metadata(true)), 'Temporary outage discarded cached metadata.');
    de_assert($token && hash_equals($token, get_option('entitle_token')) && $client->installation_id() === $id, 'Outage lost activation state.');
    de_assert(strpos(do_shortcode('[entitle_example]'), 'available') !== false, 'Installed feature stopped during service outage.');
    WP_CLI::success('Real HTTP outage preserves cached metadata, activation UUID and installed features.');
    return;
}

if ($mode === 'deactivate') {
    de_result($client->deactivate(), 'License deactivation failed');
    delete_option('entitle_integration_delayed_package');
    de_assert($client->installation_id() === $id, 'Deactivation changed installation UUID.');
    de_assert(strpos(do_shortcode('[entitle_example]'), 'available') !== false, 'Installed feature stopped after deactivation.');
    WP_CLI::success('License deactivated; installation UUID and installed features preserved.');
    return;
}
$key = getenv('ENTITLE_TEST_KEY');
if ($key) {
    de_result($client->activate($key), 'Activation failed');
    $first = get_option('entitle_token');
    de_result($client->activate($key), 'Idempotent activation failed');
    de_assert(hash_equals($first, get_option('entitle_token')), 'Activation retry changed its token.');
}
de_assert(get_option('entitle_token'), 'Provide ENTITLE_TEST_KEY or activate a local fixture license in Settings.');
de_assert($client->installation_id() === $id, 'Activation changed installation UUID.');
$metadata = $client->metadata(true);
de_assert(is_array($metadata), 'No update metadata. Publish a newer release for this local product.');
wp_clean_plugins_cache();
wp_update_plugins();
$transient = get_site_transient('update_plugins');
de_assert(isset($transient->response[$plugin]), 'Real wp_update_plugins did not retain the update offer.');
$offer = $transient->response[$plugin];
de_assert($offer->new_version === $metadata['version'], 'Update version differs from API metadata.');
de_assert(strpos($offer->package, '?') === false && strpos($offer->package, get_option('entitle_token')) === false, 'Package URL contains credentials.');
$info = plugins_api('plugin_information', (object) array('slug' => 'entitle-example'));
de_assert(!is_wp_error($info) && $info->version === $metadata['version'], 'Real plugins_api returned wrong plugin information.');
set_current_screen('plugins');
ob_start();
wp_plugin_update_row($plugin, get_plugin_data(WP_PLUGIN_DIR . '/' . $plugin));
$row = ob_get_clean();
de_assert(strpos($row, $metadata['version']) !== false && strpos($row, 'entitle-example') !== false, 'Real admin plugin update row did not show the release.');
ob_start();
$client->license_page();
$page = ob_get_clean();
de_assert(strpos($page, 'license_key') !== false && strpos($page, 'Activated') !== false, 'Admin license form is missing.');
de_assert(strpos($page . $row, get_option('entitle_token')) === false, 'Admin HTML disclosed activation token.');
$problem = $client->compatibility_error($metadata);
if ($mode === 'check') {
    // Actual WordPress HTTP transport must add the token. download_url uses a safe URL
    // check, so local Docker config explicitly allows its private fixture host.
    $file = $client->download(false, $offer->package, null, array('plugin' => $plugin));
    de_result($file, 'Authenticated package download through WordPress failed');
    $digest = hash_file('sha256', $file);
    wp_delete_file($file);
    de_assert(hash_equals($metadata['sha256'], $digest), 'Package digest does not match metadata.');
    update_option('entitle_integration_delayed_package', array('url' => $offer->package, 'sha256' => $metadata['sha256']), false);
    WP_CLI::success('Activation, UUID, metadata, plugins_api, admin form/update row and authenticated package verified.');
    if ($problem) { WP_CLI::log('Update remains visible; installation compatibility guard: ' . $problem); }
    return;
}
de_assert(!$problem, $problem ?: 'Compatibility check failed.');
$before = get_plugin_data(WP_PLUGIN_DIR . '/' . $plugin);
if ($mode === 'manual') {
    $upgrader = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
    de_result($upgrader->upgrade($plugin), 'Real Plugin_Upgrader failed');
} else {
    $delayed = get_option('entitle_integration_delayed_package');
    if ($delayed && $delayed['url'] !== $offer->package) {
        $file = wp_tempnam($delayed['url']);
        $response = wp_safe_remote_get($delayed['url'], array('stream' => true, 'filename' => $file, 'redirection' => 0, 'headers' => array('Authorization' => 'Bearer ' . get_option('entitle_token'))));
        de_assert(!is_wp_error($response) && wp_remote_retrieve_response_code($response) === 200, 'Delayed authenticated HTTP transport failed.');
        de_result($file, 'Delayed cached package URL download failed');
        $digest = hash_file('sha256', $file);
        wp_delete_file($file);
        de_assert(hash_equals($delayed['sha256'], $digest), 'Delayed cached package digest changed.');
        WP_CLI::log('Delayed previous-release package URL remains authenticated and immutable.');
    }
    $previous = get_site_option('auto_update_plugins', array());
    update_site_option('auto_update_plugins', array_values(array_unique(array_merge((array) $previous, array($plugin)))));
    $updater = new WP_Automatic_Updater();
    // Retain WordPress's filesystem, compatibility and auto-update policy checks.
    try {
        de_result($updater->update('plugin', $offer), 'Real WP_Automatic_Updater failed or skipped');
        de_assert(is_plugin_active($plugin), 'Automatic update deactivated the installed plugin.');
    }
    finally { update_site_option('auto_update_plugins', $previous); }
}
wp_clean_plugins_cache(false);
$after = get_plugin_data(WP_PLUGIN_DIR . '/' . $plugin);
de_assert($after['Version'] === $metadata['version'] && version_compare($after['Version'], $before['Version'], '>'), 'Upgrader did not install the expected newer plugin files.');
de_assert(get_option('entitle_token') && $client->installation_id() === $id, 'Update lost persistent activation state.');
WP_CLI::success($mode . ' update installed ' . $after['Version'] . ' through real WordPress upgrader APIs.');
