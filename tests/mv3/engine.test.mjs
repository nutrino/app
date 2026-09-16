import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../../src/mv3/engine.mjs";
import { Native } from "../../src/mv3/native.mjs";
import {
  Api,
  ROOTS,
  validateTree,
  deriveKey,
  encrypt,
  decrypt,
  hash,
  hostPermission,
} from "../../src/mv3/protocol.mjs";
export class MemoryStore {
  data = new Map();
  async get(k) {
    return structuredClone(this.data.get(k));
  }
  async put(entries) {
    for (const [k, v] of Object.entries(entries))
      v === undefined
        ? this.data.delete(k)
        : this.data.set(k, structuredClone(v));
  }
  async entries(prefix) {
    return [...this.data].filter(([k]) => k.startsWith(prefix));
  }
}
export class Bookmarks {
  constructor(firefox = true) {
    this.next = 100;
    this.firefox = firefox;
    this.tree = {
      id: "0",
      children: firefox
        ? [
            { id: "toolbar_____", title: "Toolbar", children: [] },
            { id: "menu________", title: "Menu", children: [] },
            { id: "unfiled_____", title: "Other", children: [] },
          ]
        : [
            { id: "1", title: "Toolbar", children: [] },
            { id: "2", title: "Other", children: [] },
          ],
    };
  }
  find(id, node = this.tree) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = this.find(id, child);
      if (found) return found;
    }
  }
  async getTree() {
    return [structuredClone(this.tree)];
  }
  async get(id) {
    const node = this.find(id);
    if (!node) throw Error("not found");
    return [structuredClone(node)];
  }
  async getChildren(id) {
    return structuredClone(this.find(id).children);
  }
  async create(spec) {
    const parent = this.find(spec.parentId);
    if (!parent?.children) throw Error("bad parent");
    const node = {
      id: String(this.next++),
      title: spec.title || "",
      parentId: parent.id,
    };
    if (spec.type === "separator") node.type = "separator";
    else if (spec.url !== undefined) node.url = spec.url;
    else node.children = [];
    parent.children.splice(spec.index ?? parent.children.length, 0, node);
    if (this.crash) {
      this.crash = false;
      throw Error("simulated crash after native create");
    }
    return structuredClone(node);
  }
  async removeTree(id) {
    const node = this.find(id);
    const parent =
      this.find(node.parentId) ||
      this.tree.children.find((r) => r.children?.some((n) => n.id === id));
    parent.children.splice(
      parent.children.findIndex((n) => n.id === id),
      1,
    );
  }
  async move(id, { index }) {
    const node = this.find(id);
    const parent = this.find(node.parentId);
    const from = parent.children.findIndex((child) => child.id === id);
    parent.children.splice(index, 0, parent.children.splice(from, 1)[0]);
    return structuredClone(node);
  }
  async update(id, changes) {
    const node = this.find(id);
    Object.assign(node, changes);
    return structuredClone(node);
  }
}
const tree = validateTree([
  {
    id: 0,
    title: ROOTS[0],
    children: [
      {
        id: 3,
        title: "Folder",
        children: [
          {
            id: 4,
            title: "Example",
            url: "https://example.com/",
            description: "Keep metadata",
            tags: ["tag"],
          },
        ],
      },
      { id: 5, url: "xbs:separator" },
    ],
  },
  {
    id: 1,
    title: ROOTS[1],
    children: [{ id: 6, title: "Menu entry", url: "https://example.org/" }],
  },
  {
    id: 2,
    title: ROOTS[2],
    children: [{ id: 7, title: "Other entry", url: "https://example.net/" }],
  },
]);
const key = await deriveKey(
  "test-password-only",
  "0123456789abcdef0123456789abcdef",
);
async function setup(firefox = true) {
  const store = new MemoryStore();
  const bookmarks = new Bookmarks(firefox);
  const native = new Native(bookmarks, firefox);
  const server = {
    bookmarks: await encrypt(tree, key),
    lastUpdated: "2026-01-01T00:00:00.000Z",
  };
  let writes = 0;
  const api = {
    path: (x) => x,
    request: async () => ({ version: "1.6.0" }),
    read: async () => structuredClone(server),
    write: async (cipher, timestamp) => {
      if (timestamp !== server.lastUpdated) throw Error("conflict");
      server.bookmarks = cipher;
      server.lastUpdated = new Date(
        Date.parse(server.lastUpdated) + 1000,
      ).toISOString();
      writes++;
      if (api.loseResponse) {
        api.loseResponse = false;
        throw Error("response lost");
      }
      return server.lastUpdated;
    },
  };
  const engine = new Engine(store, native, () => api);
  await store.put({
    state: {
      config: { url: "https://example.com", id: "test", key },
      preview: true,
      enabled: false,
      lastUpdated: server.lastUpdated,
    },
  });
  return {
    store,
    bookmarks,
    native,
    server,
    api,
    engine,
    writes: () => writes,
  };
}
async function restore(ctx) {
  await ctx.engine.startRestore();
  await ctx.engine.tick();
  assert.equal((await ctx.engine.status()).error, undefined);
  assert.equal((await ctx.engine.status()).applying, false);
}
test("wire format encrypt/decrypt, bad password and malformed tree", async () => {
  assert.deepEqual(await decrypt(await encrypt(tree, key), key), tree);
  await assert.rejects(
    decrypt(await encrypt(tree, key), await deriveKey("wrong", "salt")),
  );
  assert.throws(() =>
    validateTree([
      {
        id: 0,
        title: ROOTS[0],
        children: [{ id: 0, url: "https://example.com" }],
      },
    ]),
  );
  assert.equal(
    hostPermission("http://localhost:8686/api/"),
    "http://localhost/*",
  );
  assert.throws(() => hostPermission("https://user:pass@example.com"));
});
for (const firefox of [true, false])
  test(`${firefox ? "Firefox" : "Chromium"} restore, metadata, local edit, upload`, async () => {
    const c = await setup(firefox);
    await restore(c);
    assert.deepEqual(
      (
        await c.native.snapshot(
          await c.store.get("base"),
          await c.store.get("mapping"),
        )
      ).tree,
      tree,
    );
    const id = Object.entries(await c.store.get("mapping")).find(
      ([, id]) => id === 4,
    )[0];
    c.bookmarks.find(id).title = "Edited";
    await c.engine.tick();
    assert.equal(c.writes(), 1);
    const uploaded = await decrypt(c.server.bookmarks, key);
    assert.equal(uploaded[0].children[0].children[0].title, "Edited");
    assert.deepEqual(uploaded[0].children[0].children[0].tags, ["tag"]);
  });
test("create interrupted after native side effect resumes without duplicate", async () => {
  const c = await setup();
  await c.engine.startRestore();
  c.bookmarks.crash = true;
  await c.engine.tick();
  assert.equal((await c.engine.status()).enabled, false);
  const restarted = new Engine(c.store, c.native, () => c.api);
  await restarted.pause(true);
  await restarted.tick();
  assert.equal((await restarted.status()).error, undefined);
  assert.deepEqual(await c.store.get("base"), tree);
});
test("persisted checkpoint mappings survive worker termination before chunk save", async () => {
  const c = await setup();
  await c.engine.startRestore();
  const originalPut = c.store.put.bind(c.store);
  let crashed = false;
  c.store.put = async (entries) => {
    await originalPut(entries);
    if (
      !crashed &&
      Object.keys(entries).some((k) => k.startsWith("created:"))
    ) {
      crashed = true;
      throw Error("worker terminated after commit");
    }
  };
  await c.engine.tick();
  c.store.put = originalPut;
  const restarted = new Engine(c.store, c.native, () => c.api);
  await restarted.pause(true);
  await restarted.tick();
  assert.equal((await restarted.status()).error, undefined);
  assert.deepEqual(await c.store.get("base"), tree);
});
test("lost upload response is verified before retry, not overwritten", async () => {
  const c = await setup();
  await restore(c);
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "New",
    url: "https://new.example/",
  });
  c.api.loseResponse = true;
  await c.engine.tick();
  assert.equal((await c.engine.state()).pending, true);
  assert.equal(c.writes(), 1);
  await c.engine.tick();
  assert.equal((await c.engine.state()).pending, false);
  assert.equal(c.writes(), 1);
});
test("concurrent local and remote changes stop and retain both sides", async () => {
  const c = await setup();
  await restore(c);
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "Local",
    url: "https://local.example/",
  });
  const remote = structuredClone(tree);
  remote[0].children.push({
    id: 50,
    title: "Remote",
    url: "https://remote.example/",
  });
  c.server.bookmarks = await encrypt(remote, key);
  c.server.lastUpdated = "2026-01-02T00:00:00.000Z";
  await c.engine.tick();
  assert.equal((await c.engine.status()).conflict, true);
  assert.equal(c.writes(), 0);
  assert.ok(
    (await c.engine.export("conflictLocal")).bookmarks[0].children.some(
      (n) => n.title === "Local",
    ),
  );
  await c.engine.resolve("local");
  await c.engine.tick();
  assert.equal(c.writes(), 1);
  assert.ok(
    (await c.engine.export("conflictRemote")).bookmarks[0].children.some(
      (n) => n.title === "Remote",
    ),
  );
});
test("bad remote ciphertext never deletes native data", async () => {
  const c = await setup();
  await restore(c);
  const before = await c.bookmarks.getTree();
  c.server.bookmarks = "broken";
  c.server.lastUpdated = "2026-01-02T00:00:00.000Z";
  await c.engine.tick();
  assert.deepEqual(await c.bookmarks.getTree(), before);
  assert.match((await c.engine.status()).error, /복호화/);
});
test("server-only change backs up original and applies target", async () => {
  const c = await setup(false);
  await restore(c);
  const next = structuredClone(tree);
  next[0].children[0].title = "Remote folder";
  c.server.bookmarks = await encrypt(next, key);
  c.server.lastUpdated = "2026-01-02T00:00:00.000Z";
  await c.engine.tick();
  await c.engine.tick();
  assert.deepEqual(await c.store.get("base"), next);
  assert.deepEqual((await c.engine.export("backup")).bookmarks, tree);
});
test("backup restore pauses; resume uploads recovered data", async () => {
  const c = await setup();
  await restore(c);
  const changed = structuredClone(tree);
  changed[0].children[0].title = "Recovered";
  await c.engine.restoreBackup({ bookmarks: changed });
  await c.engine.tick();
  assert.equal((await c.engine.status()).enabled, false);
  await c.engine.pause(true);
  await c.engine.tick();
  assert.equal(c.writes(), 1);
  assert.deepEqual(await decrypt(c.server.bookmarks, key), changed);
});
test("API rejects redirects/malformed dates and bounds response", async () => {
  let options;
  const api = new Api(
    { url: "https://example.com", id: "id" },
    async (url, o) => {
      options = o;
      return new Response(
        JSON.stringify({ bookmarks: "x", lastUpdated: "bad" }),
      );
    },
  );
  await assert.rejects(api.read());
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
});
test("76,010-item encrypted dataset restores with metadata intact", async () => {
  const c = await setup();
  const large = validateTree([
    {
      id: 0,
      title: ROOTS[0],
      children: Array.from({ length: 76007 }, (_, index) => ({
        id: index + 3,
        title: `북마크 ${index}`,
        url: `https://example.com/${index}`,
        description: "대량 동기화",
        tags: ["test"],
      })),
    },
    { id: 1, title: ROOTS[1], children: [] },
    { id: 2, title: ROOTS[2], children: [] },
  ]);
  c.server.bookmarks = await encrypt(large, key);
  assert.deepEqual(await decrypt(c.server.bookmarks, key), large);
  await c.engine.startRestore();
  for (let i = 0; i < 100 && (await c.engine.status()).applying; i++) {
    await c.engine.tick();
    assert.equal((await c.engine.status()).error, undefined);
  }
  assert.equal((await c.engine.status()).count, 76010);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal(await hash(await c.store.get("base")), await hash(large));
  await previewAgain(c);
  for (const op of ["create", "update", "move", "removeTree"])
    c.bookmarks[op] = async () =>
      assert.fail(`identical large download called ${op}`);
  await c.engine.startRestore();
  await finishInitial(c);
  assert.equal(await hash(await c.store.get("base")), await hash(large));
  assert.equal(c.writes(), 0);
});
test("local edit while remote read is pending is not discarded", async () => {
  const c = await setup();
  await restore(c);
  c.server.lastUpdated = "2026-01-02T00:00:00.000Z";
  const read = c.api.read;
  c.api.read = async () => {
    await c.bookmarks.create({
      parentId: "toolbar_____",
      title: "During request",
      url: "https://new.example/",
    });
    return read();
  };
  await c.engine.tick();
  assert.equal((await c.engine.status()).applying, false);
  assert.ok(
    (await c.bookmarks.getChildren("toolbar_____")).some(
      (n) => n.title === "During request",
    ),
  );
});
test("offline edits remain local and upload after reconnect", async () => {
  const c = await setup();
  await restore(c);
  const read = c.api.read;
  c.api.read = async () => {
    throw Error("offline");
  };
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "Offline",
    url: "https://offline.example/",
  });
  await c.engine.tick();
  assert.equal(c.writes(), 0);
  c.api.read = read;
  await c.engine.tick();
  assert.equal(c.writes(), 1);
  assert.ok(
    (await decrypt(c.server.bookmarks, key))[0].children.some(
      (n) => n.title === "Offline",
    ),
  );
});
test("failed native restore can roll back to the original backup", async () => {
  const c = await setup();
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "Original local",
    url: "https://original.example/",
  });
  await c.engine.startRestore();
  const create = c.bookmarks.create.bind(c.bookmarks);
  c.bookmarks.create = async () => {
    throw Error("native create failed");
  };
  await c.engine.tick();
  assert.equal((await c.engine.status()).enabled, false);
  c.bookmarks.create = create;
  await c.engine.rollback();
  await c.engine.tick();
  assert.equal((await c.engine.status()).error, undefined);
  assert.equal((await c.engine.status()).enabled, false);
  assert.equal((await c.engine.status()).applying, false);
  assert.ok(
    (await c.bookmarks.getChildren("toolbar_____")).some(
      (n) => n.title === "Original local",
    ),
  );
});
test("default fetch preserves the browser global receiver", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return new Response(JSON.stringify({ version: "1.6.0" }));
  };
  try {
    assert.deepEqual(
      await new Api({ url: "https://example.com", id: "test" }).request(
        "/version",
      ),
      { version: "1.6.0" },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Chromium title whitespace normalization preserves original and detects real edits", async () => {
  const c = await setup(false);
  const source = structuredClone(tree);
  source[0].children[0].title = " Folder\r\n\t\u2028\u2029 ";
  source[0].children[0].children[0].title = "A\nB\tC";
  c.server.bookmarks = await encrypt(source, key);
  const create = c.bookmarks.create.bind(c.bookmarks);
  c.bookmarks.create = (spec) =>
    create({
      ...spec,
      title: spec.title.replace(/[\n\r\t\u2028\u2029]/g, " "),
    });
  await restore(c);
  assert.deepEqual(await c.store.get("base"), source);
  await c.engine.tick();
  assert.equal(c.writes(), 0);
  const mapping = await c.store.get("mapping");
  const nativeId = Object.keys(mapping).find((k) => mapping[k] === 4);
  c.bookmarks.find(nativeId).title = "Changed title";
  await c.engine.tick();
  assert.equal(
    (await decrypt(c.server.bookmarks, key))[0].children[0].children[0].title,
    "Changed title",
  );
  assert.equal(
    c.native.matches(
      { title: "A B C", url: "https://example.com/" },
      { title: "A\nB\tC", url: "https://example.com/" },
    ),
    true,
  );
  assert.equal(
    c.native.matches(
      { title: "Changed", url: "https://example.com/" },
      { title: "A\nB\tC", url: "https://example.com/" },
    ),
    false,
  );
});

test("restore diagnostics are read-only and retain mismatch checks", async () => {
  const c = await setup(false);
  const create = c.bookmarks.create.bind(c.bookmarks);
  c.bookmarks.create = (spec) =>
    create({
      ...spec,
      title: spec.title === "Example" ? "External edit" : spec.title,
    });
  await c.engine.startRestore();
  await c.engine.tick();
  assert.equal((await c.engine.status()).enabled, false);
  assert.match((await c.engine.status()).error, /title 1개/);
  const saved = await c.store.get("state");
  const report = await c.engine.diagnoseRestore();
  assert.match(report, /ID 4: title/);
  assert.equal(report.includes("External edit"), false);
  assert.equal(report.includes("https:"), false);
  assert.deepEqual(await c.store.get("state"), saved);
  assert.equal(c.writes(), 0);
});

test("Chrome about reader rewrite preserves original URL and permits checkpoint recovery", async () => {
  const c = await setup(false);
  const source = structuredClone(tree);
  const original = "about:reader?url=https%3A%2F%2Fexample.org%2Farticle";
  const rewritten = "chrome://reader/?url=https%3A%2F%2Fexample.org%2Farticle";
  source[0].children[0].children[0].url = original;
  c.server.bookmarks = await encrypt(source, key);
  const create = c.bookmarks.create.bind(c.bookmarks);
  c.bookmarks.create = (spec) =>
    create({ ...spec, url: spec.url === original ? rewritten : spec.url });
  await restore(c);
  assert.deepEqual(await c.store.get("base"), source);
  await c.engine.tick();
  assert.equal(c.writes(), 0);
  assert.equal(
    c.native.matches(
      { title: "X", url: rewritten },
      { title: "X", url: original },
    ),
    true,
  );
  assert.equal(
    c.native.matches(
      { title: "X", url: rewritten + "changed" },
      { title: "X", url: original },
    ),
    false,
  );
  assert.equal(
    new Native(c.bookmarks, true).matches(
      { title: "X", url: rewritten },
      { title: "X", url: original },
    ),
    false,
  );
  assert.equal(
    c.native.matches(
      { title: "X", url: "chrome://blank/" },
      { title: "X", url: "about:blank" },
    ),
    false,
  );
  assert.equal(
    c.native.matches(
      { title: "X", url: "chrome://srcdoc/" },
      { title: "X", url: "about:srcdoc" },
    ),
    false,
  );
});

test("large sibling cleanup deletes from tail and reports clearing progress", async () => {
  const c = await setup(true);
  for (let i = 0; i < 30; i++)
    await c.bookmarks.create({
      parentId: "toolbar_____",
      title: `old ${i}`,
      url: `https://example.com/${i}`,
    });
  const originalIds = c.bookmarks
    .find("toolbar_____")
    .children.map((n) => n.id);
  await c.engine.startRestore();
  const status = await c.engine.status();
  assert.equal(status.phase, "기존 북마크 정리 중");
  assert.deepEqual(status.progress, { done: 0, total: 30 });
  const remove = c.bookmarks.removeTree.bind(c.bookmarks);
  const removed = [];
  c.bookmarks.removeTree = async (id) => {
    removed.push(id);
    await remove(id);
  };
  await c.engine.tick();
  assert.deepEqual(removed, originalIds.reverse());
  assert.equal((await c.engine.status()).error, undefined);
});

test("old interrupted clearing plan upgrades only remaining IDs and retains backup", async () => {
  const c = await setup(true);
  for (let i = 0; i < 8; i++)
    await c.bookmarks.create({
      parentId: "toolbar_____",
      title: `old ${i}`,
      url: `https://example.com/${i}`,
    });
  const ids = c.bookmarks.find("toolbar_____").children.map((n) => n.id);
  await c.engine.startRestore();
  const backup = await c.store.get("backup");
  const plan = await c.store.get("plan");
  plan.clear = [...ids];
  delete plan.clearFromEnd;
  const state = await c.store.get("state");
  state.apply.clearCursor = 2;
  await c.bookmarks.removeTree(ids[0]);
  await c.bookmarks.removeTree(ids[1]);
  // A delete may have completed just before the worker was stopped.
  await c.bookmarks.removeTree(ids[2]);
  await c.store.put({ plan, state });
  const removed = [],
    remove = c.bookmarks.removeTree.bind(c.bookmarks);
  c.bookmarks.removeTree = async (id) => {
    removed.push(id);
    await remove(id);
  };
  await c.engine.tick();
  assert.deepEqual(removed, ids.slice(3).reverse());
  assert.deepEqual(await c.store.get("backup"), backup);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal((await c.engine.status()).error, undefined);
});

test("interrupted deletion batch waits for siblings and replays missing IDs safely", async () => {
  const c = await setup(true);
  for (let i = 0; i < 16; i++)
    await c.bookmarks.create({
      parentId: "toolbar_____",
      title: `old ${i}`,
      url: `https://example.com/${i}`,
    });
  await c.engine.startRestore();
  const original = c.bookmarks.removeTree.bind(c.bookmarks);
  let fail = true;
  c.bookmarks.removeTree = async (id) => {
    await original(id);
    if (fail) {
      fail = false;
      throw Error("terminated after delete");
    }
  };
  await c.engine.tick();
  assert.equal((await c.store.get("state")).apply.clearCursor, 0);
  assert.equal(c.bookmarks.find("toolbar_____").children.length, 8);
  assert.equal((await c.engine.status()).enabled, false);
  await c.engine.pause(true);
  await c.engine.tick();
  assert.equal((await c.engine.status()).error, undefined);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal((await c.store.get("backup")).bookmarks[0].children.length, 16);
});

async function interruptedOrderRestore(firefox = true) {
  const c = await setup(firefox);
  const target = structuredClone(tree);
  target[0].children = Array.from({ length: 88 }, (_, i) => ({
    id: 1000 + i * 2,
    title: `Folder ${i}`,
    children: [
      {
        id: 1001 + i * 2,
        title: `Entry ${i}`,
        url: `https://example.org/${i}`,
      },
    ],
  }));
  c.server.bookmarks = await encrypt(target, key);
  await c.engine.startRestore();
  const snapshot = c.native.snapshot.bind(c.native);
  c.native.snapshot = async () => {
    throw Error("simulated old final verification failure");
  };
  await c.engine.tick();
  c.native.snapshot = snapshot;
  assert.equal((await c.engine.status()).enabled, false);
  c.bookmarks.tree.children[0].children.reverse();
  return { ...c, target };
}
async function finishOrderRestore(c) {
  await c.engine.pause(true);
  for (let i = 0; i < 8 && (await c.engine.status()).applying; i++) {
    await c.engine.tick();
    if ((await c.engine.status()).error) break;
  }
}
for (const firefox of [true, false])
  test(`${firefox ? "Firefox" : "Chrome"} resumes 88 order differences without recreating or uploading`, async () => {
    const c = await interruptedOrderRestore(firefox);
    assert.match(await c.engine.diagnoseRestore(), /순서 88개/);
    const backup = await c.store.get("backup");
    const next = c.bookmarks.next;
    await finishOrderRestore(c);
    assert.equal((await c.engine.status()).error, undefined);
    assert.equal((await c.engine.status()).applying, false);
    assert.equal(await hash(await c.store.get("base")), await hash(c.target));
    assert.equal(c.bookmarks.next, next);
    assert.equal(c.writes(), 0);
    assert.deepEqual(await c.store.get("backup"), backup);
  });

test("order repair resumes after native move succeeds but its response is lost", async () => {
  const c = await interruptedOrderRestore();
  const move = c.bookmarks.move.bind(c.bookmarks);
  let crash = true;
  c.bookmarks.move = async (...args) => {
    const result = await move(...args);
    if (crash) {
      crash = false;
      throw Error("lost move response");
    }
    return result;
  };
  await finishOrderRestore(c);
  assert.match((await c.engine.status()).error, /lost move response/);
  c.engine = new Engine(c.store, c.native, () => c.api);
  await finishOrderRestore(c);
  assert.equal((await c.engine.status()).error, undefined);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal(c.writes(), 0);
});

test("order differences mixed with edited content are never repaired automatically", async () => {
  const c = await interruptedOrderRestore();
  c.bookmarks.tree.children[0].children[0].title = "user edit";
  c.bookmarks.move = async () => assert.fail("must preserve edits");
  await finishOrderRestore(c);
  assert.match((await c.engine.status()).error, /title/);
  assert.equal((await c.engine.status()).enabled, false);
  assert.equal(c.writes(), 0);
});

test("order repair refuses membership changes after comparison", async () => {
  const c = await interruptedOrderRestore();
  const getChildren = c.bookmarks.getChildren.bind(c.bookmarks);
  c.bookmarks.getChildren = async (id) => [
    ...(await getChildren(id)),
    { id: "foreign", title: "external" },
  ];
  c.bookmarks.move = async () =>
    assert.fail("must not move unexpected folder members");
  await finishOrderRestore(c);
  assert.match((await c.engine.status()).error, /폴더 내용이 변경/);
  assert.equal(c.writes(), 0);
});

test("continual order interference stops after two passes without relaxing final hash", async () => {
  const c = await interruptedOrderRestore();
  const snapshot = c.native.snapshot.bind(c.native);
  c.native.snapshot = async (...args) => {
    c.bookmarks.tree.children[0].children.reverse();
    return snapshot(...args);
  };
  // Initial reverse above would undo the fixture reversal; start from correct order.
  c.bookmarks.tree.children[0].children.reverse();
  await finishOrderRestore(c);
  assert.match((await c.engine.status()).error, /다시 변경/);
  assert.equal((await c.engine.status()).enabled, false);
  assert.equal((await c.store.get("state")).apply.orderPasses, 2);
  assert.equal(c.writes(), 0);
});

test("order repair yields within a folder and resumes from durable records", async () => {
  const c = await interruptedOrderRestore();
  const apply = c.engine.continueApply.bind(c.engine);
  c.engine.continueApply = (state) => apply(state, 0);
  await c.engine.pause(true);
  await c.engine.tick();
  const status = await c.engine.status();
  assert.equal(status.error, undefined);
  assert.equal(status.phase, "복원 순서 조정 중");
  assert.equal((await c.store.get("state")).apply.orderMoves, 1);
  c.engine = new Engine(c.store, c.native, () => c.api);
  await finishOrderRestore(c);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal(await hash(await c.store.get("base")), await hash(c.target));
});

test("Chrome Other order repair includes its synthetic Menu wrapper", async () => {
  const c = await interruptedOrderRestore(false);
  c.bookmarks.tree.children[1].children.reverse();
  await finishOrderRestore(c);
  assert.equal((await c.engine.status()).error, undefined);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal(await hash(await c.store.get("base")), await hash(c.target));
});

async function previewAgain(c) {
  const s = await c.engine.state();
  s.preview = true;
  s.enabled = false;
  s.initialUpload = false;
  await c.store.put({ state: s, base: undefined, mapping: undefined });
}
async function finishInitial(c) {
  for (let i = 0; i < 10; i++) {
    await c.engine.tick();
    const s = await c.engine.status();
    assert.equal(s.error, undefined);
    if (!s.applying) return;
  }
  assert.fail("initial download did not finish");
}
for (const firefox of [true, false]) {
  test(`${firefox ? "Firefox" : "Chrome"} identical initial download preserves every native ID with zero mutations`, async () => {
    const c = await setup(firefox);
    await restore(c);
    const before = await c.bookmarks.getTree();
    await previewAgain(c);
    for (const op of ["create", "update", "move", "removeTree"])
      c.bookmarks[op] = async () =>
        assert.fail(`identical download called ${op}`);
    await c.engine.startRestore();
    await finishInitial(c);
    assert.deepEqual(await c.bookmarks.getTree(), before);
    assert.deepEqual(await c.store.get("base"), tree);
    assert.equal(c.writes(), 0);
    await c.engine.tick();
    assert.equal(c.writes(), 0);
  });
  test(`${firefox ? "Firefox" : "Chrome"} initial download updates only differences and preserves matching nodes`, async () => {
    const c = await setup(firefox);
    await restore(c);
    const mapping = await c.store.get("mapping");
    const original = Object.fromEntries(
      Object.entries(mapping).map(([native, id]) => [id, native]),
    );
    c.bookmarks.find(original[4]).title = "local changed title";
    await c.bookmarks.create({
      parentId: original[3],
      title: "local extra",
      url: "https://local.example/",
    });
    const target = structuredClone(tree);
    target[0].children.reverse();
    target[0].children.push({
      id: 9,
      title: "server new",
      url: "https://server.example/",
    });
    c.server.bookmarks = await encrypt(target, key);
    await previewAgain(c);
    let removed = 0,
      created = 0,
      updated = 0;
    for (const op of ["create", "update", "removeTree"]) {
      const call = c.bookmarks[op].bind(c.bookmarks);
      c.bookmarks[op] = async (...args) => {
        if (op === "create") created++;
        if (op === "update") updated++;
        if (op === "removeTree") removed++;
        return call(...args);
      };
    }
    await c.engine.startRestore();
    await finishInitial(c);
    assert.equal(created, 1);
    assert.equal(updated, 1);
    assert.equal(removed, 1);
    assert.equal(
      c.bookmarks.find(original[4]).title,
      tree[0].children[0].children[0].title,
    );
    assert.ok(c.bookmarks.find(original[3]));
    assert.deepEqual(await c.store.get("base"), target);
    assert.equal(c.writes(), 0);
  });
}

test("initial download with retained siblings resumes a lost append response without duplicates", async () => {
  const c = await setup();
  await restore(c);
  const target = structuredClone(tree);
  target[0].children.unshift({
    id: 20,
    title: "new first",
    url: "https://first.example/",
  });
  c.server.bookmarks = await encrypt(target, key);
  await previewAgain(c);
  await c.engine.startRestore();
  const next = c.bookmarks.next;
  c.bookmarks.crash = true;
  await c.engine.tick();
  assert.match((await c.engine.status()).error, /simulated crash/);
  c.engine = new Engine(c.store, c.native, () => c.api);
  await c.engine.pause(true);
  await finishInitial(c);
  assert.equal(c.bookmarks.next, next + 1);
  assert.deepEqual(await c.store.get("base"), target);
});

test("duplicate URLs are matched one-to-one without deleting identical bookmarks", async () => {
  const c = await setup();
  const target = structuredClone(tree);
  target[0].children = [
    { id: 20, title: "one", url: "https://same.example/" },
    { id: 21, title: "two", url: "https://same.example/" },
    { id: 22, title: "two", url: "https://same.example/" },
  ];
  c.server.bookmarks = await encrypt(target, key);
  await restore(c);
  const next = c.bookmarks.next;
  await previewAgain(c);
  await c.engine.startRestore();
  await finishInitial(c);
  assert.equal(c.bookmarks.next, next);
  assert.deepEqual(await c.store.get("base"), target);
});

for (const raw of [false, true])
  test(`empty ${raw ? "uninitialized" : "encrypted"} server uploads local data without deletion and recovers lost response`, async () => {
    const c = await setup();
    await restore(c);
    const before = await c.bookmarks.getTree();
    c.server.bookmarks = raw ? "" : await encrypt(validateTree([]), key);
    await previewAgain(c);
    const state = await c.engine.state();
    state.initialUpload = true;
    await c.store.put({ state });
    for (const op of ["create", "update", "move", "removeTree"])
      c.bookmarks[op] = async () =>
        assert.fail(`empty server mutated local with ${op}`);
    await c.engine.startRestore();
    c.api.loseResponse = true;
    await c.engine.tick();
    assert.equal(c.writes(), 1);
    await c.engine.tick();
    assert.equal((await c.engine.status()).error, undefined);
    assert.equal((await c.engine.state()).pending, false);
    assert.equal(c.writes(), 1);
    assert.deepEqual(await c.bookmarks.getTree(), before);
    assert.equal(
      await hash(await decrypt(c.server.bookmarks, key)),
      await hash(await c.store.get("base")),
    );
  });

test("initial sync asks to review when server emptiness changes after preview", async () => {
  const c = await setup();
  c.server.bookmarks = await encrypt(validateTree([]), key);
  await assert.rejects(c.engine.startRestore(), /방향을 다시 확인/);
  assert.equal((await c.engine.status()).initialUpload, true);
  assert.equal((await c.engine.status()).applying, false);
  assert.equal(c.writes(), 0);
});

test("API accepts empty new IDs but does not treat malformed data as an empty account", async () => {
  const api = new Api({ id: "test", url: "https://example.org" });
  for (const bookmarks of [null, undefined, ""]) {
    api.request = async () => ({
      bookmarks,
      lastUpdated: "2026-09-16T00:00:00Z",
    });
    assert.equal((await api.read()).bookmarks, "");
  }
  api.request = async () => ({
    bookmarks: 123,
    lastUpdated: "2026-09-16T00:00:00Z",
  });
  await assert.rejects(api.read(), /형식/);
  api.request = async () => ({ bookmarks: "" });
  await assert.rejects(api.read(), /형식/);
});

test("connecting a new empty ID previews upload without mutating local or server", async () => {
  const c = await setup();
  await restore(c);
  const before = await c.bookmarks.getTree();
  c.server.bookmarks = "";
  await c.engine.connect({
    url: "https://example.org",
    id: "0123456789abcdef0123456789abcdef",
    password: "test-password-only",
  });
  assert.equal((await c.engine.status()).initialUpload, true);
  assert.equal((await c.engine.status()).preview, true);
  assert.equal(c.writes(), 0);
  assert.deepEqual(await c.bookmarks.getTree(), before);
});

test("Chrome identical initial download does not create an unnecessary empty Menu wrapper", async () => {
  const c = await setup(false);
  const target = validateTree([
    {
      id: 0,
      title: ROOTS[0],
      children: [{ id: 4, title: "same", url: "https://same.example/" }],
    },
  ]);
  c.server.bookmarks = await encrypt(target, key);
  await c.bookmarks.create({
    parentId: "1",
    title: "same",
    url: "https://same.example/",
  });
  for (const op of ["create", "update", "move", "removeTree"])
    c.bookmarks[op] = async () =>
      assert.fail(`identical Chrome data called ${op}`);
  await c.engine.startRestore();
  await finishInitial(c);
  assert.deepEqual(await c.store.get("base"), target);
});

async function settle(c) {
  for (let i = 0; i < 20; i++) {
    await c.engine.tick();
    const status = await c.engine.status();
    assert.equal(status.error, undefined);
    if (!status.applying && !status.pending) return;
  }
  assert.fail("sync did not settle");
}
function syncNative(c, id) {
  return c.store
    .get("mapping")
    .then((mapping) =>
      c.bookmarks.find(Object.keys(mapping).find((key) => mapping[key] === id)),
    );
}
for (const firefox of [true, false]) {
  test(`${firefox ? "Firefox" : "Chrome"} download mode persists and never uploads local edits`, async () => {
    const c = await setup(firefox);
    await restore(c);
    await c.engine.setMode("download");
    (await syncNative(c, 4)).title = "local edit to discard";
    const remote = structuredClone(tree);
    remote[0].children[0].children[0].title = "server edit";
    c.server.bookmarks = await encrypt(remote, key);
    c.server.lastUpdated = "2026-02-01T00:00:00Z";
    c.engine = new Engine(c.store, c.native, () => c.api);
    await settle(c);
    assert.equal((await c.engine.status()).mode, "download");
    assert.equal((await syncNative(c, 4)).title, "server edit");
    assert.equal(c.writes(), 0);
    assert.equal((await c.engine.status()).conflict, false);
  });
  test(`${firefox ? "Firefox" : "Chrome"} upload mode preserves local tree and backs up remote-only edits`, async () => {
    const c = await setup(firefox);
    await restore(c);
    (await syncNative(c, 4)).title = "local authoritative";
    const before = await c.bookmarks.getTree();
    const remote = structuredClone(tree);
    remote[0].children[0].children[0].title = "remote to back up";
    c.server.bookmarks = await encrypt(remote, key);
    c.server.lastUpdated = "2026-02-01T00:00:00Z";
    await c.engine.setMode("upload");
    c.api.loseResponse = true;
    await c.engine.tick(); // Persist upload intent.
    await c.engine.tick(); // Server applies it but response is lost.
    assert.match((await c.engine.status()).error, /response lost/);
    await settle(c);
    assert.equal(c.writes(), 1);
    assert.deepEqual(await c.bookmarks.getTree(), before);
    assert.equal(
      (await decrypt(c.server.bookmarks, key))[0].children[0].children[0].title,
      "local authoritative",
    );
    assert.deepEqual((await c.engine.export("serverBackup")).bookmarks, remote);
  });
  test(`${firefox ? "Firefox" : "Chrome"} initial two-way merges both sides before uploading`, async () => {
    const c = await setup(firefox);
    const root = firefox ? "toolbar_____" : "1";
    await c.bookmarks.create({
      parentId: root,
      title: "local only",
      url: "https://local-only.example/",
    });
    await c.engine.setMode("both");
    await c.engine.startRestore();
    await settle(c);
    const server = await decrypt(c.server.bookmarks, key);
    assert.ok(
      server[0].children.some(
        (node) => node.url === "https://local-only.example/",
      ),
    );
    assert.ok(server[0].children.some((node) => node.id === 3));
    assert.equal(
      await hash(
        (
          await c.native.snapshot(
            await c.store.get("base"),
            await c.store.get("mapping"),
          )
        ).tree,
      ),
      await hash(server),
    );
    assert.equal(c.writes(), 1);
    assert.deepEqual(await c.store.get("serverBackup"), tree);
  });
}

test("initial upload mode replaces populated server but never restores its bookmarks locally", async () => {
  const c = await setup();
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "local source",
    url: "https://local-source.example/",
  });
  const before = await c.bookmarks.getTree();
  await c.engine.setMode("upload");
  await c.engine.startRestore();
  await settle(c);
  assert.deepEqual(await c.bookmarks.getTree(), before);
  const server = await decrypt(c.server.bookmarks, key);
  assert.equal(server[0].children.length, 1);
  assert.equal(server[0].children[0].title, "local source");
  assert.deepEqual(await c.store.get("serverBackup"), tree);
});

test("direction cannot switch during restore or an uncertain upload", async () => {
  const c = await setup();
  await c.engine.startRestore();
  await assert.rejects(c.engine.setMode("upload"), /진행 중/);
  await settle(c);
  await c.engine.setMode("upload");
  (await syncNative(c, 4)).title = "new";
  await c.engine.tick();
  await assert.rejects(c.engine.setMode("download"), /진행 중/);
  await assert.rejects(c.engine.disconnect(), /저장 확인/);
  await assert.rejects(c.engine.setMode("invalid"), /알 수 없는/);
});

test("two-way mode still stops concurrent edits and server browsing stays read-only", async () => {
  const c = await setup();
  await restore(c);
  await c.engine.setMode("both");
  (await syncNative(c, 4)).title = "local change";
  const remote = structuredClone(tree);
  remote[0].children[0].children[0].title = "remote change";
  c.server.bookmarks = await encrypt(remote, key);
  c.server.lastUpdated = "2026-02-01T00:00:00Z";
  await c.engine.tick();
  assert.equal((await c.engine.status()).conflict, true);
  const before = await c.engine.state();
  const nativeBefore = await c.bookmarks.getTree();
  const recent = await c.engine.listServer({ refresh: true });
  assert.deepEqual(
    recent.items.map((node) => node.id),
    [7, 6, 4],
  );
  assert.equal(
    recent.items.find((node) => node.id === 4).title,
    "remote change",
  );
  const folders = await c.engine.listServer({ view: "folders", parent: 3 });
  assert.equal(folders.items[0].title, "remote change");
  assert.deepEqual(
    folders.path.map((node) => node.id),
    [0, 3],
  );
  assert.deepEqual(await c.engine.state(), before);
  assert.deepEqual(await c.bookmarks.getTree(), nativeBefore);
  assert.equal(c.writes(), 0);
});

test("initial two-way defers upload and detects a concurrent server revision", async () => {
  const c = await setup();
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "local",
    url: "https://local.example/",
  });
  await c.engine.setMode("both");
  await c.engine.startRestore();
  while ((await c.engine.status()).applying) await c.engine.tick();
  c.server.lastUpdated = "2026-02-01T00:00:00Z";
  const remote = structuredClone(tree);
  remote[0].children.push({
    id: 20,
    title: "new remote",
    url: "https://new-remote.example/",
  });
  c.server.bookmarks = await encrypt(remote, key);
  await c.engine.tick();
  assert.equal((await c.engine.status()).conflict, true);
  assert.equal(c.writes(), 0);
});

test("explicit initial download from an empty server backs up and removes local data without uploading", async () => {
  const c = await setup();
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "local",
    url: "https://local.example/",
  });
  c.server.bookmarks = "";
  const s = await c.engine.state();
  s.initialUpload = true;
  await c.store.put({ state: s });
  await c.engine.setMode("download");
  await c.engine.startRestore();
  await settle(c);
  assert.equal(c.bookmarks.find("toolbar_____").children.length, 0);
  assert.equal((await c.store.get("backup")).bookmarks[0].children.length, 1);
  assert.equal(c.writes(), 0);
});

test("initial two-way with an empty server preserves and uploads local bookmarks", async () => {
  const c = await setup();
  await c.bookmarks.create({
    parentId: "toolbar_____",
    title: "local",
    url: "https://local.example/",
  });
  c.server.bookmarks = "";
  const s = await c.engine.state();
  s.initialUpload = true;
  await c.store.put({ state: s });
  const before = await c.bookmarks.getTree();
  await c.engine.setMode("both");
  await c.engine.startRestore();
  await settle(c);
  assert.deepEqual(await c.bookmarks.getTree(), before);
  assert.equal((await decrypt(c.server.bookmarks, key))[0].children.length, 1);
  assert.equal(c.writes(), 1);
});

test("explicit URL diagnostic identifies a changed bookmark without altering the paused restore", async () => {
  const c = await setup(false);
  const create = c.bookmarks.create.bind(c.bookmarks);
  c.bookmarks.create = (spec) =>
    create({
      ...spec,
      ...(spec.title === "Example"
        ? { url: "https://changed.example/?private=value" }
        : {}),
    });
  await c.engine.startRestore();
  await c.engine.tick();
  assert.equal((await c.engine.status()).enabled, false);
  const before = await c.engine.state();
  const nativeBefore = await c.bookmarks.getTree();
  const summary = await c.engine.diagnoseRestore();
  assert.match(summary, /url 1개/);
  assert.equal(summary.includes("private=value"), false);
  const details = await c.engine.diagnoseRestore(true);
  assert.match(details, /"syncId": 4/);
  assert.match(details, /"nativeId": "/);
  assert.match(details, /https:\/\/changed.example\/\?private=value/);
  assert.match(details, /"expectedURL":/);
  assert.deepEqual(await c.engine.state(), before);
  assert.deepEqual(await c.bookmarks.getTree(), nativeBefore);
  assert.equal(c.writes(), 0);
});
