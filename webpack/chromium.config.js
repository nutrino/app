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
  return {
    ...webExtConfig,
    entry: {
      ...webExtConfig.entry,
      app: './src/modules/webext/chromium/chromium-app/chromium-app.module.ts',
      background: './src/modules/webext/chromium/chromium-background/chromium-background.module.ts',
      'background-sw': './src/modules/webext/chromium/chromium-background/chromium-service-worker.ts'
    },
    output: {
      ...webExtConfig.output,
      path: Path.resolve(__dirname, '../build/chromium/assets')
    }
  };
};
