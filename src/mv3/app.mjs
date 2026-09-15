import browser from "webextension-polyfill";
import { hostPermission, MAX_BYTES } from "./protocol.mjs";
const $ = (id) => document.getElementById(id);
let state;
let busy = false;
let errorUntil = 0;
async function rpc(type, data = {}) {
  const result = await browser.runtime.sendMessage({ type, ...data });
  if (!result?.ok)
    throw Error(
      result?.error ||
        "확장 실행부에 연결할 수 없습니다. 확장을 다시 로드하세요.",
    );
  return result.data;
}
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
async function refresh() {
  state = await rpc("status");
  $("login").hidden = state.connected;
  $("account").hidden = !state.connected;
  $("server").textContent = state.url || "";
  $("summary").textContent =
    `${state.count ?? 0}개 항목 · 마지막 서버 저장: ${state.lastUpdated || "없음"}`;
  $("preview").hidden = !state.preview;
  $("conflict").hidden = !state.conflict;
  $("progress").hidden = !state.progress;
  $("rollback").hidden = !state.applying;
  $("diagnose").hidden = !state.applying;
  if (state.progress) {
    $("progress").max = state.progress.total || 1;
    $("progress").value = state.progress.done;
  }
  $("pause").textContent = state.enabled ? "일시 정지" : "동기화 재개";
  $("disconnect").disabled = busy || state.applying;
  $("sync").disabled = busy || state.preview || state.conflict;
  if (Date.now() > errorUntil)
    notice(
      state.error ||
        `${state.phase}${state.progress ? ` (${state.progress.done}/${state.progress.total})` : ""}`,
      !!state.error,
    );
}
async function action(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await fn();
    errorUntil = 0;
    await refresh();
  } catch (error) {
    errorUntil = Date.now() + 15000;
    notice(error.message, true);
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    if (state?.applying) $("disconnect").disabled = true;
  }
}
$("connect").addEventListener("submit", (event) => {
  event.preventDefault();
  // Keep permissions.request in the user gesture, before any awaited RPC.
  let permission;
  try {
    permission = browser.permissions.request({
      origins: [hostPermission($("url").value)],
    });
  } catch (error) {
    notice(error.message, true);
    return;
  }
  action(async () => {
    if (!(await permission)) throw Error("서버 접근 권한이 필요합니다.");
    const password = $("password").value;
    $("password").value = "";
    await rpc("connect", {
      data: { url: $("url").value, id: $("sync-id").value, password },
    });
  });
});
$("diagnose").onclick = () =>
  action(async () => {
    const report = await rpc("diagnose");
    alert(report);
  });
$("rollback").onclick = () =>
  action(async () => {
    if (
      confirm(
        "진행 중인 복원을 중단하고 교체 전 백업으로 되돌린 후 동기화를 일시 정지합니다. 계속하시겠습니까?",
      )
    )
      await rpc("rollback");
  });
$("restore").onclick = () => action(() => rpc("restore"));
$("sync").onclick = () => action(() => rpc("sync"));
$("pause").onclick = () =>
  action(() => rpc("pause", { enabled: !state.enabled }));
$("disconnect").onclick = () => action(() => rpc("disconnect"));
$("choose-server").onclick = () =>
  action(() => rpc("resolve", { choice: "server" }));
$("choose-local").onclick = () =>
  action(() => rpc("resolve", { choice: "local" }));
$("full").onclick = () =>
  browser.tabs.create({ url: browser.runtime.getURL("app.html") });
for (const button of document.querySelectorAll("[data-export]"))
  button.onclick = () =>
    action(async () => {
      const data = await rpc("export", { kind: button.dataset.export });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `xbrowsersync-${button.dataset.export}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
$("import").onchange = () =>
  action(async () => {
    const file = $("import").files[0];
    if (!file) return;
    if (file.size > MAX_BYTES) throw Error("백업 파일이 너무 큽니다.");
    const data = JSON.parse(await file.text());
    if (
      !confirm(
        "현재 북마크를 자동 백업한 후 선택한 파일로 교체하고 동기화를 일시 정지합니다. 계속하시겠습니까?",
      )
    )
      return;
    await rpc("import", { data });
    $("import").value = "";
  });
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $("search").value.trim();
    $("results").replaceChildren();
    if (!query) return;
    const matches = await browser.bookmarks.search(query);
    for (const bookmark of matches.slice(0, 100)) {
      const item = document.createElement("li");
      if (/^https?:\/\//i.test(bookmark.url || "")) {
        const link = document.createElement("a");
        link.textContent = bookmark.title || bookmark.url;
        link.href = bookmark.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      } else item.textContent = bookmark.title || bookmark.url || "(폴더)";
      $("results").append(item);
    }
  }, 200);
};
refresh().catch((error) => notice(error.message, true));
setInterval(() => {
  if (!busy) refresh().catch((error) => notice(error.message, true));
}, 1500);
