<?php
/**
 * WordPress-native activation, update discovery, and verified package transport.
 * Include this file from the plugin entry point, construct the client, and register
 * its hooks before product compatibility checks. Installed features never depend
 * on successful license requests. See each method for its native hook contract.
 */
if (!defined('ABSPATH')) { exit; }

/** Connect protected license settings to WordPress's normal plugin update workflow. */
class Double_Entitle_Client {
    /** @var string Absolute path to the main plugin file. */
    private $file;
    /** @var string Installed plugin version used when core has no checked version. */
    private $version;
    /** @var string WordPress plugin identifier, such as double-entitle-example/double-entitle-example.php. */
    private $basename;
    /** @var string|null Package URL allowed to receive the token during our download. */
    private $downloading = null;

    /**
     * Identify the plugin without making requests or checking license status.
     *
     * @param string $file Absolute main plugin file path, normally __FILE__ there.
     * @param string $version Installed plugin version matching its header.
     */
    public function __construct($file, $version) {
        $this->file = $file;
        $this->version = $version;
        $this->basename = plugin_basename($file);
    }

    /**
     * Register native update, download, and administrator settings hooks once at boot.
     *
     * @return void
     */
    public function register() {
        add_filter('pre_set_site_transient_update_plugins', array($this, 'updates'));
        add_filter('plugins_api', array($this, 'plugin_information'), 10, 3);
        add_filter('http_request_args', array($this, 'package_headers'), 10, 2);
        add_filter('upgrader_pre_download', array($this, 'download'), 10, 4);
        add_action('admin_menu', array($this, 'admin_menu'));
        add_action('admin_post_double_entitle_license', array($this, 'save_license'));
        add_action('in_plugin_update_message-' . $this->basename, array($this, 'update_notice'), 10, 2);
    }

    /** @return string Product slug from the configuration constant or saved option. */
    public function product() {
        return defined('DOUBLE_ENTITLE_PRODUCT') ? DOUBLE_ENTITLE_PRODUCT : get_option('double_entitle_product', 'double-entitle-example');
    }

    /** @return string Tenant API base without a trailing slash; validated before requests. */
    public function api_base() {
        return rtrim(defined('DOUBLE_ENTITLE_API_URL') ? DOUBLE_ENTITLE_API_URL : get_option('double_entitle_api_url', 'https://licenses.example.com/api/v1/tenants/your-publisher'), '/');
    }

    /**
     * Validate the tenant path and product before allowing authenticated traffic.
     * HTTP is permitted only through the explicit local-development override.
     *
     * @return bool Whether the current configuration is usable.
     */
    private function configured() {
        $parts = wp_parse_url($this->api_base());
        return is_array($parts) && !empty($parts['host']) && !isset($parts['user']) && !isset($parts['pass']) && !isset($parts['query']) && !isset($parts['fragment'])
            && ($parts['scheme'] === 'https' || (defined('DOUBLE_ENTITLE_ALLOW_HTTP') && DOUBLE_ENTITLE_ALLOW_HTTP && $parts['scheme'] === 'http'))
            && isset($parts['path']) && preg_match('~^/api/v1/tenants/[a-z0-9]+(?:-[a-z0-9]+)*$~D', $parts['path'])
            && preg_match('/^[a-z0-9]+(?:-[a-z0-9]+)*$/D', $this->product());
    }

    /** @return string Persistent random UUID retained across upgrades and deactivation. */
    public function installation_id() {
        $id = get_option('double_entitle_installation_id');
        if (!$id) {
            // add_option is atomic. A concurrent request must read the winner's UUID.
            add_option('double_entitle_installation_id', wp_generate_uuid4(), '', false);
            $id = get_option('double_entitle_installation_id');
        }
        return $id;
    }

    /** @return string Metadata cache key scoped to the current API, product, and token. */
    private function cache_key() {
        return 'double_entitle_meta_' . md5($this->api_base() . '|' . $this->product() . '|' . get_option('double_entitle_token', ''));
    }

    /** @return void Discard this credential's metadata and WordPress's cached update offers. */
    private function clear_cache() {
        delete_site_transient($this->cache_key());
        delete_site_transient('update_plugins');
    }

    /**
     * Send a bounded WordPress HTTP request with redirects disabled and safe errors.
     *
     * @param string $path Fixed API path relative to the configured tenant URL.
     * @param string $method HTTP method, normally GET or POST.
     * @param array|object|null $body JSON payload, or null to omit the body.
     * @param bool $authenticated Attach the saved token; false for the key exchange.
     * @return array|WP_Error Decoded JSON, an empty-response marker, or a displayable error.
     */
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

    /**
     * Exchange a settings-form key for a token belonging to this installation.
     *
     * @param string $key User-entered key. The raw key is never persisted.
     * @return true|WP_Error True after storage succeeds, or a safe activation error.
     */
    public function activate($key) {
        // Step 1: validate the input and send the key with this site's stable identity.
        if (!is_string($key) || !trim($key) || strlen($key) > 1024) { return new WP_Error('double_entitle_key', 'Enter a valid license key.'); }
        $reply = $this->request('/activate', 'POST', array('key' => trim($key), 'installationId' => $this->installation_id(), 'siteUrl' => home_url(), 'product' => $this->product()), false);
        if (is_wp_error($reply)) { return $reply; }
        if (empty($reply['token']) || !is_string($reply['token']) || !preg_match('/^[A-Za-z0-9_-]{1,1024}$/D', $reply['token']) || !isset($reply['installationId']) || $reply['installationId'] !== $this->installation_id()) {
            return new WP_Error('double_entitle_response', 'The licensing service returned an invalid activation.');
        }
        // Step 2: after response validation, clear the old token's cached offer.
        $this->clear_cache();
        // Step 3: store the token and display metadata, then refresh update offers.
        update_option('double_entitle_token', $reply['token'], false);
        // Never persist the raw key. The installation token is sufficient after activation.
        update_option('double_entitle_paid_through', isset($reply['paidThrough']) ? $reply['paidThrough'] : null, false);
        $this->clear_cache();
        return true;
    }

    /**
     * Release server access, then clear local credentials and cached offers.
     *
     * @return true|WP_Error True on confirmed deactivation; failures keep the token for retry.
     */
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

    /**
     * Check the exact configured package route before allowing credentials or bytes.
     *
     * @param mixed $url Candidate package URL from metadata or WordPress's upgrader.
     * @return bool Whether the destination is an allowed package URL.
     */
    private function package_url($url) {
        if (!$this->configured() || !is_string($url)) { return false; }
        // Compare the entire configured origin and API path; no credentials, query, fragment,
        // encoded paths or redirects can expand the destination receiving Authorization.
        return preg_match('~^' . preg_quote($this->api_base(), '~') . '/packages/[A-Za-z0-9_-]+$~D', $url) === 1;
    }

    /**
     * Filter http_request_args only during this client's own verified download.
     * Other WordPress requests must not inherit our activation token.
     *
     * @param array $args Native WordPress HTTP arguments.
     * @param string $url Destination of the pending request.
     * @return array Arguments with scoped Authorization and no redirects, or unchanged arguments.
     */
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

    /**
     * Fetch and validate an update offer, normally rechecking after one hour.
     * Temporary failures may reuse a validated cache entry until its one-day expiry;
     * denied access clears it. Package downloads still require server authorization.
     *
     * @param bool $force Skip the one-hour freshness shortcut.
     * @return array|false Valid metadata, or false when no usable offer is available.
     */
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

    /**
     * Validate response fields, product identity, version, checksum, and package URL.
     *
     * @param array $data Decoded update response.
     * @return bool Whether the metadata can be exposed to WordPress's updater.
     */
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

    /**
     * Filter pre_set_site_transient_update_plugins to publish this plugin's offer.
     * Compatibility requirements stay visible even when they prevent installation.
     *
     * @param mixed $transient WordPress update state, passed through if not an object.
     * @return mixed Updated response/no_update buckets, or the original value.
     */
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

    /**
     * Populate only this plugin's native "View details" dialog via plugins_api.
     *
     * @param mixed $result Earlier filter result to preserve for unrelated requests.
     * @param string $action Native Plugin API action.
     * @param object $args Requested plugin slug and other API arguments.
     * @return mixed Plugin information object, or the earlier result.
     */
    public function plugin_information($result, $action, $args) {
        if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== dirname($this->basename)) { return $result; }
        $metadata = $this->metadata();
        if (!$metadata) { return $result; }
        return (object) array('name' => $metadata['name'], 'slug' => dirname($this->basename), 'version' => $metadata['version'], 'author' => 'Double Entitle', 'requires' => $metadata['requires'], 'requires_php' => $metadata['requires_php'], 'tested' => isset($metadata['tested']) ? $metadata['tested'] : '', 'download_link' => $metadata['download_url'], 'sections' => array('changelog' => wp_kses_post(isset($metadata['sections']['changelog']) ? $metadata['sections']['changelog'] : '')));
    }

    /**
     * Explain unmet WordPress, PHP, or companion Free-plugin requirements.
     * This controls installation of a new release, not access to installed features.
     *
     * @param array $metadata Requirements from a validated offer.
     * @return string First compatibility problem, or an empty string when compatible.
     */
    public function compatibility_error($metadata) {
        global $wp_version;
        if (!empty($metadata['requires']) && version_compare($wp_version, $metadata['requires'], '<')) { return 'This release needs WordPress ' . $metadata['requires'] . ' or later.'; }
        if (!empty($metadata['requires_php']) && version_compare(PHP_VERSION, $metadata['requires_php'], '<')) { return 'This release needs PHP ' . $metadata['requires_php'] . ' or later.'; }
        $free = defined('DOUBLE_ENTITLE_FREE_VERSION') ? DOUBLE_ENTITLE_FREE_VERSION : get_option('double_entitle_free_version', '0.0.0');
        if (!empty($metadata['min_free']) && version_compare($free, $metadata['min_free'], '<')) { return 'Update the Free plugin to ' . $metadata['min_free'] . ' or later before installing this release.'; }
        return '';
    }

    /**
     * Filter upgrader_pre_download to provide a compatible, checksum-verified file.
     *
     * @param false|string|WP_Error $reply Earlier result; false requests a download.
     * @param string $package Requested package URL.
     * @param WP_Upgrader|null $upgrader Native upgrader, unused by this example.
     * @param array $hook_extra Attribution including the plugin basename when supplied.
     * @return false|string|WP_Error Pass-through, verified temporary filename, or safe error.
     */
    public function download($reply, $package, $upgrader = null, $hook_extra = array()) {
        // Step 1: identify our request without taking over another plugin's update.
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
        // Step 2: enforce release compatibility before downloading package bytes.
        $problem = $this->compatibility_error($metadata);
        if ($problem) { return new WP_Error('double_entitle_compatibility', $problem); }
        // Core download_url uses WordPress HTTP and its configured temporary directory.
        // Step 3: authorize only the duration of this exact native download.
        $this->downloading = $package;
        try { $file = download_url($package); }
        finally { $this->downloading = null; }
        if (is_wp_error($file)) { return new WP_Error('double_entitle_download', 'The package could not be downloaded. Check license access and try again.'); }
        // Step 4: delete mismatched bytes; return only a verified file to the upgrader.
        if (!hash_equals($metadata['sha256'], hash_file('sha256', $file))) {
            wp_delete_file($file);
            return new WP_Error('double_entitle_checksum', 'The downloaded package failed its SHA-256 check.');
        }
        return $file;
    }

    /**
     * Explain compatibility blockers below the native plugin update message.
     *
     * @param array $plugin_data Installed plugin headers, unused by this example.
     * @param object $response Update offer containing release requirements.
     * @return void Outputs an escaped message when installation is incompatible.
     */
    public function update_notice($plugin_data, $response) {
        $problem = $this->compatibility_error(array('requires' => $response->requires, 'requires_php' => $response->requires_php, 'min_free' => isset($response->min_free) ? $response->min_free : null));
        if ($problem) { echo '<br>' . esc_html($problem); }
    }

    /** @return void Register the license page under Settings for administrators. */
    public function admin_menu() {
        add_options_page('Double Entitle license', 'Double Entitle license', 'manage_options', 'double-entitle-license', array($this, 'license_page'));
    }

    /**
     * Render a capability-protected form with a CSRF nonce and an empty key field.
     *
     * @return void Outputs escaped status and fixed request-result messages.
     */
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

    /**
     * Handle admin-post activation/deactivation after capability and nonce checks.
     * Redirect with a fixed result code so keys and provider errors stay out of URLs.
     *
     * @return void Redirects and terminates the request.
     */
    public function save_license() {
        if (!current_user_can('manage_options')) { wp_die('Access denied.', '', array('response' => 403)); }
        check_admin_referer('double_entitle_license');
        $result = isset($_POST['deactivate']) ? $this->deactivate() : $this->activate(isset($_POST['license_key']) ? wp_unslash($_POST['license_key']) : '');
        wp_safe_redirect(add_query_arg('de_result', is_wp_error($result) ? 'failed' : 'ok', admin_url('options-general.php?page=double-entitle-license')));
        exit;
    }
}
