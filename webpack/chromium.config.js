const Path = require('path');
const WebExtConfig = require('./webext.config');

module.exports = (env, argv) => {
  const webExtConfig = WebExtConfig(env, argv);
  const copyPlugin = webExtConfig.plugins.find((p) => p.constructor && p.constructor.name === 'CopyPlugin');
  if (copyPlugin) {
    const manifestPattern = copyPlugin.patterns.find((pattern) => pattern.to?.includes('manifest.json'));
    if (manifestPattern) {
      manifestPattern.from = './res/webext/manifest.chromium.json';
    }
  }
  const optimization = webExtConfig.optimization ?? {};
  const splitChunks = optimization.splitChunks ?? {};
  const cacheGroups = splitChunks.cacheGroups ?? {};
  const vendorGroup = cacheGroups.vendor ?? {};
  const vendorTest = vendorGroup.test;

  const isWebExtensionPolyfill = (module) =>
    Boolean(module.resource && module.resource.includes(`${Path.sep}webextension-polyfill${Path.sep}`));

  return {
    ...webExtConfig,
    entry: {
      ...webExtConfig.entry,
      app: './src/modules/webext/chromium/chromium-app/chromium-app.module.ts',
      background: './src/modules/webext/chromium/chromium-background/chromium-background.module.ts',
      'background-sw': './src/modules/webext/chromium/chromium-background/chromium-service-worker.ts'
    },
    optimization: {
      ...optimization,
      splitChunks: {
        ...splitChunks,
        cacheGroups: {
          ...cacheGroups,
          vendor: {
            ...vendorGroup,
            test: (module, ...rest) => {
              if (isWebExtensionPolyfill(module)) {
                return false;
              }

              if (typeof vendorTest === 'function') {
                return vendorTest(module, ...rest);
              }

              if (vendorTest instanceof RegExp) {
                return Boolean(module.resource && vendorTest.test(module.resource));
              }

              const resource = module.resource || '';
              return /node_modules/.test(resource);
            }
          },
          'webextension-polyfill': {
            chunks: 'all',
            enforce: true,
            name: 'webextension-polyfill',
            test: (module) => isWebExtensionPolyfill(module)
          }
        }
      }
    },
    output: {
      ...webExtConfig.output,
      path: Path.resolve(__dirname, '../build/chromium/assets')
    }
  };
};
