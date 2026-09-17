import browser from "webextension-polyfill";
import { MAX_BYTES } from "./protocol.mjs";
import { ConnectionForm, needsSetupTab } from "./connection-form.mjs";
import { BUILD_INFO, describeBuild, sameBuild } from "./build-info.mjs";
import { FolderPicker } from "./folder-picker.mjs";
import { formatKST } from "./time.mjs";
const $ = (id) => document.getElementById(id);
const folderPicker = new FolderPicker(browser, rpc, $);
let state;
let busy = false;
let errorUntil = 0;
let ready = false;
let modeDirty = false;
let libraryView = "recent",
  libraryParent = null,
  libraryOffset = 0;
let libraryPage,
  libraryLoading = false,
  libraryRequest = 0,
  libraryAccount;
const modeText = {
  download:
    "서버를 기준으로 로컬의 차이만 반영합니다. 로컬 변경은 서버에 올리지 않으며, 서버에 없는 로컬 항목은 백업 후 삭제합니다.",
  upload:
    "로컬을 기준으로 서버를 갱신합니다. 서버에만 있는 자료는 서버 백업 후 덮어쓰며, 로컬 북마크는 변경하지 않습니다.",
  both: "양쪽 변경을 반영합니다. 최초에는 양쪽 자료를 합치고, 이후 양쪽이 동시에 바뀌면 충돌 확인을 위해 멈춥니다.",
};
$("ui-build").textContent = "화면 · " + describeBuild(BUILD_INFO);
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
  $("runtime-build").textContent = "실행부 · " + describeBuild(state.build);
  $("build-match").textContent = sameBuild(BUILD_INFO, state.build)
    ? "화면과 실행부가 같은 빌드입니다."
    : "화면과 실행부의 빌드가 다르거나 확인되지 않습니다. 확장을 다시 로드하고 화면을 다시 여세요.";
  $("build-match").classList.toggle(
    "error",
    !sameBuild(BUILD_INFO, state.build),
  );
  $("restore-state").textContent = state.restoreState
    ? `복원 단계: ${state.restoreState.phase} · ${state.enabled ? "실행 중" : "정지"} · 생성 ${state.restoreState.cursor}/${state.restoreState.total} · 순서 조정 ${state.restoreState.passes}회 / 이동 ${state.restoreState.moves}회`
    : "진행 중인 복원 없음";
  const setupPopup = needsSetupTab(state.connected, location.search);
  $("login").hidden = state.connected || setupPopup;
  $("open-setup").hidden = !setupPopup;
  $("account").hidden = !state.connected;
  $("server").textContent = state.url || "";
  $("summary").textContent =
    `${state.count ?? 0}개 항목 · 마지막 서버 저장: ${formatKST(state.lastUpdated)}`;
  $("preview").hidden = !state.preview;
  if (!modeDirty) $("sync-mode").value = state.mode;
  $("mode-description").textContent = modeText[$("sync-mode").value];
  $("restore").textContent = "선택한 방식으로 최초 동기화";
  $("preview-description").textContent = modeText[$("sync-mode").value];
  const account = state.connected ? `${state.url}|${state.id}` : null;
  if (libraryAccount !== account) {
    libraryAccount = account;
    modeDirty = false;
    $("sync-mode").value = state.mode;
    $("mode-description").textContent = modeText[state.mode];
    $("preview-description").textContent = modeText[state.mode];
    libraryRequest++;
    libraryLoading = false;
    libraryPage = undefined;
    libraryParent = null;
    libraryOffset = 0;
    $("results").replaceChildren();
    $("folder-path").replaceChildren();
    $("library-status").textContent = "서버 목록을 새로 읽어 주세요.";
  }
  $("conflict").hidden = !state.conflict;
  $("progress").hidden = !state.progress;
  $("rollback").hidden = !state.applying;
  $("diagnose").hidden = !state.applying;
  $("diagnose-urls").hidden = !state.applying;
  if (state.progress) {
    $("progress").max = state.progress.total || 1;
    $("progress").value = state.progress.done;
  }
  $("pause").textContent = state.enabled ? "일시 정지" : "동기화 재개";
  updateControls();
  if (Date.now() > errorUntil)
    notice(
      state.error ||
        (state.connected
          ? `${state.phase}${state.progress ? ` (${state.progress.done}/${state.progress.total})` : ""}`
          : "서버 연결 설정"),
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
    updateControls();
  }
}
$("connect").addEventListener("submit", (event) => {
  event.preventDefault();
  action(() => connection.connect((data) => rpc("connect", { data })));
});
const connection = new ConnectionForm(
  browser,
  {
    url: $("url"),
    id: $("sync-id"),
    password: $("password"),
    permission: $("server-permission"),
    credentials: $("credentials"),
  },
  (text, error) => {
    if (error) errorUntil = Date.now() + 15000;
    notice(text, error);
  },
);
$("grant-server").onclick = () => action(() => connection.grant());
$("diagnose").onclick = () =>
  action(async () => {
    const report = await rpc("diagnose");
    alert(report);
  });
$("diagnose-urls").onclick = () =>
  action(async () => {
    alert(await rpc("diagnose", { details: true }));
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
async function saveMode() {
  const mode = $("sync-mode").value;
  if (
    !state.preview &&
    mode !== state.mode &&
    mode !== "both" &&
    !confirm(modeText[mode] + " 이 방식을 자동 동기화에도 적용하시겠습니까?")
  )
    return false;
  await rpc("mode", { mode });
  modeDirty = false;
  return true;
}
$("sync-mode").onchange = () => {
  modeDirty = true;
  $("mode-description").textContent = modeText[$("sync-mode").value];
  $("preview-description").textContent = modeText[$("sync-mode").value];
  updateControls();
};
$("save-mode").onclick = () => action(saveMode);
$("restore").onclick = () =>
  action(async () => {
    if (
      $("sync-mode").value === "download" &&
      state.initialUpload &&
      !confirm(
        "서버가 비어 있어 로컬 북마크를 모두 삭제하게 됩니다. 로컬을 백업한 후 계속하시겠습니까?",
      )
    )
      return;
    if (
      $("sync-mode").value === "upload" &&
      !state.initialUpload &&
      !confirm(
        "서버의 현재 자료를 백업하고 로컬 자료로 덮어씁니다. 계속하시겠습니까?",
      )
    )
      return;
    if (await saveMode()) await rpc("restore");
  });
$("sync").onclick = () =>
  action(async () => {
    if (!modeDirty || (await saveMode())) await rpc("sync");
  });
$("pause").onclick = () =>
  action(() => rpc("pause", { enabled: !state.enabled }));
$("disconnect").onclick = () => action(() => rpc("disconnect"));
$("choose-server").onclick = () =>
  action(() => rpc("resolve", { choice: "server" }));
$("choose-local").onclick = () =>
  action(() => rpc("resolve", { choice: "local" }));
$("open-setup").onclick = () =>
  browser.tabs.create({ url: browser.runtime.getURL("app.html") });
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
      anchor.download = `xbrowsersync-${button.dataset.export}-${formatKST(new Date()).slice(0, 10)}.json`;
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
function updateControls() {
  if (!state) return;
  folderPicker.update(state, busy);
  $("disconnect").disabled = busy || state.applying || state.pending;
  $("sync").disabled = busy || state.preview || state.conflict;
  $("sync-mode").disabled = busy || state.applying || state.pending;
  $("save-mode").disabled =
    busy || state.applying || state.pending || !modeDirty;
  $("list-previous").disabled =
    busy || libraryLoading || !libraryPage || libraryPage.offset === 0;
  $("list-next").disabled =
    busy ||
    libraryLoading ||
    !libraryPage ||
    libraryPage.offset + libraryPage.limit >= libraryPage.total;
  for (const id of ["view-recent", "view-folders", "refresh-library"])
    $(id).disabled = busy || libraryLoading || !state.connected;
}
async function loadLibrary(refreshServer = false) {
  const request = ++libraryRequest;
  libraryLoading = true;
  updateControls();
  $("library-status").textContent = "서버 북마크를 읽는 중…";
  try {
    const page = await rpc("server-list", {
      options: {
        view: libraryView,
        parent: libraryParent,
        offset: libraryOffset,
        query: $("search").value,
        refresh: refreshServer,
      },
    });
    if (request !== libraryRequest) return;
    libraryPage = page;
    $("results").replaceChildren();
    $("folder-path").replaceChildren();
    if (libraryView === "folders") {
      for (const crumb of [{ id: null, title: "전체 폴더" }, ...page.path]) {
        const button = document.createElement("button");
        button.textContent = crumb.title;
        button.onclick = () => {
          libraryParent = crumb.id;
          libraryOffset = 0;
          $("search").value = "";
          loadLibrary();
        };
        $("folder-path").append(button);
      }
    }
    for (const node of page.items) {
      const item = document.createElement("li");
      if (node.folder) {
        const button = document.createElement("button");
        button.textContent = `📁 ${node.title} (${node.count})`;
        button.onclick = () => {
          libraryParent = node.id;
          libraryOffset = 0;
          $("search").value = "";
          loadLibrary();
        };
        item.append(button);
      } else if (/^https?:\/\//i.test(node.url || "")) {
        const link = document.createElement("a");
        link.textContent = node.title;
        link.href = node.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        item.append(link);
      } else item.textContent = node.title;
      $("results").append(item);
    }
    $("library-hint").textContent =
      libraryView === "recent"
        ? "최근 추가 순: 기존 xBrowserSync와 같은 서버 ID 내림차순입니다. 추가 날짜는 서버에 저장돼 있지 않습니다."
        : "서버에 저장된 폴더 순서입니다. 폴더를 누르면 하위 항목을 표시합니다. 검색은 현재 폴더 안에서 수행합니다.";
    $("library-status").textContent =
      `${page.total}개 중 ${page.total ? page.offset + 1 : 0}–${Math.min(page.offset + page.limit, page.total)} · 서버 저장: ${formatKST(page.lastUpdated)} · 조회: ${formatKST(page.fetchedAt)}`;
  } catch (error) {
    if (request === libraryRequest)
      $("library-status").textContent = error.message;
  } finally {
    if (request === libraryRequest) {
      libraryLoading = false;
      updateControls();
    }
  }
}
$("view-recent").onclick = () => {
  libraryView = "recent";
  libraryParent = null;
  libraryOffset = 0;
  loadLibrary();
};
$("view-folders").onclick = () => {
  libraryView = "folders";
  libraryParent = null;
  libraryOffset = 0;
  loadLibrary();
};
$("refresh-library").onclick = () => {
  libraryParent = null;
  libraryOffset = 0;
  loadLibrary(true);
};
$("list-previous").onclick = () => {
  libraryOffset = Math.max(0, libraryOffset - (libraryPage?.limit || 30));
  loadLibrary();
};
$("list-next").onclick = () => {
  libraryOffset += libraryPage?.limit || 30;
  loadLibrary();
};
$("server-library").ontoggle = () => {
  if ($("server-library").open) {
    libraryOffset = 0;
    libraryParent = null;
    loadLibrary(true);
  }
};
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    libraryOffset = 0;
    loadLibrary();
  }, 250);
};
async function initialize() {
  const status = await rpc("status");
  await connection.load(status);
  connection.bind();
  await refresh();
  ready = true;
  folderPicker.load();
}
initialize().catch((error) => notice(error.message, true));
setInterval(() => {
  if (ready && !busy) refresh().catch((error) => notice(error.message, true));
}, 1500);
