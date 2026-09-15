import browser from "webextension-polyfill";
import { Store } from "./store.mjs";
import { Native } from "./native.mjs";
import { Engine } from "./engine.mjs";
import { BUILD_INFO } from "./build-info.mjs";
const engine = new Engine(
  new Store(),
  new Native(
    browser.bookmarks,
    typeof browser.runtime.getBrowserInfo === "function",
  ),
);
let timer;
let running;
function run() {
  // Alarms and bookmark events may arrive during a long restore chunk.
  // Share the active run instead of queuing more chunks ahead of pause/rollback.
  if (!running)
    running = runOnce().finally(() => {
      running = undefined;
    });
  return running;
}
async function runOnce() {
  await engine.tick();
  const status = await engine.status();
  await browser.action.setBadgeText({
    text: status.error
      ? "!"
      : status.applying
        ? "…"
        : status.enabled
          ? ""
          : "Ⅱ",
  });
  if (
    status.enabled &&
    !status.error &&
    (status.applying || status.phase === "서버 저장 확인 중")
  )
    schedule(50);
}
function schedule(delay = 1000) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    run().catch(() => {});
  }, delay);
}
// Register listeners before opening IndexedDB or awaiting any initialization.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "xbs-mv3-sync") return run();
});
for (const event of [
  "onCreated",
  "onChanged",
  "onMoved",
  "onRemoved",
  "onChildrenReordered",
  "onImportEnded",
]) {
  browser.bookmarks[event]?.addListener(() => schedule(1500));
}
browser.runtime.onMessage.addListener((message, sender) => {
  if (
    sender.id !== browser.runtime.id ||
    !sender.url?.startsWith(browser.runtime.getURL(""))
  )
    return undefined;
  const dispatch = async () => {
    switch (message?.type) {
      case "diagnose":
        return engine.diagnoseRestore();
      case "status":
        return { ...(await engine.status()), build: BUILD_INFO };
      case "mode":
        return engine.setMode(message.mode);
      case "server-list":
        return engine.listServer(message.options);
      case "connect":
        return engine.connect(message.data);
      case "restore":
        return engine.startRestore();
      case "sync":
        schedule(0);
        return engine.status();
      case "pause":
        return engine.pause(message.enabled);
      case "disconnect":
        return engine.disconnect();
      case "resolve":
        return engine.resolve(message.choice);
      case "export":
        return engine.export(message.kind);
      case "rollback":
        return engine.rollback();
      case "import":
        return engine.restoreBackup(message.data);
      default:
        throw Error("알 수 없는 요청입니다.");
    }
  };
  return dispatch().then(
    (data) => {
      if (
        !["status", "export", "diagnose", "server-list"].includes(message.type)
      )
        schedule(50);
      return { ok: true, data };
    },
    (error) => ({ ok: false, error: error.message }),
  );
});
browser.runtime.onStartup.addListener(() => schedule(0));
browser.runtime.onInstalled.addListener((details) => {
  schedule(0);
  if (details.reason === "install")
    browser.tabs
      .create({ url: browser.runtime.getURL("app.html") })
      .catch(() => {});
});
browser.alarms.create("xbs-mv3-sync", { periodInMinutes: 1 });
schedule(0);
