import test from "node:test";
import assert from "node:assert/strict";
import { serverPage, mergeInitial } from "../../src/mv3/server-library.mjs";
import {
  appendServerHistory,
  serverHistoryPage,
} from "../../src/mv3/server-history.mjs";
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

test("server history records additions, edits and deletions without inventing past events", () => {
  const before = tree([
    { id: 4, title: "Delete me", url: "https://old.example/" },
    { id: 5, title: "Edit me", url: "https://before.example/" },
  ]);
  const after = tree([
    { id: 5, title: "Renamed", url: "https://after.example/" },
    { id: 6, title: "Added", url: "https://new.example/" },
  ]);
  const revision = "2026-10-07T00:00:00.000Z";
  assert.deepEqual(
    appendServerHistory([], null, after, revision, "서버에서 확인"),
    [],
  );
  const history = appendServerHistory(
    [],
    before,
    after,
    revision,
    "서버에서 확인",
  );
  assert.deepEqual(history[0].counts, { added: 1, changed: 1, deleted: 1 });
  assert.deepEqual(
    history[0].items.map((item) => [item.kind, item.id]),
    [
      ["deleted", 4],
      ["changed", 5],
      ["added", 6],
    ],
  );
  assert.deepEqual(history[0].items[1].fields, ["제목", "주소"]);
  assert.deepEqual(history[0].items[1].details, [
    "제목: Edit me → Renamed",
    "주소: https://before.example/ → https://after.example/",
  ]);
  assert.match(history[0].items[0].path, /북마크 도구 모음 » Delete me/);
  assert.equal(
    appendServerHistory(history, before, after, revision, "서버에서 확인"),
    history,
  );
  assert.equal(serverHistoryPage(history).total, 3);
  assert.deepEqual(
    serverHistoryPage(history, { query: "after.example" }).items.map(
      (item) => item.id,
    ),
    [5],
  );
  assert.deepEqual(
    serverHistoryPage(history, { query: "before.example" }).items.map(
      (item) => item.id,
    ),
    [5],
  );
  assert.equal(serverHistoryPage(history, { offset: 2 }).items[0].id, 6);
  assert.deepEqual(
    before[0].children.map((node) => node.id),
    [4, 5],
  );
});

test("large server revisions retain accurate counts and a bounded deletion-first sample", () => {
  const before = tree([
    { id: 4, title: "Removed", url: "https://old.example/" },
  ]);
  const after = tree(
    Array.from({ length: 150 }, (_, i) => ({
      id: i + 10,
      title: `Added ${i}`,
      url: `https://new.example/${i}`,
    })),
  );
  const history = appendServerHistory(
    [],
    before,
    after,
    "2026-10-07T00:00:00.000Z",
    "서버에서 확인",
  );
  assert.deepEqual(history[0].counts, { added: 150, changed: 0, deleted: 1 });
  assert.equal(history[0].items.length, 100);
  assert.equal(history[0].items[0].title, "Removed");
  assert.equal(serverHistoryPage(history, { offset: 90 }).items.length, 10);
});
