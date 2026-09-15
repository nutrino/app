const fs = require("node:fs");
const path = require("node:path");
const { zipSync } = require("fflate");
const platform = process.argv[2];
if (!["firefox", "chromium"].includes(platform))
  throw Error("Invalid platform");
const input = path.resolve("build/mv3", platform);
const files = {};
for (const name of fs.readdirSync(input))
  if (!name.endsWith(".map") && fs.statSync(path.join(input, name)).isFile())
    files[name] = fs.readFileSync(path.join(input, name));
fs.mkdirSync("dist", { recursive: true });
const output = path.resolve(`dist/xbrowsersync-mv3-${platform}-1.8.1.zip`);
fs.writeFileSync(output, zipSync(files));
console.log(output);
