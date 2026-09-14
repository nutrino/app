import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
for (const platform of ["firefox", "chromium"])
  test(`${platform} emitted MV3 worker boots without DOM and answers after restart`, async () => {
    const source = fs.readFileSync(
      `build/mv3/${platform}/background.js`,
      "utf8",
    );
    const manifest = JSON.parse(
      fs.readFileSync(`build/mv3/${platform}/manifest.json`, "utf8"),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, [
      "bookmarks",
      "storage",
      "alarms",
      "unlimitedStorage",
    ]);
    assert.ok(
      platform === "firefox"
        ? manifest.background.scripts
        : manifest.background.service_worker,
    );
    const indexedDB = new IDBFactory();
    function boot() {
      let message;
      let alarm;
      const timers = [];
      const listeners = [];
      const event = () => ({
        addListener(fn) {
          listeners.push(fn);
        },
      });
      const api = {
        runtime: {
          id: "test",
          getURL: (path) => "test-extension://test/" + path,
          onMessage: {
            addListener(fn) {
              message = fn;
            },
          },
          onStartup: event(),
          onInstalled: event(),
        },
        bookmarks: {
          getTree: async () => {
            throw Error("simulated API failure");
          },
        },
        alarms: {
          onAlarm: {
            addListener(fn) {
              alarm = fn;
              listeners.push(fn);
            },
          },
          create() {},
        },
        action: { setBadgeText: async () => {} },
      };
      for (const name of [
        "onCreated",
        "onChanged",
        "onMoved",
        "onRemoved",
        "onChildrenReordered",
        "onImportEnded",
      ])
        api.bookmarks[name] = event();
      const context = {
        browser: api,
        chrome: api,
        indexedDB,
        IDBKeyRange,
        setTimeout: (fn, delay) => {
          timers.push(delay);
          return timers.length;
        },
        clearTimeout() {},
        console,
        crypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        ArrayBuffer,
        URL,
        btoa,
        atob,
        fetch,
        AbortController,
      };
      context.self = context;
      vm.runInNewContext(source, context, { timeout: 3000 });
      assert.equal(typeof message, "function");
      assert.ok(listeners.length >= 8);
      const rpc = (type) =>
        message(
          { type },
          { id: "test", url: "test-extension://test/app.html" },
        );
      rpc.alarm = () => alarm({ name: "xbs-mv3-sync" });
      rpc.timers = timers;
      return rpc;
    }
    const first = await boot()("status");
    assert.equal(first.ok, true);
    assert.equal(first.data.connected, false);
    const rpc = boot();
    const restarted = await rpc("status");
    assert.equal(restarted.ok, true);
    assert.equal(restarted.data.enabled, false);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("xbrowsersync-mv3-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    for (const enabled of [false, true]) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("data", "readwrite");
        tx.objectStore("data").put(
          { enabled, config: {}, pending: true },
          "state",
        );
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      const count = rpc.timers.length;
      await rpc.alarm();
      assert.equal(
        rpc.timers.length,
        count,
        "paused or failed pending uploads must not spin a fast retry timer",
      );
    }
  });
