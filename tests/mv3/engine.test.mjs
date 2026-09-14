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
