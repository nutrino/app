const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

(async () => {
  const extensionPath = path.resolve('build/chromium');
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pw-ext-profile-sw6'), {
    headless: false,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
      '--disable-component-extensions-with-background-pages'
    ]
  });

  const waitForServiceWorker = async () => {
    for (let i = 0; i < 40; i += 1) {
      const workers = context.serviceWorkers();
      if (workers.length > 0) {
        return workers[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Service worker not found');
  };

  const sw = await waitForServiceWorker();
  const info = await sw.evaluate(() => ({
    typeofImportScripts: typeof importScripts,
    browserDefined: typeof self.browser !== 'undefined',
    chromeDefined: typeof self.chrome !== 'undefined',
    browserError: self.__xbBrowserError || null
  }));
  console.log(info);
  await context.close();
})();
