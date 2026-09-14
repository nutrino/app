// Local-only disposable integration fixture. Never points at a user's sync server.
import http from "node:http";
import { deriveKey, encrypt, decrypt, ROOTS } from "../src/mv3/protocol.mjs";
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
