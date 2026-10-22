<?php
// Framework/database/HTTP stand-ins exercise template contracts, not a Joomla runtime.
namespace Joomla\CMS\Plugin {
    class CMSPlugin {
        public object $params;
        public function __construct(array $params) {
            $this->params = new class($params) {
                private array $values;
                public function __construct(array $values) { $this->values = $values; }
                public function get(string $key, mixed $default = null): mixed { return $this->values[$key] ?? $default; }
                public function set(string $key, mixed $value): void { $this->values[$key] = $value; }
                public function toString(): string { return json_encode($this->values, JSON_THROW_ON_ERROR); }
            };
        }
    }
}
namespace Joomla\Database {
    interface DatabaseInterface {}
    final class TestQuery {
        public array $sets = []; public array $conditions = [];
        public function update(string $name): self { return $this; }
        public function select(string $columns): self { return $this; }
        public function from(string $name): self { return $this; }
        public function set(string $value): self { $this->sets[] = $value; return $this; }
        public function where(string $value): self { $this->conditions[] = $value; return $this; }
    }
    final class TestDatabase implements DatabaseInterface {
        public object $row; private TestQuery $query; private int $affected = 0;
        public function getQuery(bool $new): TestQuery { return new TestQuery(); }
        public function quoteName(string $name): string { return $name; }
        public function quote(string $value): string { return "'" . str_replace("'", "''", $value) . "'"; }
        public function setQuery(TestQuery $query): self { $this->query = $query; return $this; }
        public function loadObject(): object { return clone $this->row; }
        public function execute(): self {
            $this->affected = 0;
            foreach ($this->query->conditions as $condition) {
                if (str_starts_with($condition, 'custom_data = ') && $condition !== 'custom_data = ' . $this->quote((string) $this->row->custom_data)) { return $this; }
                if ($condition === 'custom_data IS NULL' && $this->row->custom_data !== null) { return $this; }
            }
            foreach ($this->query->sets as $assignment) {
                if (!preg_match("/^(params|custom_data) = '(.*)'$/sD", $assignment, $match)) { throw new \RuntimeException('Unexpected assignment'); }
                $this->row->{$match[1]} = str_replace("''", "'", $match[2]);
            }
            $this->affected = 1; return $this;
        }
        public function getAffectedRows(): int { return $this->affected; }
    }
}
namespace Joomla\CMS {
    class Factory {
        public static object $db;
        public static function getContainer(): object { return new class { public function get(string $type): object { return Factory::$db; } }; }
    }
}
namespace Joomla\CMS\Uri { class Uri { public static function root(): string { return 'https://site.example/'; } } }
namespace Joomla\CMS\Http {
    class HttpFactory {
        public static function getHttp(array $options): object {
            if (($options['follow_location'] ?? true) !== false) { throw new \RuntimeException('Redirects must be disabled'); }
            return new class {
                private function response(array $body): object { return new class($body) {
                    public function __construct(private array $body) {}
                    public function getStatusCode(): int { return 200; }
                    public function getBody(): string { return json_encode($this->body, JSON_THROW_ON_ERROR); }
                }; }
                public function get(string $url, array $headers): object {
                    if (($headers['Authorization'] ?? '') !== 'Bearer activation_token') { throw new \RuntimeException('Missing authentication'); }
                    return $this->response(['entitled' => true]);
                }
                public function post(string $url, string $body, array $headers): object {
                    $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
                    if (str_ends_with($url, '/activate')) { return $this->response(['token' => 'activation_token', 'installationId' => $data['installationId']]); }
                    if (($headers['Authorization'] ?? '') !== 'Bearer activation_token') { throw new \RuntimeException('Missing authentication'); }
                    return $this->response(['ok' => true]);
                }
            };
        }
    }
}
namespace Joomla\Event { interface SubscriberInterface { public static function getSubscribedEvents(): array; } }
namespace Joomla\CMS\Event\Installer {
    class BeforePackageDownloadEvent {
        public function __construct(private string $url, private array $headers) {}
        public function getUrl(): string { return $this->url; }
        public function getHeaders(): array { return $this->headers; }
        public function updateHeaders(array $headers): void { $this->headers = $headers; }
    }
    class BeforeUpdateSiteDownloadEvent extends BeforePackageDownloadEvent {}
}
namespace {
    define('_JEXEC', 1);
    require __DIR__ . '/../examples/joomla/src/Extension/Entitle.php';
    use Entitle\Plugin\Installer\Entitle\Extension\Entitle;
    use Joomla\CMS\Event\Installer\BeforePackageDownloadEvent;
    use Joomla\CMS\Event\Installer\BeforeUpdateSiteDownloadEvent;
    use Joomla\CMS\Factory;
    function check(bool $condition, string $message = 'Template contract assertion failed'): void { if (!$condition) { throw new \RuntimeException($message); } }
    $api = 'https://updates.example/api/v1/tenants/vendor';
    $feed = $api . '/updates/joomla/example.xml';
    $asset = $api . '/packages/example/assets/uuid-1/example.zip';
    $params = ['api_base' => $api, 'product' => 'example'];
    $db = new \Joomla\Database\TestDatabase(); Factory::$db = $db;
    $opaque = ['unknown_owner' => ['apostrophe' => "don't touch", 'nested' => [1, null, false, (object) ['anything' => 'retained']]]];
    $db->row = (object) ['params' => json_encode($params), 'custom_data' => json_encode($opaque)];
    $plugin = new Entitle($params);
    $plugin->activate('license-key');
    $identity = $plugin->installationId();
    $plugin->activate('license-key');
    check($plugin->installationId() === $identity, 'Repeated activation changed identity');
    // Joomla filters params against form fields, then replaces the entire params column.
    $db->row->params = json_encode($params);
    $plugin = new Entitle(json_decode($db->row->params, true));
    check($plugin->installationId() === $identity, 'Saving plugin settings changed the stable installation UUID');
    check($plugin->status()['entitled'] === true, 'Saving plugin settings lost the activation token');
    $custom = json_decode($db->row->custom_data, true);
    check($custom['unknown_owner'] === json_decode(json_encode($opaque['unknown_owner']), true), 'Opaque custom_data was modified');
    check(count(Entitle::getSubscribedEvents()) === 2);
    foreach ([new BeforeUpdateSiteDownloadEvent($feed, ['Accept' => 'application/xml']), new BeforePackageDownloadEvent($asset, ['Accept' => 'application/zip'])] as $event) {
        $plugin->headers($event);
        check($event->getHeaders()['Authorization'] === 'Bearer activation_token'); check(isset($event->getHeaders()['Accept']));
    }
    foreach ([str_replace('updates.example', 'attacker.example', $asset), str_replace('/example/', '/another/', $asset), $feed . '?token=bad', $asset . '#part', str_replace('https:', 'http:', $asset), str_replace('https://', 'https://user:pass@', $asset), str_replace('updates.example', 'updates.example:444', $asset), $api . '/seller/products', $api . '/packages/example/assets/../asset/example.zip', $api . '/packages/example-other/assets/a/file.zip'] as $url) {
        check(!Entitle::permits($api, 'example', $url));
        $event = new BeforePackageDownloadEvent($url, ['Original' => 'retained']); $plugin->headers($event); check($event->getHeaders() === ['Original' => 'retained']);
    }
    $plugin->deactivate();
    check($plugin->installationId() === $identity, 'Deactivation changed the stable installation UUID');
    $event = new BeforeUpdateSiteDownloadEvent($feed, []); $plugin->headers($event); check($event->getHeaders() === [], 'Deactivation retained authentication headers');
    $custom = json_decode($db->row->custom_data, true);
    check($custom['entitle']['activation_token'] === '', 'Deactivation did not clear the stored token');
    check(json_decode($db->row->params, true) === $params, 'State writes modified form-managed params');
    // Existing prototype params migrate without changing the licensed identity.
    $db->row->custom_data = json_encode($opaque);
    $legacy = new Entitle($params + ['installation_id' => $identity, 'activation_token' => 'activation_token']);
    check($legacy->installationId() === $identity);
    check(json_decode($db->row->custom_data, true)['entitle']['activation_token'] === 'activation_token', 'Legacy params were not migrated');
    // A non-JSON opaque value must survive untouched, rather than being replaced.
    $db->row->custom_data = 'opaque data owned by an existing integration';
    try { (new Entitle($params))->installationId(); throw new \LogicException('Malformed custom_data was accepted'); }
    catch (\RuntimeException $expected) { check($db->row->custom_data === 'opaque data owned by an existing integration'); }
    echo "Joomla scoped feed/package and settings persistence contracts passed\n";
}
