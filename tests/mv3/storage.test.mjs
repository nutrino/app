import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { Store } from "../../src/mv3/store.mjs";
test("IndexedDB state + journal checkpoint is durable across Store instances", async () => {
  const name = "test-" + crypto.randomUUID();
  const a = new Store(name);
  await a.put({ state: { cursor: 3 }, "created:epoch:8": "native8" });
  const b = new Store(name);
  assert.deepEqual(await b.get("state"), { cursor: 3 });
  assert.deepEqual(await b.entries("created:epoch:"), [
    ["created:epoch:8", "native8"],
  ]);
  await b.deletePrefix("created:epoch:");
  assert.deepEqual(await a.entries("created:"), []);
  assert.deepEqual(await a.get("state"), { cursor: 3 });
});
test("IndexedDB failed transaction does not partially update checkpoint", async () => {
  const store = new Store("test-" + crypto.randomUUID());
  await store.put({ state: { cursor: 0 } });
  await assert.rejects(store.put({ state: { cursor: 1 }, invalid: () => {} }));
  // A synchronous DataCloneError must explicitly abort the transaction.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await store.get("state"), { cursor: 0 });
});

test("bulk journal reading/deletion preserves key pairing and unrelated data", async () => {
  const store = new Store("test-" + crypto.randomUUID());
  const rows = Object.fromEntries(
    Array.from({ length: 1000 }, (_, i) => [
      `created:active:${i}`,
      `native-${i}`,
    ]),
  );
  await store.put({
    ...rows,
    backup: { keep: true },
    "created:other:0": "untouched",
  });
  assert.deepEqual(
    Object.fromEntries(await store.entries("created:active:")),
    rows,
  );
  await store.deletePrefix("created:active:");
  assert.deepEqual(await store.entries("created:active:"), []);
  assert.deepEqual(await store.get("backup"), { keep: true });
  assert.equal(await store.get("created:other:0"), "untouched");
});
