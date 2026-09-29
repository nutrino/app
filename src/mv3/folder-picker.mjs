const folderCollator = new Intl.Collator("ko", { numeric: true });
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
export function displayFolderTitle(node, isRoot = false) {
  if (
    isRoot &&
    (node.id === "unfiled_____" ||
      node.id === "2" ||
      node.folderType === "other")
  )
    return "기타 북마크";
  return node.title || "(이름 없는 폴더)";
}
export function localFolders(tree) {
  const folders = [];
  const walk = (nodes, parents = [], blocked = false, parentId = null) => {
    for (const node of nodes) {
      if (node.url !== undefined || node.type === "separator") continue;
      const title = displayFolderTitle(node, parentId === null);
      const path = [...parents, title];
      const readonly = blocked || !!node.unmodifiable;
      if (!readonly)
        folders.push({
          id: node.id,
          parentId,
          title,
          path: path.join(" » "),
          segments: path,
        });
      walk(node.children || [], path, readonly, node.id);
    }
  };
  // The synthetic browser root is not a valid bookmark destination.
  for (const root of tree) walk(root.children || []);
  return folders.sort(
    (a, b) =>
      folderCollator.compare(a.path, b.path) || a.id.localeCompare(b.id),
  );
}
export function searchFolders(folders, query) {
  const words = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const matches = folders.filter((folder) => {
    const path = folder.path.normalize("NFKC").toLocaleLowerCase();
    return words.every((word) => path.includes(word));
  });
  const rank = (folder) => {
    const segments = (folder.segments || [folder.path]).map((segment) =>
      segment.normalize("NFKC").toLocaleLowerCase(),
    );
    const name = segments.at(-1);
    return words.reduce((total, word) => {
      if (name === word) return total + 100;
      if (name.startsWith(word)) return total + 80;
      if (name.includes(word)) return total + 60;
      if (segments.slice(0, -1).some((part) => part === word))
        return total + 40;
      if (segments.slice(0, -1).some((part) => part.startsWith(word)))
        return total + 30;
      return total + 20;
    }, 0);
  };
  return matches
    .map((folder) => ({ folder, score: rank(folder) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        folderCollator.compare(a.folder.path, b.folder.path) ||
        a.folder.id.localeCompare(b.folder.id),
    )
    .map(({ folder }) => folder);
}
export function collapsedFolderSegments(branch, folder) {
  return folder.segments.slice(branch.segments.length);
}
export function folderMatchTree(folders, matches) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const selected = new Set(matches.map((folder) => folder.id));
  const included = new Set(selected);
  for (const folder of matches) {
    let parentId = folder.parentId;
    const seen = new Set([folder.id]);
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      included.add(parentId);
      parentId = byId.get(parentId).parentId;
    }
  }
  const nodes = new Map(
    [...included].map((id) => [
      id,
      { folder: byId.get(id), match: selected.has(id), children: [] },
    ]),
  );
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.folder.parentId);
    (parent ? parent.children : roots).push(node);
  }
  const sort = (siblings) => {
    siblings.sort(
      (a, b) =>
        folderCollator.compare(a.folder.title, b.folder.title) ||
        a.folder.id.localeCompare(b.folder.id),
    );
    for (const node of siblings) sort(node.children);
  };
  sort(roots);
  return roots;
}
// Map normalized search matches back to original graphemes (Hangul, fullwidth,
// combining marks). Render only text nodes, never bookmark names as HTML.
export function highlightedParts(text, query) {
  const words = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const graphemes = [...graphemeSegmenter.segment(text)];
  let normalized = "";
  const owners = [];
  graphemes.forEach(({ segment }, index) => {
    const folded = segment.normalize("NFKC").toLocaleLowerCase();
    normalized += folded;
    for (let i = 0; i < folded.length; i++) owners.push(index);
  });
  const hits = new Set();
  for (const word of words) {
    let from = 0,
      at;
    while ((at = normalized.indexOf(word, from)) !== -1) {
      for (let i = at; i < at + word.length; i++) hits.add(owners[i]);
      from = at + 1;
    }
  }
  const parts = [];
  graphemes.forEach(({ segment }, index) => {
    const match = hits.has(index);
    if (parts.length && parts.at(-1).match === match)
      parts.at(-1).text += segment;
    else parts.push({ text: segment, match });
  });
  return parts;
}
export function bookmarkBlock(state) {
  if (state.applying || state.apply)
    return "복원 중에는 북마크를 추가할 수 없습니다. 복원 완료 후 다시 시도하세요.";
  if (state.enabled && state.mode === "download" && !state.preview)
    return "서버 → 로컬 동기화 중입니다. 추가할 북마크를 유지하려면 동기화를 일시 정지하거나 양방향·로컬 → 서버로 변경하세요.";
  return "";
}
export class FolderPicker {
  constructor(browser, rpc, get) {
    this.browser = browser;
    this.rpc = rpc;
    this.get = get;
    this.folders = [];
    this.recent = [];
    this.recentFolders = [];
    this.limit = 50;
    this.query = "";
    this.view = "list";
    this.collapsedFolders = new Set();
    for (const view of ["list", "tree"])
      get(`folder-view-${view}`).onclick = () => {
        this.view = view;
        this.render();
      };
    const input = get("folder-query");
    const scheduleSearch = () => {
      clearTimeout(this.searchTimer);
      this.query = "";
      this.limit = 50;
      this.collapsedFolders.clear();
      const query = input.value.trim();
      this.render();
      if (!query) return;
      this.searchTimer = setTimeout(() => {
        this.query = query;
        if (this.loaded) this.render();
        else this.loadFolders();
      }, 500);
    };
    input.oninput = scheduleSearch;
    // Search the current input after inactivity even while an IME keeps its
    // final character in composition until Enter/blur.
    input.oncompositionstart = scheduleSearch;
    input.oncompositionend = scheduleSearch;
    get("folder-more").onclick = () => {
      this.limit += 50;
      this.render();
    };
    get("folder-reload").onclick = () => {
      this.loaded = false;
      this.refreshIndex = true;
      return this.query ? this.loadFolders(true) : this.loadRecent();
    };
  }
  async load() {
    const foldersLoading = this.loadRecent();
    let pageError;
    try {
      const [tab] = await this.browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.url || /^(moz-extension|chrome-extension):/.test(tab.url))
        throw Error("저장할 웹페이지에서 위성 아이콘을 눌러 주세요.");
      this.page = { url: tab.url, title: tab.title || tab.url };
      this.get("bookmark-page").textContent = this.page.title;
      this.get("bookmark-page").title = this.page.url;
    } catch (error) {
      pageError = error.message;
    }
    // Folder browsing must also work in a settings tab or on a restricted page.
    await foldersLoading;
    this.update(this.state || {}, this.busy);
    if (pageError) this.get("folder-feedback").textContent = pageError;
    this.get("folder-query").focus();
  }
  async loadRecent() {
    try {
      const data = await this.rpc("recent-folders");
      this.recentFolders = data.folders;
      if (!this.loaded) this.recent = data.folders.map((folder) => folder.id);
      this.recentLoaded = true;
      this.render();
    } catch (error) {
      this.get("folder-feedback").textContent = error.message;
    }
  }
  async loadFolders(refresh = false) {
    if (this.loading) return;
    this.loading = true;
    this.update(this.state || {}, this.busy);
    this.get("folder-feedback").textContent = "로컬 폴더를 읽는 중…";
    try {
      const data = await this.rpc("local-folders", {
        refresh: refresh || !!this.refreshIndex,
      });
      this.refreshIndex = false;
      this.folders = data.folders;
      this.loaded = true;
      this.recentLoaded = true;
      this.recent = data.recent;
      this.limit = 50;
      this.get("folder-feedback").textContent =
        "폴더를 누르면 현재 페이지를 저장합니다.";
      this.render();
    } catch (error) {
      this.get("folder-feedback").textContent = error.message;
    } finally {
      this.loading = false;
      this.update(this.state || {}, this.busy);
    }
  }
  update(state, busy = false) {
    this.state = state;
    this.busy = busy;
    const blocked = bookmarkBlock(state);
    this.get("folder-warning").textContent = blocked;
    this.get("folder-warning").hidden = !blocked;
    this.disabled =
      busy || this.saving || this.loading || !this.page || !!blocked;
    for (const button of this.buttons || []) button.disabled = this.disabled;
    this.get("folder-more").disabled = !!(busy || this.saving || this.loading);
    this.get("folder-reload").disabled = !!(
      busy ||
      this.saving ||
      this.loading
    );
  }
  render() {
    const matches = this.query ? searchFolders(this.folders, this.query) : [];
    for (const view of ["list", "tree"])
      this.get(`folder-view-${view}`).setAttribute(
        "aria-pressed",
        String(this.view === view),
      );
    this.get("folder-count").hidden = !this.query;
    this.get("folder-count").textContent = this.query
      ? `${matches.length}개 폴더 검색됨 · ${Math.min(matches.length, this.limit)}개 표시`
      : "";
    this.get("folder-more").hidden = matches.length <= this.limit;
    this.get("folder-results").replaceChildren();
    this.buttons = [];
    this.get("recent-folders").replaceChildren();
    const byId = new Map(
      [...this.recentFolders, ...this.folders].map((folder) => [
        folder.id,
        folder,
      ]),
    );
    const recent = this.recent
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 10);
    this.get("recent-folder-empty").hidden =
      !this.recentLoaded || recent.length > 0;
    const fillFolderLabel = (
      element,
      folder,
      segments = folder.segments || [folder.path],
    ) => {
      element.textContent = "";
      segments.forEach((segment, index) => {
        if (index) {
          const separator = document.createElement("span");
          separator.className = "folder-separator";
          separator.textContent = " » ";
          element.append(separator);
        }
        for (const part of highlightedParts(segment, this.query)) {
          const text = document.createElement(part.match ? "mark" : "span");
          text.textContent = part.text;
          element.append(text);
        }
      });
    };
    const appendFolder = (folder, list, segments) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      fillFolderLabel(button, folder, segments);
      button.title = folder.path;
      button.onclick = () => this.add(folder);
      item.append(button);
      (typeof list === "string" ? this.get(list) : list).append(item);
      this.buttons.push(button);
      return button;
    };
    for (const folder of recent) appendFolder(folder, "recent-folders");
    const visible = matches.slice(0, this.limit);
    if (this.view === "list") {
      this.get("folder-results").className = "";
      for (const folder of visible) appendFolder(folder, "folder-results");
    } else {
      this.get("folder-results").className = "folder-tree";
      const visibleRank = new Map(
        visible.map((folder, index) => [folder.id, index]),
      );
      const appendBranch = (branch, list) => {
        const item = document.createElement("li");
        const row = document.createElement("div");
        row.className = "folder-tree-row";
        const label = document.createElement(branch.match ? "button" : "span");
        label.className = branch.match ? "" : "folder-context";
        fillFolderLabel(label, branch.folder, [branch.folder.title]);
        if (branch.match) {
          label.type = "button";
          label.title = branch.folder.path;
          label.onclick = () => this.add(branch.folder);
          this.buttons.push(label);
        }
        const hasChildren = branch.children.length > 0;
        if (hasChildren) {
          const children = document.createElement("ul");
          const flat = document.createElement("ul");
          flat.className = "folder-flat-results";
          const flatButtons = [];
          const buildFlat = () => {
            for (const button of flatButtons) {
              const index = this.buttons.indexOf(button);
              if (index !== -1) this.buttons.splice(index, 1);
            }
            flatButtons.length = 0;
            flat.replaceChildren();
            const descendants = [];
            const collect = (node) => {
              for (const child of node.children) {
                const include =
                  !child.children.length ||
                  this.collapsedFolders.has(child.folder.id);
                if (child.match && include)
                  descendants.push({
                    folder: child.folder,
                    segments: collapsedFolderSegments(
                      branch.folder,
                      child.folder,
                    ),
                  });
                collect(child);
              }
            };
            collect(branch);
            descendants.sort(
              (a, b) =>
                visibleRank.get(a.folder.id) - visibleRank.get(b.folder.id),
            );
            for (const { folder, segments } of descendants)
              flatButtons.push(appendFolder(folder, flat, segments));
          };
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "folder-toggle";
          const updateToggle = () => {
            const collapsed = this.collapsedFolders.has(branch.folder.id);
            toggle.textContent = collapsed ? "▸" : "▾";
            toggle.setAttribute("aria-expanded", String(!collapsed));
            toggle.setAttribute(
              "aria-label",
              `${branch.folder.path} ${collapsed ? "펼치기" : "접기"}`,
            );
            children.hidden = collapsed;
            flat.hidden = !collapsed;
            if (collapsed) buildFlat();
          };
          toggle.onclick = () => {
            if (this.collapsedFolders.has(branch.folder.id))
              this.collapsedFolders.delete(branch.folder.id);
            else this.collapsedFolders.add(branch.folder.id);
            updateToggle();
            this.update(this.state || {}, this.busy);
          };
          row.append(toggle);
          row.append(label);
          item.append(row);
          for (const child of branch.children) appendBranch(child, children);
          item.append(children);
          item.append(flat);
          updateToggle();
        } else {
          const spacer = document.createElement("span");
          spacer.className = "folder-toggle-spacer";
          spacer.setAttribute("aria-hidden", "true");
          row.append(spacer);
          row.append(label);
          item.append(row);
        }
        list.append(item);
      };
      for (const branch of folderMatchTree(this.folders, visible))
        appendBranch(branch, this.get("folder-results"));
    }
    this.update(this.state || {}, this.busy);
  }
  async add(folder) {
    if (this.disabled) return;
    this.saving = true;
    this.update(this.state || {}, this.busy);
    try {
      const result = await this.rpc("add-bookmark", {
        data: { ...this.page, parentId: folder.id },
      });
      if (result.recent) {
        this.recent = result.recent;
        this.render();
      }
      this.get("folder-feedback").textContent = result.existing
        ? `이미 이 폴더에 저장되어 있습니다: ${folder.path}`
        : `저장했습니다: ${folder.path}`;
    } catch (error) {
      this.get("folder-feedback").textContent = error.message;
    } finally {
      this.saving = false;
      this.update(this.state || {}, this.busy);
    }
  }
}
