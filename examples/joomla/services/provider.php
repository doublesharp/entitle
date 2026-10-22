<?php
/**
 * Register the installer plugin with Joomla's dependency-injection container.
 * Joomla loads this file when booting the enabled plugin. Activation happens later
 * through a protected administrator settings action, not during registration.
 */
defined('_JEXEC') or die;

use Entitle\Plugin\Installer\Entitle\Extension\Entitle;
use Joomla\CMS\Extension\PluginInterface;
use Joomla\CMS\Factory;
use Joomla\CMS\Plugin\PluginHelper;
use Joomla\DI\Container;
use Joomla\DI\ServiceProviderInterface;
use Joomla\Event\DispatcherInterface;

return new class implements ServiceProviderInterface {
    /**
     * Define the factory Joomla uses to construct the plugin with native services.
     *
     * @param Container $container Joomla service container for this extension.
     * @return void
     */
    public function register(Container $container): void
    {
        $container->set(PluginInterface::class, function (Container $container) {
            // Step 1: supply the native dispatcher and saved plugin configuration.
            $plugin = new Entitle($container->get(DispatcherInterface::class), (array) PluginHelper::getPlugin('installer', 'entitle'));
            // Step 2: attach the current application before returning the instance.
            $plugin->setApplication(Factory::getApplication());
            return $plugin;
        });
    }
};
