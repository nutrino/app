import test from "node:test";
import assert from "node:assert/strict";
import {
  FolderPicker,
  collapsedFolderSegments,
  folderMatchTree,
  highlightedParts,
  localFolders,
  searchFolders,
  bookmarkBlock,
} from "../../src/mv3/folder-picker.mjs";

test("folder index searches full paths, keeps duplicate names and excludes unmodifiable branches", () => {
  const source = [
    {
      id: "0",
      children: [
        {
          id: "1",
          title: "Toolbar",
          children: [
            {
              id: "2",
              title: "Project 10",
              children: [{ id: "3", title: "Docs", children: [] }],
            },
            {
              id: "4",
              title: "Project 2",
              children: [{ id: "5", title: "Docs", children: [] }],
            },
            { id: "6", title: "Page", url: "https://example.org/" },
            {
              id: "7",
              title: "Managed",
              unmodifiable: "managed",
              children: [{ id: "8", title: "Private", children: [] }],
            },
          ],
        },
      ],
    },
  ];
  const folders = localFolders(source);
  assert.deepEqual(
    folders.map((n) => n.id),
    ["1", "4", "5", "2", "3"],
  );
  assert.deepEqual(
    searchFolders(folders, "ＤＯＣＳ").map((n) => n.id),
    ["5", "3"],
  );
  assert.deepEqual(
    searchFolders(folders, "project 10 docs").map((n) => n.id),
    ["3"],
  );
  assert.equal(searchFolders(folders, "nonexistent").length, 0);
  assert.equal(searchFolders(folders, " ").length, 0);
  assert.equal(folders.find((folder) => folder.id === "3").parentId, "2");
});
test("collapsed paths start at the collapsed folder and keep descendant names", () => {
  const parent = [
    "기타 북마크",
    "생성(generative) AI",
    "생성 AI 활용",
    "자연언어처리 on Deep Learning",
    "NN for 자연언어처리",
    "Attention Mechanism / Transformer",
    "Transformer 기반 NLP 모형",
  ];
  const branch = { segments: parent };
  const child = { segments: [...parent, "Text Embedding on Transformer"] };
  assert.deepEqual(collapsedFolderSegments(branch, child), [
    "Transformer 기반 NLP 모형",
    "Text Embedding on Transformer",
  ]);
});
test("local Other root is displayed as 기타 북마크 without renaming nested folders", () => {
  const folders = localFolders([
    {
      id: "0",
      children: [
        {
          id: "2",
          title: "다른 즐겨찾기",
          folderType: "other",
          children: [{ id: "3", title: "다른 즐겨찾기", children: [] }],
        },
      ],
    },
  ]);
  assert.deepEqual(
    folders.map((folder) => folder.path),
    ["기타 북마크", "기타 북마크 » 다른 즐겨찾기"],
  );
});
test("list ranks folder-name matches ahead of ancestor-only matches and tree preserves parents", () => {
  const folders = [
    {
      id: "root",
      parentId: null,
      title: "Root",
      path: "Root",
      segments: ["Root"],
    },
    {
      id: "ancestor",
      parentId: "root",
      title: "Work",
      path: "Root » Work",
      segments: ["Root", "Work"],
    },
    {
      id: "child",
      parentId: "ancestor",
      title: "Notes",
      path: "Root » Work » Notes",
      segments: ["Root", "Work", "Notes"],
    },
    {
      id: "direct",
      parentId: "root",
      title: "Work",
      path: "Root » Work",
      segments: ["Root", "Work"],
    },
  ];
  assert.deepEqual(
    searchFolders(folders, "work").map((f) => f.id),
    ["ancestor", "direct", "child"],
  );
  const tree = folderMatchTree(folders, [folders[2]]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].match, false);
  assert.equal(tree[0].children[0].folder.id, "ancestor");
  assert.equal(tree[0].children[0].match, false);
  assert.equal(tree[0].children[0].children[0].folder.id, "child");
  assert.equal(tree[0].children[0].children[0].match, true);
});
test("quick add blocks restore and active server-authoritative sync but permits paused/local workflows", () => {
  assert.match(bookmarkBlock({ applying: true }), /복원 중/);
  assert.match(
    bookmarkBlock({ enabled: true, mode: "download" }),
    /서버 → 로컬/,
  );
  for (const state of [
    {},
    { enabled: false, mode: "download" },
    { enabled: true, mode: "both" },
    { enabled: true, mode: "upload" },
  ])
    assert.equal(bookmarkBlock(state), "");
});

test("highlight retains original Unicode text and combines overlapping literal matches", () => {
  const text = "개발 ＤＯＣＳ banana <b>";
  const parts = highlightedParts(text, "개발 docs ana <b>");
  assert.equal(parts.map((part) => part.text).join(""), text);
  assert.deepEqual(
    parts.filter((part) => part.match).map((part) => part.text),
    ["개발", "ＤＯＣＳ", "anana", "<b>"],
  );
  assert.equal(
    highlightedParts(text, "   ").some((part) => part.match),
    false,
  );
});

test("folder loading continues when active page access fails or the settings tab is active", async () => {
  for (const query of [
    async () => {
      throw Error("tab denied");
    },
    async () => [{ url: "chrome-extension://test/app.html" }],
  ]) {
    const elements = new Map();
    const get = (id) => {
      if (!elements.has(id)) elements.set(id, { value: "", focus() {} });
      return elements.get(id);
    };
    const picker = new FolderPicker({ tabs: { query } }, () => {}, get);
    let loaded = false;
    picker.loadRecent = async () => {
      loaded = true;
    };
    await picker.load();
    assert.equal(loaded, true);
    assert.equal(picker.page, undefined);
    assert.ok(get("folder-feedback").textContent);
  }
});

test("lazy search shares an in-flight read and does not show results for cleared input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: "" });
    return elements.get(id);
  };
  let resolve;
  let calls = 0;
  const picker = new FolderPicker(
    {},
    () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    get,
  );
  let matches = [];
  picker.render = () => {
    matches = searchFolders(picker.folders, picker.query);
  };
  get("folder-query").oninput();
  t.mock.timers.tick(500);
  assert.equal(calls, 0);
  get("folder-query").value = "work";
  get("folder-query").oninput();
  t.mock.timers.tick(499);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  get("folder-query").value = "travel";
  get("folder-query").oninput();
  t.mock.timers.tick(500);
  assert.equal(calls, 1);
  get("folder-query").value = "";
  get("folder-query").oninput();
  resolve({ folders: [{ id: "1", path: "Travel" }], recent: [] });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(matches, []);
  assert.equal(picker.loaded, true);
});
