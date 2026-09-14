// Local-only disposable integration fixture. Never points at a user's sync server.
import http from "node:http";
import readline from "node:readline";
import {
  deriveKey,
  encrypt,
  decrypt,
  ROOTS,
  countTree,
} from "../src/mv3/protocol.mjs";
const id = "0123456789abcdef0123456789abcdef";
const key = await deriveKey("test-password-only", id);
let tree = [
  {
    id: 0,
    title: ROOTS[0],
    children: [
      {
        id: 3,
        title: "MV3 Firefox Chrome test",
        url: "https://example.com/",
        description: "Metadata retained",
        tags: ["mv3"],
      },
      {
        id: 4,
        title: "Folder",
        children: [
          { id: 5, title: "Nested bookmark", url: "https://example.org/" },
        ],
      },
    ],
  },
  { id: 1, title: ROOTS[1], children: [] },
  { id: 2, title: ROOTS[2], children: [] },
];
const smallTree = structuredClone(tree);
let offline = false;
let bookmarks = await encrypt(tree, key);
let lastUpdated = new Date().toISOString();
let writes = 0;
http
  .createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Accept-Version,Content-Type",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
    if (req.method === "OPTIONS") {
      res.end("{}");
      return;
    }
    const send = (code, data) => {
      res.statusCode = code;
      res.end(JSON.stringify(data));
    };
    if (req.url === "/status") return send(200, { writes, lastUpdated, tree });
    if (offline) return send(503, { error: "test offline" });
    if (req.url === "/info")
      return send(200, { status: 1, version: "1.1.13", maxSyncSize: 64000000 });
    if (req.url === `/bookmarks/${id}/lastUpdated`)
      return send(200, { lastUpdated });
    if (req.url === `/bookmarks/${id}/version`)
      return send(200, { version: "1.6.0" });
    if (req.url !== `/bookmarks/${id}`) return send(404, {});
    if (req.method === "GET") return send(200, { bookmarks, lastUpdated });
    if (req.method === "PUT") {
      try {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        if (payload.lastUpdated !== lastUpdated) return send(409, {});
        tree = await decrypt(payload.bookmarks, key);
        bookmarks = payload.bookmarks;
        lastUpdated = new Date().toISOString();
        writes++;
        return send(200, { lastUpdated });
      } catch {
        return send(400, {});
      }
    }
    send(405, {});
  })
  .listen(18765, "127.0.0.1", () =>
    console.log("Disposable test API: http://127.0.0.1:18765"),
  );

// Controls affect only this disposable localhost fixture, never browser APIs.
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const [command, value] = line.trim().split(/\s+/);
  if (command === "offline") {
    offline = true;
    console.log("Fixture offline");
    return;
  }
  if (command === "online") {
    offline = false;
    console.log("Fixture online");
    return;
  }
  if (command === "small") tree = structuredClone(smallTree);
  else if (command === "large") {
    const total = Number(value || 76010);
    if (!Number.isInteger(total) || total < 3 || total > 100000) {
      console.log("Invalid fixture size");
      return;
    }
    tree = [
      {
        id: 0,
        title: ROOTS[0],
        children: Array.from({ length: total - 3 }, (_, i) => ({
          id: i + 3,
          title: `MV3 large ${i}`,
          url: `https://example.com/mv3/${i}`,
          description: "Large fixture metadata",
          tags: ["mv3-test"],
        })),
      },
      { id: 1, title: ROOTS[1], children: [] },
      { id: 2, title: ROOTS[2], children: [] },
    ];
  } else return;
  bookmarks = await encrypt(tree, key);
  lastUpdated = new Date().toISOString();
  console.log(`Fixture replaced: ${countTree(tree)} items`);
});
