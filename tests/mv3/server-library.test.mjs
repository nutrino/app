import test from "node:test";
import assert from "node:assert/strict";
import { serverPage, mergeInitial } from "../../src/mv3/server-library.mjs";
import { ROOTS, SEPARATOR, validateTree } from "../../src/mv3/protocol.mjs";
const tree = (children) => validateTree([{ id: 0, title: ROOTS[0], children }]);
test("recent server pages preserve data and sort IDs across folders", () => {
  const source = tree([
    {
      id: 1,
      title: "Folder",
      children: Array.from({ length: 205 }, (_, i) => ({
        id: 10 + i,
        title: `Item ${i}`,
        url: `https://example.com/${i}`,
      })),
    },
    { id: 300, url: SEPARATOR },
  ]);
  const original = structuredClone(source);
  const first = serverPage(source);
  const second = serverPage(source, { offset: 30 });
  const last = serverPage(source, { offset: 180 });
  assert.equal(first.total, 205);
  assert.equal(first.items.length, 30);
  assert.equal(first.items[0].id, 214);
  assert.equal(second.items[0].id, 184);
  assert.deepEqual(
    last.items.map((n) => n.id),
    Array.from({ length: 25 }, (_, i) => 34 - i),
  );
  assert.deepEqual(source, original);
});
test("folder pages expose immediate children, breadcrumbs and metadata search", () => {
  const source = tree([
    {
      id: 3,
      title: "Nested",
      children: [
        {
          id: 4,
          title: "A",
          url: "https://example.com",
          tags: ["Korean"],
          description: "Reference",
        },
      ],
    },
    { id: 5, url: SEPARATOR },
  ]);
  const root = serverPage(source, { view: "folders", parent: 0 });
  assert.deepEqual(
    root.items.map((n) => n.id),
    [3, 5],
  );
  assert.equal(root.items[0].children, undefined);
  const nested = serverPage(source, {
    view: "folders",
    parent: 3,
    query: "korean reference",
  });
  assert.deepEqual(
    nested.path.map((n) => n.id),
    [0, 3],
  );
  assert.equal(nested.items.length, 1);
  assert.throws(() => serverPage(source, { view: "folders", parent: 999 }));
});
test("initial merge matches duplicate bookmarks one-to-one and preserves both inputs", () => {
  const bookmark = (id) => ({ id, title: "Same", url: "https://example.com" });
  const server = tree([
    {
      id: 4,
      title: "Folder",
      children: [{ ...bookmark(5), tags: ["server"] }],
    },
  ]);
  const local = tree([
    {
      id: 3,
      title: "Folder",
      children: [
        bookmark(6),
        bookmark(7),
        { id: 8, title: "New", children: [bookmark(9)] },
      ],
    },
  ]);
  const originals = structuredClone([server, local]);
  const merged = mergeInitial(server, local);
  assert.equal(merged[0].children.length, 1);
  const children = merged[0].children[0].children;
  assert.equal(children.length, 3);
  assert.equal(children[0].id, 5);
  assert.deepEqual(children[0].tags, ["server"]);
  assert.equal(children[2].children.length, 1);
  assert.deepEqual([server, local], originals);
  assert.deepEqual(mergeInitial(merged, local), merged);
});
