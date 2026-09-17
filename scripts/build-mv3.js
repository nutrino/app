const fs = require("node:fs/promises");
const path = require("node:path");
const webpack = require("webpack");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
async function buildInfo(platform) {
  let commit = "unknown",
    committedAt = null,
    dirty = null;
  try {
    [commit, committedAt] = execFileSync(
      "git",
      ["log", "-1", "--format=%H%n%cI"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    dirty = !!execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    /* Source archives can be built without Git metadata. */
  }
  const hash = createHash("sha256");
  for (const file of [
    ...(await fs.readdir("src/mv3")).sort().map((name) => `src/mv3/${name}`),
    "scripts/build-mv3.js",
    "package.json",
    "package-lock.json",
  ]) {
    hash.update(file);
    hash.update(await fs.readFile(file));
  }
  return {
    commit,
    committedAt,
    dirty,
    sourceHash: hash.digest("hex"),
    builtAt: new Date().toISOString(),
    platform,
  };
}
async function main() {
  const platform = process.argv[2];
  if (!["firefox", "chromium"].includes(platform))
    throw Error("Expected firefox or chromium");
  const development = process.argv.includes("--dev");
  const info = await buildInfo(platform);
  const out = path.resolve(
    process.env.XBS_OUTPUT_ROOT || "build/mv3",
    platform,
  );
  await fs.mkdir(out, { recursive: true });
  await new Promise((resolve, reject) =>
    webpack(
      {
        mode: development ? "development" : "production",
        target: "webworker",
        entry: {
          background: "./src/mv3/background.mjs",
          app: "./src/mv3/app.mjs",
        },
        output: { path: out, filename: "[name].js" },
        devtool: development ? "source-map" : false,
        performance: false,
        plugins: [
          new webpack.DefinePlugin({
            __XBS_BUILD_INFO__: JSON.stringify(info),
          }),
        ],
        optimization: { splitChunks: false },
        resolve: {
          alias: { "readable-stream": false },
          fallback: { buffer: false },
        },
      },
      (error, stats) =>
        error || stats.hasErrors()
          ? reject(error || Error(stats.toString({ all: false, errors: true })))
          : resolve(),
    ),
  );
  const manifest = {
    manifest_version: 3,
    name: "xBrowserSync MV3",
    version: "1.8.1",
    description: "Encrypted bookmark sync for Firefox and Chromium.",
    icons: { 128: "icon128.png" },
    action: { default_popup: "app.html?popup=1", default_icon: "icon128.png" },
    options_ui: { page: "app.html", open_in_tab: true },
    permissions: [
      "bookmarks",
      "storage",
      "alarms",
      "unlimitedStorage",
      "activeTab",
      "cookies",
    ],
    host_permissions: ["https://settings.xbrowsersync.invalid/*"],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    background:
      platform === "firefox"
        ? { scripts: ["background.js"] }
        : { service_worker: "background.js" },
    content_security_policy: {
      extension_pages:
        "default-src 'self'; script-src 'self'; object-src 'none'; connect-src http: https:; img-src 'self'; style-src 'self'; base-uri 'none'",
    },
    incognito: "not_allowed",
  };
  if (platform === "firefox")
    manifest.browser_specific_settings = {
      gecko: {
        id: "mv3@nutrino.xbrowsersync",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["bookmarksInfo"] },
      },
    };
  await fs.writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(out, "build-info.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  for (const file of ["app.html", "app.css"])
    await fs.copyFile(path.resolve("src/mv3", file), path.join(out, file));
  await fs.copyFile(
    "res/webext/images/icon128.png",
    path.join(out, "icon128.png"),
  );
  await fs.copyFile("LICENSE.md", path.join(out, "LICENSE.md"));
  await fs.writeFile(
    path.join(out, "THIRD-PARTY-LICENSES.txt"),
    (await fs.readFile("node_modules/lzutf8/LICENSE", "utf8")) +
      "\n\nwebextension-polyfill\n" +
      (await fs.readFile("node_modules/webextension-polyfill/LICENSE", "utf8")),
  );
  console.log(`Built ${platform}: ${out}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
