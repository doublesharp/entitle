<?php
/** WordPress-native update transport, independent of feature compatibility or license status. */
if (!defined('ABSPATH')) { exit; }

class Double_Entitle_Client {
    private $file;
    private $version;
    private $basename;
    private $downloading = null;

    public function __construct($file, $version) {
        $this->file = $file;
        $this->version = $version;
        $this->basename = plugin_basename($file);
    }

    public function register() {
        add_filter('pre_set_site_transient_update_plugins', array($this, 'updates'));
        add_filter('plugins_api', array($this, 'plugin_information'), 10, 3);
        add_filter('http_request_args', array($this, 'package_headers'), 10, 2);
        add_filter('upgrader_pre_download', array($this, 'download'), 10, 4);
        add_action('admin_menu', array($this, 'admin_menu'));
        add_action('admin_post_double_entitle_license', array($this, 'save_license'));
        add_action('in_plugin_update_message-' . $this->basename, array($this, 'update_notice'), 10, 2);
    }

    public function product() {
        return defined('DOUBLE_ENTITLE_PRODUCT') ? DOUBLE_ENTITLE_PRODUCT : get_option('double_entitle_product', 'double-entitle-example');
    }

    public function api_base() {
        return rtrim(defined('DOUBLE_ENTITLE_API_URL') ? DOUBLE_ENTITLE_API_URL : get_option('double_entitle_api_url', 'https://licenses.example.com/api/v1/tenants/your-publisher'), '/');
    }

    private function configured() {
        $parts = wp_parse_url($this->api_base());
        return is_array($parts) && !empty($parts['host']) && !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment'])
            && ($parts['scheme'] === 'https' || (defined('DOUBLE_ENTITLE_ALLOW_HTTP') && DOUBLE_ENTITLE_ALLOW_HTTP && $parts['scheme'] === 'http'))
            && isset($parts['path']) && preg_match('~^/api/v1/tenants/[a-z0-9]+(?:-[a-z0-9]+)*$~D', $parts['path'])
            && preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/D', $this->product());
    }

    public function installation_id() {
        $id = get_option('double_entitle_installation_id');
        if (!$id) {
            // add_option is atomic. A concurrent request must read the winner's UUID.
            add_option('double_entitle_installation_id', wp_generate_uuid4(), '', false);
            $id = get_option('double_entitle_installation_id');
        }
        return $id;
    }

    private function cache_key() {
        return 'double_entitle_meta_' . md5($this->api_base() . '|' . $this->product() . '|' . get_option('double_entitle_token', ''));
    }

    private function clear_cache() {
        delete_site_transient($this->cache_key());
        delete_site_transient('update_plugins');
    }

    private function request($path, $method = 'GET', $body = null, $authenticated = true) {
        if (!$this->configured()) { return new WP_Error('double_entitle_config', 'Configure an HTTPS licensing API URL and product slug.'); }
        $args = array('method' => $method, 'timeout' => 15, 'redirection' => 0, 'headers' => array('Accept' => 'application/json'));
        if ($authenticated) {
            $token = get_option('double_entitle_token', '');
            if (!$token) { return new WP_Error('double_entitle_inactive', 'Enter a license key to activate updates.'); }
            $args['headers']['Authorization'] = 'Bearer ' . $token;
        }
        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = wp_json_encode($body);
        }
        $reply = wp_remote_request($this->api_base() . $path, $args);
        // Do not expose provider responses or WP_Error data containing request credentials.
        if (is_wp_error($reply)) { return new WP_Error('double_entitle_unavailable', 'The licensing service is unavailable. Try again later.'); }
        $status = wp_remote_retrieve_response_code($reply);
        if ($status === 204) { return array('empty' => true); }
        if ($status < 200 || $status >= 300) {
            return new WP_Error(in_array($status, array(401, 403), true) ? 'double_entitle_denied' : 'double_entitle_request', 'The licensing request was declined. Check the license and service configuration.');
        }
        $data = json_decode(wp_remote_retrieve_body($reply), true);
        return is_array($data) ? $data : new WP_Error('double_entitle_response', 'The licensing service returned an invalid response.');
    }

    public function activate($key) {
        if (!is_string($key) || !trim($key) || strlen($key) > 1024) { return new WP_Error('double_entitle_key', 'Enter a valid license key.'); }
        $reply = $this->request('/activate', 'POST', array('key' => trim($key), 'installationId' => $this->installation_id(), 'siteUrl' => home_url(), 'product' => $this->product()), false);
        if (is_wp_error($reply)) { return $reply; }
        if (empty($reply['token']) || !is_string($reply['token']) || !preg_match('/^[A-Za-z0-9_-]{1,1024}$/D', $reply['token']) || !isset($reply['installationId']) || $reply['installationId'] !== $this->installation_id()) {
            return new WP_Error('double_entitle_response', 'The licensing service returned an invalid activation.');
        }
        $this->clear_cache();
        update_option('double_entitle_token', $reply['token'], false);
        // Never persist the raw key. The installation token is sufficient after activation.
        update_option('double_entitle_paid_through', isset($reply['paidThrough']) ? $reply['paidThrough'] : null, false);
        $this->clear_cache();
        return true;
    }

    public function deactivate() {
        $reply = $this->request('/deactivate', 'POST', (object) array());
        if (is_wp_error($reply)) { return $reply; }
        if (empty($reply['ok'])) { return new WP_Error('double_entitle_response', 'The licensing service did not confirm deactivation.'); }
        $this->clear_cache();
        delete_option('double_entitle_token');
        delete_option('double_entitle_paid_through');
        // Keep the installation UUID even when this plugin is disabled or its license deactivated.
        return true;
    }

    private function package_url($url) {
        if (!$this->configured() || !is_string($url)) { return false; }
        // Compare the entire configured origin and API path; no credentials, query, fragment,
        // encoded paths or redirects can expand the destination receiving Authorization.
        return preg_match('~^' . preg_quote($this->api_base(), '~') . '/packages/[A-Za-z0-9_-]+$~D', $url) === 1;
    }

    public function package_headers($args, $url) {
        $token = get_option('double_entitle_token', '');
        if ($token && $this->downloading === $url && $this->package_url($url)) {
            if (!isset($args['headers']) || !is_array($args['headers'])) { $args['headers'] = array(); }
            foreach (array_keys($args['headers']) as $header) {
                if (strtolower($header) === 'authorization') { unset($args['headers'][$header]); }
            }
            $args['headers']['Authorization'] = 'Bearer ' . $token;
            $args['redirection'] = 0;
        }
        return $args;
    }

    public function metadata($force = false) {
        if (!get_option('double_entitle_token')) { return false; }
        $cached = get_site_transient($this->cache_key());
        if (!$force && is_array($cached) && $cached['checked_at'] > time() - HOUR_IN_SECONDS) { return $cached['data']; }
        $reply = $this->request('/updates/' . rawurlencode($this->product()));
        if (is_wp_error($reply)) {
            if ($reply->get_error_code() === 'double_entitle_denied') {
                delete_site_transient($this->cache_key());
                return false;
            }
            // Keep a bounded, previously validated offer on temporary outages. Package access
            // always receives a fresh entitlement check from the server.
            return is_array($cached) ? $cached['data'] : false;
        }
        if (!empty($reply['empty'])) {
            set_site_transient($this->cache_key(), array('checked_at' => time(), 'data' => false), DAY_IN_SECONDS);
            return false;
        }
        if (!$this->valid_metadata($reply)) { return false; }
        set_site_transient($this->cache_key(), array('checked_at' => time(), 'data' => $reply), DAY_IN_SECONDS);
        return $reply;
    }

    private function valid_metadata($data) {
        foreach (array('name', 'slug', 'version', 'download_url', 'requires', 'requires_php', 'sha256') as $field) {
            if (!isset($data[$field]) || !is_string($data[$field])) { return false; }
        }
        foreach (array('min_free', 'tested') as $field) {
            if (isset($data[$field]) && !is_string($data[$field])) { return false; }
        }
        if (isset($data['sections']) && (!is_array($data['sections']) || (isset($data['sections']['changelog']) && !is_string($data['sections']['changelog'])))) { return false; }
        return $data['slug'] === $this->product() && preg_match('/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/D', $data['version'])
            && preg_match('/^[a-f0-9]{64}$/D', $data['sha256']) && $this->package_url($data['download_url']);
    }

    public function updates($transient) {
        if (!is_object($transient)) { return $transient; }
        $metadata = $this->metadata();
        unset($transient->response[$this->basename], $transient->no_update[$this->basename]);
        if (!$metadata) { return $transient; }
        $offer = (object) array('id' => $this->api_base() . '/updates/' . $this->product(), 'slug' => dirname($this->basename), 'plugin' => $this->basename, 'new_version' => $metadata['version'], 'url' => '', 'package' => $metadata['download_url'], 'requires' => $metadata['requires'], 'requires_php' => $metadata['requires_php'], 'tested' => isset($metadata['tested']) ? $metadata['tested'] : '', 'min_free' => isset($metadata['min_free']) ? $metadata['min_free'] : null, 'sha256' => $metadata['sha256']);
        $installed = isset($transient->checked[$this->basename]) ? $transient->checked[$this->basename] : $this->version;
        $bucket = version_compare($metadata['version'], $installed, '>') ? 'response' : 'no_update';
        if (!isset($transient->$bucket)) { $transient->$bucket = array(); }
        $transient->{$bucket}[$this->basename] = $offer;
        return $transient;
    }

    public function plugin_information($result, $action, $args) {
        if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== dirname($this->basename)) { return $result; }
        $metadata = $this->metadata();
        if (!$metadata) { return $result; }
        return (object) array('name' => $metadata['name'], 'slug' => dirname($this->basename), 'version' => $metadata['version'], 'author' => 'Double Entitle', 'requires' => $metadata['requires'], 'requires_php' => $metadata['requires_php'], 'tested' => isset($metadata['tested']) ? $metadata['tested'] : '', 'download_link' => $metadata['download_url'], 'sections' => array('changelog' => wp_kses_post(isset($metadata['sections']['changelog']) ? $metadata['sections']['changelog'] : '')));
    }

    public function compatibility_error($metadata) {
        global $wp_version;
        if (!empty($metadata['requires']) && version_compare($wp_version, $metadata['requires'], '<')) { return 'This release needs WordPress ' . $metadata['requires'] . ' or later.'; }
        if (!empty($metadata['requires_php']) && version_compare(PHP_VERSION, $metadata['requires_php'], '<')) { return 'This release needs PHP ' . $metadata['requires_php'] . ' or later.'; }
        $free = defined('DOUBLE_ENTITLE_FREE_VERSION') ? DOUBLE_ENTITLE_FREE_VERSION : get_option('double_entitle_free_version', '0.0.0');
        if (!empty($metadata['min_free']) && version_compare($free, $metadata['min_free'], '<')) { return 'Update the Free plugin to ' . $metadata['min_free'] . ' or later before installing this release.'; }
        return '';
    }

    public function download($reply, $package, $upgrader = null, $hook_extra = array()) {
        // Attribution takes precedence over a shared service origin: another plugin may
        // use this API too, and must keep its own token and checksum handler.
        $attributed = isset($hook_extra['plugin']);
        if ($attributed && $hook_extra['plugin'] !== $this->basename) { return $reply; }
        if ($reply !== false) {
            return $attributed && !is_wp_error($reply) ? new WP_Error('double_entitle_package', 'An earlier download handler returned an unverified package. Refresh updates and retry.') : $reply;
        }
        if (!$this->package_url($package)) {
            // A cached offer can survive a configuration change. Never let core's
            // fallback install our package without this client's checksum verification.
            return $attributed ? new WP_Error('double_entitle_package', 'Refresh the available updates before trying this package again.') : $reply;
        }
        $metadata = $this->metadata();
        if (!$metadata || $metadata['download_url'] !== $package) { return $attributed ? new WP_Error('double_entitle_package', 'Refresh the available updates before trying this package again.') : $reply; }
        $problem = $this->compatibility_error($metadata);
        if ($problem) { return new WP_Error('double_entitle_compatibility', $problem); }
        // Core download_url uses WordPress HTTP and its configured temporary directory.
        $this->downloading = $package;
        try { $file = download_url($package); }
        finally { $this->downloading = null; }
        if (is_wp_error($file)) { return new WP_Error('double_entitle_download', 'The package could not be downloaded. Check license access and try again.'); }
        if (!hash_equals($metadata['sha256'], hash_file('sha256', $file))) {
            wp_delete_file($file);
            return new WP_Error('double_entitle_checksum', 'The downloaded package failed its SHA-256 check.');
        }
        return $file;
    }

    public function update_notice($plugin_data, $response) {
        $problem = $this->compatibility_error(array('requires' => $response->requires, 'requires_php' => $response->requires_php, 'min_free' => isset($response->min_free) ? $response->min_free : null));
        if ($problem) { echo '<br>' . esc_html($problem); }
    }

    public function admin_menu() {
        add_options_page('Double Entitle license', 'Double Entitle license', 'manage_options', 'double-entitle-license', array($this, 'license_page'));
    }

    public function license_page() {
        if (!current_user_can('manage_options')) { return; }
        echo '<div class="wrap"><h1>Double Entitle license</h1><p>Installed features continue to work when your license expires or the service is unavailable.</p>';
        if (isset($_GET['de_result'])) {
            $messages = array('ok' => 'License updated.', 'failed' => 'The license request failed. Check your key and service configuration, then retry.');
            $result = sanitize_key(wp_unslash($_GET['de_result']));
            if (isset($messages[$result])) { echo '<div class="notice notice-info"><p>' . esc_html($messages[$result]) . '</p></div>'; }
        }
        echo '<p>Updates: ' . (get_option('double_entitle_token') ? 'Activated' : 'Not activated') . '</p><form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('double_entitle_license');
        echo '<input type="hidden" name="action" value="double_entitle_license"><label for="de-license">License key</label> <input id="de-license" type="password" name="license_key" value="" autocomplete="off"> ';
        submit_button('Activate', 'primary', 'activate', false);
        if (get_option('double_entitle_token')) { echo ' '; submit_button('Deactivate license', 'secondary', 'deactivate', false); }
        echo '</form></div>';
    }

    public function save_license() {
        if (!current_user_can('manage_options')) { wp_die('Access denied.', '', array('response' => 403)); }
        check_admin_referer('double_entitle_license');
        $result = isset($_POST['deactivate']) ? $this->deactivate() : $this->activate(isset($_POST['license_key']) ? wp_unslash($_POST['license_key']) : '');
        wp_safe_redirect(add_query_arg('de_result', is_wp_error($result) ? 'failed' : 'ok', admin_url('options-general.php?page=double-entitle-license')));
        exit;
    }
}
