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
    const buildInfo = JSON.parse(
      fs.readFileSync(`build/mv3/${platform}/build-info.json`, "utf8"),
    );
    assert.equal(buildInfo.platform, platform);
    assert.match(buildInfo.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(buildInfo.builtAt)));
    const appSource = fs.readFileSync(`build/mv3/${platform}/app.js`, "utf8");
    assert.ok(appSource.includes(buildInfo.sourceHash));
    assert.ok(appSource.includes(buildInfo.builtAt));
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
      let installed;
      const tabs = [];
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
          onInstalled: {
            addListener(fn) {
              installed = fn;
              listeners.push(fn);
            },
          },
        },
        tabs: {
          async create(tab) {
            tabs.push(tab);
          },
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
      const rpc = (type, data = {}) =>
        message(
          { type, ...data },
          { id: "test", url: "test-extension://test/app.html" },
        );
      rpc.alarm = () => alarm({ name: "xbs-mv3-sync" });
      rpc.timers = timers;
      rpc.api = api;
      rpc.installed = installed;
      rpc.tabs = tabs;
      return rpc;
    }
    const first = await boot()("status");
    assert.equal(first.ok, true);
    assert.equal(first.data.connected, false);
    assert.deepEqual(JSON.parse(JSON.stringify(first.data.build)), buildInfo);
    const rpc = boot();
    rpc.installed({ reason: "update" });
    assert.equal(rpc.tabs.length, 0);
    rpc.installed({ reason: "install" });
    assert.equal(rpc.tabs.length, 1);
    assert.equal(rpc.tabs[0].url, "test-extension://test/app.html");
    const restarted = await rpc("status");
    assert.equal(restarted.ok, true);
    assert.equal(restarted.data.enabled, false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(restarted.data.build)),
      buildInfo,
    );
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
    let release, started;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    let calls = 0;
    rpc.api.bookmarks.getTree = async () => {
      calls++;
      started();
      await gate;
      throw Error("test delayed native operation");
    };
    const runs = Array.from({ length: 50 }, () => rpc.alarm());
    await entered;
    const paused = rpc("pause", { enabled: false });
    release();
    await Promise.all([...runs, paused]);
    assert.equal(
      calls,
      1,
      "overlapping alarms must share one run, not queue restore chunks",
    );
    assert.equal((await rpc("status")).data.enabled, false);
  });

for (const platform of ["firefox", "chromium"])
  test(`${platform} app bundle routes direction selection and server folder navigation`, async () => {
    const directory = `build/mv3/${platform}`;
    const html = fs.readFileSync(`${directory}/app.html`, "utf8");
    const build = JSON.parse(
      fs.readFileSync(`${directory}/build-info.json`, "utf8"),
    );
    const element = () => ({
      value: "",
      textContent: "",
      children: [],
      dataset: {},
      classList: { toggle() {} },
      addEventListener() {},
      replaceChildren() {
        this.children = [];
      },
      append(child) {
        this.children.push(child);
      },
    });
    const nodes = new Map(
      [...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element()]),
    );
    const get = (id) => {
      assert.ok(nodes.has(id), `missing HTML element ${id}`);
      return nodes.get(id);
    };
    const messages = [];
    const state = {
      connected: true,
      mode: "download",
      preview: true,
      enabled: false,
      url: "https://example.com",
      id: "test",
      build,
    };
    const storage = { get: async () => ({}), set: async () => {} };
    const api = {
      runtime: {
        id: "test",
        async sendMessage(message) {
          messages.push(message);
          if (message.type === "mode") state.mode = message.mode;
          if (message.type === "server-list") {
            const folders = message.options.view === "folders";
            const child = message.options.parent === 3;
            return {
              ok: true,
              data: {
                total: 1,
                offset: 0,
                limit: 100,
                path: child ? [{ id: 3, title: "Folder" }] : [],
                items: [
                  folders && !child
                    ? { id: 3, title: "Folder", folder: true, count: 1 }
                    : {
                        id: 4,
                        title: "<script>text only</script>",
                        url: "javascript:alert(1)",
                        folder: false,
                      },
                ],
                lastUpdated: "test",
                fetchedAt: "test",
              },
            };
          }
          return { ok: true, data: { ...state } };
        },
      },
      storage: { local: storage, session: storage },
      permissions: { contains: async () => true },
    };
    vm.runInNewContext(fs.readFileSync(`${directory}/app.js`, "utf8"), {
      browser: api,
      chrome: api,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      console,
      document: {
        getElementById: get,
        querySelectorAll: () => [],
        createElement: element,
      },
      location: { search: "" },
      setInterval() {},
      setTimeout,
      clearTimeout,
      confirm: () => true,
    });
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    await flush();
    assert.equal(get("sync-mode").value, "download");
    get("sync-mode").value = "both";
    get("sync-mode").onchange();
    await get("save-mode").onclick();
    assert.equal(state.mode, "both");
    assert.equal(get("save-mode").disabled, true);
    get("view-folders").onclick();
    await flush();
    const folderButton = get("results").children[0].children[0];
    assert.match(folderButton.textContent, /Folder/);
    folderButton.onclick();
    await flush();
    assert.equal(messages.at(-1).options.parent, 3);
    assert.equal(get("folder-path").children.length, 2);
    assert.equal(
      get("results").children[0].textContent,
      "<script>text only</script>",
    );
    assert.equal(
      get("results").children[0].children.length,
      0,
      "unsafe URL is plain text",
    );
    get("view-recent").onclick();
    await flush();
    assert.equal(messages.at(-1).options.view, "recent");
    assert.equal(get("folder-path").children.length, 0);
    assert.equal(
      messages.some((m) => ["restore", "sync"].includes(m.type)),
      false,
    );
  });
