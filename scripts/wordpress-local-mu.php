<?php
/** Plugin Name: Doublesharp Entitle local integration transport */
// Docker fixture only: permit this one loopback origin through WP's SSRF checks.
add_filter('http_request_host_is_external', function ($external, $host, $url) {
    $parts = wp_parse_url($url);
    return $host === 'localhost' && isset($parts['scheme'], $parts['port']) && $parts['scheme'] === 'http' && $parts['port'] === 3211 ? true : $external;
}, 10, 3);
add_filter('http_allowed_safe_ports', function ($ports, $host, $url) {
    $parts = wp_parse_url($url);
    if ($host === 'localhost' && isset($parts['scheme'], $parts['port']) && $parts['scheme'] === 'http' && $parts['port'] === 3211) { $ports[] = 3211; }
    return array_unique($ports);
}, 10, 3);
