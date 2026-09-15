const fs = require("node:fs");
const cp = require("node:child_process");
for (const folder of ["src/mv3", "tests/mv3"])
  for (const name of fs.readdirSync(folder))
    if (name.endsWith(".mjs"))
      cp.execFileSync(process.execPath, ["--check", `${folder}/${name}`]);
for (const name of ["build-mv3.js", "package-mv3.js", "mv3-test-server.mjs"])
  cp.execFileSync(process.execPath, ["--check", `scripts/${name}`]);
const files = fs
  .readdirSync("src/mv3")
  .filter((n) => n.endsWith(".mjs"))
  .map((n) => fs.readFileSync(`src/mv3/${n}`, "utf8"))
  .join("\n");
if (
  /\beval\s*\(|new Function\b|\.innerHTML\s*=|angular|sendBeacon|XMLHttpRequest/.test(
    files,
  )
)
  throw Error("Unexpected unsafe/legacy runtime API");
console.log("MV3 syntax and runtime policy checks passed.");
