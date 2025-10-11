const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

(async () => {
  const extensionPath = path.resolve('build/chromium');
  const context = await chromium.launchPersistentContext(path.join(os.tmpdir(), 'pw-ext-profile-background'), {
    headless: false,
    args: [
      '--disable-extensions-except=' + extensionPath,
      '--load-extension=' + extensionPath,
      '--disable-component-extensions-with-background-pages'
    ]
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    console.log('BACKGROUND CONSOLE:', msg.type(), msg.text());
  });
  page.on('pageerror', (err) => {
    console.log('BACKGROUND ERROR:', err.stack || err.message);
  });

  await page.goto('chrome-extension://lbbddmfcagliphlkbmdliladkllbjalg/background.html', { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(5000);
  await context.close();
})();
