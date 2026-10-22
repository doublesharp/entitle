<?php
namespace DoubleEntitle\Plugin\Installer\DoubleEntitle\Extension;

defined('_JEXEC') or die;

use Joomla\CMS\Factory;
use Joomla\CMS\Http\HttpFactory;
use Joomla\CMS\Plugin\CMSPlugin;
use Joomla\CMS\Uri\Uri;
use Joomla\Database\DatabaseInterface;
use Joomla\Event\SubscriberInterface;
use Joomla\CMS\Event\Installer\BeforePackageDownloadEvent;

/**
 * Joomla installer plugin for license settings and authenticated native updates.
 *
 * Joomla calls the subscribed download hooks. Call activate/status/deactivate only
 * from an administrator controller that checks CSRF and core.manage permission.
 * The persistent UUID and token live in this plugin row's custom_data, separate
 * from form-managed params. License state never gates installed extension features.
 */
final class DoubleEntitle extends CMSPlugin implements SubscriberInterface
{
    /** @return array<string, string> Native feed/package events mapped to our header hook. */
    public static function getSubscribedEvents(): array
    {
        return ['onInstallerBeforeUpdateSiteDownload' => 'headers', 'onInstallerBeforePackageDownload' => 'headers'];
    }

    /**
     * Validate administrator settings before constructing authenticated URLs.
     *
     * @return array{0: string, 1: string} HTTPS tenant API base and product slug.
     * @throws \RuntimeException If either setting is invalid.
     */
    private function config(): array
    {
        $base = rtrim((string) $this->params->get('api_base'), '/');
        $product = (string) $this->params->get('product');
        $url = parse_url($base);
        if (!$url || ($url['scheme'] ?? '') !== 'https' || empty($url['host']) || (isset($url['user']) || isset($url['pass'])) || isset($url['query']) || isset($url['fragment'])
            || !preg_match('~^/api/v1/tenants/[a-z0-9]+(?:-[a-z0-9]+)*$~D', $url['path'] ?? '') || !preg_match('~^[a-z0-9]+(?:-[a-z0-9]+)*$~D', $product)) {
            throw new \RuntimeException('Configure an HTTPS tenant API URL and product.');
        }
        return [$base, $product];
    }

    /**
     * Limit credentials to the exact product feed or immutable package path.
     * Public so controllers and tests can use the same check without sending HTTP.
     *
     * @param string $base Validated tenant API base.
     * @param string $product Validated product slug.
     * @param string $url Candidate URL supplied by Joomla's installer.
     * @return bool Whether the URL's origin and path may receive our token.
     */
    public static function permits(string $base, string $product, string $url): bool
    {
        $a = parse_url($base); $b = parse_url($url);
        if (!$a || !$b || ($b['scheme'] ?? '') !== 'https' || strtolower($a['host'] ?? '') !== strtolower($b['host'] ?? '')
            || ($a['port'] ?? 443) !== ($b['port'] ?? 443) || isset($b['user']) || isset($b['pass']) || isset($b['query']) || isset($b['fragment'])) { return false; }
        $path = $b['path'] ?? '';
        if ($path === $a['path'] . '/updates/joomla/' . $product . '.xml') { return true; }
        return (bool) preg_match('~^' . preg_quote($a['path'] . '/packages/' . $product . '/assets/', '~') . '[A-Za-z0-9-]+/[A-Za-z0-9._-]+$~D', $path);
    }

    /**
     * Add Authorization to an allowed native request when a valid token is stored.
     * Unrelated requests and missing/invalid configuration are left unchanged.
     *
     * @param BeforePackageDownloadEvent $event Feed event or package-download event.
     * @return void
     */
    public function headers(BeforePackageDownloadEvent $event): void
    {
        try { [$base, $product] = $this->config(); } catch (\RuntimeException $e) { return; }
        if (!self::permits($base, $product, $event->getUrl())) { return; }
        $token = (string) ($this->state()['activation_token'] ?? '');
        if (!preg_match('~^[A-Za-z0-9_-]{1,1024}$~D', $token)) { return; }
        $headers = $event->getHeaders();
        $headers['Authorization'] = 'Bearer ' . $token;
        $event->updateHeaders($headers);
    }

    /**
     * Restrict a query to this installer plugin's own extension row.
     *
     * @param object $db Joomla database driver used for quoting.
     * @param object $query Select/update query to constrain.
     * @return object The same query with the plugin identity conditions added.
     */
    private function rowConditions(object $db, object $query): object
    {
        return $query->where($db->quoteName('type') . ' = ' . $db->quote('plugin'))
            ->where($db->quoteName('folder') . ' = ' . $db->quote('installer'))
            ->where($db->quoteName('element') . ' = ' . $db->quote('doubleentitle'));
    }

    /**
     * Load custom_data as an object, preserving unrelated keys and original bytes.
     * The original value detects concurrent changes during a later write.
     *
     * @return array{0: DatabaseInterface, 1: string|null, 2: \stdClass} Driver, raw JSON, document.
     * @throws \RuntimeException If the row is missing or existing data cannot be edited safely.
     */
    private function document(): array
    {
        $db = Factory::getContainer()->get(DatabaseInterface::class);
        $row = $db->setQuery($this->rowConditions($db, $db->getQuery(true)
            ->select($db->quoteName('custom_data'))->from($db->quoteName('#__extensions'))))->loadObject();
        if (!$row) { throw new \RuntimeException('Installer plugin registration is missing.'); }
        $raw = $row->custom_data;
        try {
            $document = $raw === null || trim($raw) === '' ? new \stdClass() : json_decode($raw, false, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) { throw new \RuntimeException('Existing plugin custom data cannot be modified safely.'); }
        if (!$document instanceof \stdClass || (isset($document->double_entitle) && !$document->double_entitle instanceof \stdClass)) {
            throw new \RuntimeException('Existing plugin custom data cannot be modified safely.');
        }
        return [$db, $raw, $document];
    }

    /**
     * Read our reserved state object, falling back to legacy prototype params.
     *
     * @param \stdClass $document Validated custom_data document.
     * @return array<string, mixed> Installation/token state, excluding unrelated custom data.
     */
    private function documentState(\stdClass $document): array
    {
        if (property_exists($document, 'double_entitle')) { return (array) $document->double_entitle; }
        // Migrate prototype state before a later form save can discard unknown params.
        $state = [];
        foreach (['installation_id', 'activation_token'] as $key) {
            $value = $this->params->get($key, '');
            if (is_string($value) && $value !== '') { $state[$key] = $value; }
        }
        return $state;
    }

    /**
     * Change license state without overwriting concurrent or unrelated custom data.
     * The callback may run again after contention, so it must not perform external I/O.
     *
     * @param callable(array): array $change Transform the latest persisted license state.
     * @return array<string, mixed> State successfully stored, or already current.
     * @throws \RuntimeException If contention prevents a write after five attempts.
     */
    private function mutateState(callable $change): array
    {
        for ($attempt = 0; $attempt < 5; $attempt++) {
            // Step 1: read the latest document and change only our reserved object.
            [$db, $raw, $document] = $this->document();
            $state = $change($this->documentState($document));
            $document->double_entitle = (object) $state;
            $encoded = json_encode($document, JSON_THROW_ON_ERROR);
            if ($encoded === $raw) { return $state; }
            $query = $this->rowConditions($db, $db->getQuery(true)->update($db->quoteName('#__extensions'))
                ->set($db->quoteName('custom_data') . ' = ' . $db->quote($encoded)));
            // Step 2: write only if custom_data still matches what we read.
            $query->where($db->quoteName('custom_data') . ($raw === null ? ' IS NULL' : ' = ' . $db->quote($raw)));
            $db->setQuery($query)->execute();
            if ($db->getAffectedRows() > 0) { return $state; }
            // Step 3: another writer won; reread and reapply instead of overwriting it.
        }
        throw new \RuntimeException('License settings changed concurrently. Try again.');
    }

    /** @return array<string, mixed> Current state, migrating legacy params on first use. */
    private function state(): array
    {
        [, , $document] = $this->document();
        $state = $this->documentState($document);
        if (!property_exists($document, 'double_entitle') && $state !== []) {
            return $this->mutateState(static fn(array $current): array => $current);
        }
        return $state;
    }

    /**
     * Persist a random UUID once, reusing the winner if another request creates it first.
     *
     * @return string Installation identity retained across updates and deactivation.
     */
    public function installationId(): string
    {
        $state = $this->state();
        if (isset($state['installation_id']) && is_string($state['installation_id']) && $state['installation_id'] !== '') { return $state['installation_id']; }
        $state = $this->mutateState(static function (array $current): array {
            if (!empty($current['installation_id'])) { return $current; }
            $bytes = random_bytes(16); $bytes[6] = chr((ord($bytes[6]) & 15) | 64); $bytes[8] = chr((ord($bytes[8]) & 63) | 128);
            $hex = bin2hex($bytes);
            $current['installation_id'] = substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
            return $current;
        });
        return $state['installation_id'];
    }

    /**
     * Send JSON through Joomla HTTP with no redirects and a timeout.
     * Transport details become fixed errors safe for the settings UI.
     *
     * @param string $path Fixed path relative to the configured tenant API.
     * @param array|null $body POST fields, or null for GET; an empty array sends {}.
     * @param bool $authenticated Attach the token; false only for activation.
     * @return array<string, mixed> Decoded response data.
     * @throws \RuntimeException If configuration, credentials, transport, or response fails.
     */
    private function request(string $path, ?array $body, bool $authenticated): array
    {
        [$base] = $this->config();
        $headers = ['Accept' => 'application/json', 'Content-Type' => 'application/json'];
        if ($authenticated) {
            $token = (string) ($this->state()['activation_token'] ?? '');
            if (!preg_match('~^[A-Za-z0-9_-]{1,1024}$~D', $token)) { throw new \RuntimeException('Activate updates first.'); }
            $headers['Authorization'] = 'Bearer ' . $token;
        }
        try {
            $http = HttpFactory::getHttp(['follow_location' => false, 'timeout' => 15]);
            $reply = $body === null ? $http->get($base . $path, $headers) : $http->post($base . $path, json_encode((object) $body, JSON_THROW_ON_ERROR), $headers);
        } catch (\Throwable $e) { throw new \RuntimeException('Licensing service unavailable.'); }
        $status = $reply->getStatusCode();
        if ($status < 200 || $status >= 300) { throw new \RuntimeException('Update access declined. Reconnect your license.'); }
        $result = json_decode((string) $reply->getBody(), true);
        if (!is_array($result)) { throw new \RuntimeException('Invalid licensing response.'); }
        return $result;
    }

    /**
     * Exchange an administrator's key for a validated installation token.
     *
     * @param string $key Key from the protected settings form; clear the field afterward.
     * @return void Only the returned token is persisted, never the raw key.
     * @throws \RuntimeException If activation, validation, or persistence fails.
     */
    public function activate(string $key): void
    {
        [, $product] = $this->config();
        $result = $this->request('/activate', ['key' => $key, 'product' => $product, 'installationId' => $this->installationId(), 'siteUrl' => Uri::root()], false);
        if (($result['installationId'] ?? '') !== $this->installationId() || !preg_match('~^[A-Za-z0-9_-]{1,1024}$~D', $result['token'] ?? '')) { throw new \RuntimeException('Invalid activation response.'); }
        $this->mutateState(static function (array $current) use ($result): array {
            $current['activation_token'] = $result['token']; return $current;
        });
    }

    /** @return array<string, mixed> Server-side activation details for administrator settings. */
    public function status(): array { return $this->request('/activation', null, true); }

    /**
     * Release server access before clearing the token, retaining the UUID and installed features.
     *
     * @return void
     * @throws \RuntimeException If the request or local state update fails.
     */
    public function deactivate(): void
    {
        $this->request('/deactivate', [], true);
        $this->mutateState(static function (array $current): array {
            $current['activation_token'] = ''; return $current;
        });
    }
}
