const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

(async () => {
  const extensionPath = path.resolve('build/chromium');
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pw-ext-profile-sw5'), {
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
  const page = await context.newPage();
  await page.goto('chrome-extension://'+ (await sw.evaluate(() => chrome.runtime.id)) +'/app.html', { waitUntil: 'load', timeout: 15000 });
  await page.evaluate(() => chrome.runtime.sendMessage({ ping: true }).catch(() => {}));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const info = await sw.evaluate(() => ({
    registeredOnConnect: Boolean(self.__xbOnConnectAttempted),
    registeredOnMessage: Boolean(self.__xbOnMessageAttempted),
    hasOnConnectListener: self.chrome?.runtime?.onConnect?.hasListeners?.() || false,
    hasOnMessageListener: self.chrome?.runtime?.onMessage?.hasListeners?.() || false
  }));
  console.log(info);
  await context.close();
})();
