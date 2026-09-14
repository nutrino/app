// Offline smoke test of the emitted bundle. No browser profile or network is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

async function withDeadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Message response timed out')), 2000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const buildRoot = path.resolve(process.argv[2] || 'build');
  for (const platform of ['chromium', 'firefox']) {
    const root = path.join(buildRoot, platform);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.action.default_popup);
    assert.ok(!manifest.browser_action);
    const background = platform === 'chromium' ? manifest.background.service_worker : manifest.background.scripts[0];
    const events = new Map();
    const event = (name) => {
      if (!events.has(name)) events.set(name, new Set());
      return {
        addListener: (fn) => events.get(name).add(fn),
        removeListener: (fn) => events.get(name).delete(fn),
        hasListener: (fn) => events.get(name).has(fn)
      };
    };
    const api = new Proxy({}, {
      get: (_, name) => String(name).startsWith('on') ? event(name) : () => Promise.resolve()
    });
    const browser = {
      runtime: {
        id: 'mv3-offline-test', getManifest: () => manifest,
        onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')
      },
      alarms: api, notifications: api, bookmarks: api, storage: api
    };
    const context = {
      console, URL, TextEncoder, TextDecoder, AbortController, crypto: webcrypto,
      setTimeout, clearTimeout, setInterval, clearInterval,
      navigator: { userAgent: 'Mozilla/5.0 Chrome/140.0', onLine: true },
      chrome: browser, browser,
      fetch: () => { throw new Error('Network access forbidden in smoke test'); },
      indexedDB: { open: () => { throw new Error('Unexpected storage access during synchronous bootstrap'); } }
    };
    context.self = context;
    // Deliberately no window, document, DOMParser or URL.createObjectURL.
    context.URL = class WorkerURL extends URL {};
    context.URL.createObjectURL = undefined;
    vm.runInNewContext(fs.readFileSync(path.join(root, background), 'utf8'), context, { timeout: 10000 });
    assert.equal(events.get('message').size, 1, 'one synchronous message handler');
    assert.equal(events.get('installed').size, 1);
    assert.equal(events.get('startup').size, 1);
    const [onMessage] = events.get('message');
    assert.equal(await withDeadline(onMessage({ command: 'GET_CURRENT_SYNC' })), undefined);
    assert.equal(await withDeadline(onMessage({ command: 'GET_SYNC_QUEUE_LENGTH' })), 0);
    for (const html of ['app.html']) {
      for (const match of fs.readFileSync(path.join(root, html), 'utf8').matchAll(/<script src="([^"]+)"/g)) {
        assert.ok(fs.existsSync(path.join(root, match[1])), `missing script: ${match[1]}`);
      }
    }
    console.log(`${platform}: MV3 manifest, DOM-free bootstrap, message round trips and script assets passed`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
