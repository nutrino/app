import { ROOTS, SEPARATOR, validateTree } from "./protocol.mjs";
function chromeAboutURL(url) {
  if (
    url.protocol !== "about:" ||
    !/^[a-z0-9-]+$/i.test(url.pathname) ||
    ["blank", "srcdoc"].includes(url.pathname.toLowerCase())
  )
    return url.href;
  return `chrome://${url.pathname.toLowerCase()}/${url.search}${url.hash}`;
}
function sameURL(a, b, chromium = false) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    const actual = new URL(a),
      original = new URL(b);
    return (
      actual.href === original.href ||
      (chromium && actual.href === chromeAboutURL(original))
    );
  } catch {
    return false;
  }
}
// Chromium BookmarkNode::SetTitle replaces these characters without trimming.
const chromeTitle = (title) => title.replace(/[\n\r\t\u2028\u2029]/g, " ");
export class Native {
  constructor(bookmarks, firefox) {
    this.bookmarks = bookmarks;
    this.firefox = firefox;
  }
  async roots() {
    const tree = await this.bookmarks.getTree();
    const roots = tree[0].children || [];
    const result = {};
    for (const root of roots) {
      if (root.unmodifiable) continue;
      const title =
        {
          toolbar_____: ROOTS[0],
          menu________: ROOTS[1],
          unfiled_____: ROOTS[2],
          1: ROOTS[0],
          2: ROOTS[2],
        }[root.id] ||
        { "bookmarks-bar": ROOTS[0], other: ROOTS[2] }[root.folderType];
      if (!title) {
        if (root.children?.length)
          throw Error(
            "지원하지 않는 브라우저 루트 폴더가 있습니다. 데이터를 보존하기 위해 동기화를 중단했습니다.",
          );
        continue;
      }
      if (result[title])
        throw Error(
          "Chrome 계정/로컬 북마크 루트가 중복됩니다. Chrome 자체 북마크 동기화를 정리한 후 다시 시도하세요.",
        );
      result[title] = root;
    }
    if (!result[ROOTS[0]] || !result[ROOTS[2]])
      throw Error("브라우저 북마크 루트를 찾을 수 없습니다.");
    return result;
  }
  async snapshot(previous = [], mapping = {}) {
    const roots = await this.roots();
    const metadata = new Map();
    let next = 0;
    const visit = (nodes) => {
      for (const n of nodes) {
        metadata.set(n.id, n);
        next = Math.max(next, n.id + 1);
        if (n.children) visit(n.children);
      }
    };
    visit(previous);
    const outputMap = {};
    const used = new Set();
    const convert = (n, rootTitle) => {
      let id = mapping[n.id];
      if (rootTitle) id = previous.find((b) => b.title === rootTitle)?.id ?? id;
      if (!Number.isSafeInteger(id) || used.has(id)) id = next++;
      used.add(id);
      outputMap[n.id] = id;
      const old = metadata.get(id);
      const title = n.title || "";
      const out = {
        id,
        title:
          rootTitle ||
          (!this.firefox &&
          typeof old?.title === "string" &&
          title === chromeTitle(old.title)
            ? old.title
            : title),
      };
      if (old?.description !== undefined) out.description = old.description;
      if (old?.tags !== undefined) out.tags = [...old.tags];
      if (
        n.type === "separator" ||
        n.url === SEPARATOR ||
        (n.url === "chrome://newtab/" &&
          (n.title === "|" || /^─+$/.test(n.title)))
      )
        out.url = SEPARATOR;
      else if (n.url !== undefined)
        out.url = sameURL(n.url, old?.url, !this.firefox) ? old.url : n.url;
      else out.children = (n.children || []).map((child) => convert(child));
      return out;
    };
    const tree = [];
    for (const title of ROOTS) {
      const root = roots[title];
      if (root)
        tree.push(
          convert(
            !this.firefox && title === ROOTS[2]
              ? {
                  ...root,
                  children: root.children.filter(
                    (n) => !(n.title === ROOTS[1] && n.children),
                  ),
                }
              : root,
            title,
          ),
        );
      else if (title === ROOTS[1]) {
        // Chromium represents the Firefox Menu as an ordinary folder in Other.
        const other = roots[ROOTS[2]];
        const wrappers = other.children.filter(
          (n) => n.title === ROOTS[1] && n.children,
        );
        if (wrappers.length > 1)
          throw Error("Other 아래 [xbs] Menu 폴더가 중복되어 있습니다.");
        if (wrappers[0]) tree.push(convert(wrappers[0], title));
        else {
          const id = previous.find((n) => n.title === title)?.id ?? next++;
          used.add(id);
          tree.push({ id, title, children: [] });
        }
      }
    }
    if (!this.firefox) {
      const other = tree.find((n) => n.title === ROOTS[2]);
      other.children = other.children.filter(
        (n) => !(n.title === ROOTS[1] && n.children),
      );
    }
    return { tree: validateTree(tree), mapping: outputMap };
  }
  async plan(tree, incremental = false) {
    const roots = await this.roots();
    const steps = [];
    const rootMap = {};
    const walk = (nodes, parent) =>
      nodes.forEach((node, index) => {
        steps.push({
          node: { ...node, children: node.children ? [] : undefined },
          parent,
          index,
        });
        if (node.children) walk(node.children, node.id);
      });
    for (const title of ROOTS) {
      const node = tree.find((n) => n.title === title);
      if (roots[title] && node) {
        rootMap[node.id] = roots[title].id;
        walk(node.children, node.id);
      } else if (node) {
        if (
          incremental &&
          !node.children.length &&
          !roots[ROOTS[2]].children.some(
            (child) => child.title === ROOTS[1] && child.children,
          )
        )
          continue;
        // A wrapper is included even for an empty menu; it has an ordinary sync ID.
        const other = tree.find((n) => n.title === ROOTS[2]);
        if (!other)
          throw Error(
            "Other 루트가 없는 데이터를 Chrome에 적용할 수 없습니다.",
          );
        steps.push({
          node: { ...node, children: [] },
          parent: other.id,
          index: 0,
        });
        walk(node.children, node.id);
      }
    }
    if (!this.firefox) {
      const other = tree.find((n) => n.title === ROOTS[2]);
      const menu = tree.find((n) => n.title === ROOTS[1]);
      const offset = steps.some((step) => step.node.id === menu.id) ? 1 : 0;
      for (const step of steps)
        if (step.parent === other.id && step.node.id !== menu.id)
          step.index += offset;
    }
    const plan = {
      steps,
      rootMap,
      // Removing the tail avoids repeatedly shifting every following sibling in Places.
      clearFromEnd: true,
      clear: Object.values(roots).flatMap((root) =>
        root.children.map((child) => child.id).reverse(),
      ),
    };
    if (incremental) this.matchExisting(plan, roots);
    return plan;
  }
  matchExisting(plan, roots) {
    plan.incremental = true;
    plan.reused = {};
    plan.updates = {};
    const nodes = new Map();
    const visit = (node) => {
      nodes.set(node.id, node);
      node.children?.forEach(visit);
    };
    Object.values(roots).forEach(visit);
    const used = new Set(Object.values(plan.rootMap));
    const queues = new Map();
    const key = (node) => {
      if (
        node.type === "separator" ||
        node.url === SEPARATOR ||
        (node.url === "chrome://newtab/" &&
          (node.title === "|" || /^─+$/.test(node.title)))
      )
        return "separator";
      if (node.url === undefined)
        return `folder:${this.firefox ? node.title || "" : chromeTitle(node.title || "")}`;
      try {
        const url = new URL(node.url);
        return `url:${this.firefox ? url.href : chromeAboutURL(url)}`;
      } catch {
        return `url:${node.url}`;
      }
    };
    const take = (list) => {
      while (list?.length) {
        const node = list.pop();
        if (!used.has(node.id)) return node;
      }
    };
    for (const step of plan.steps) {
      const parent = plan.rootMap[step.parent] || plan.reused[step.parent];
      if (!parent) continue;
      if (!queues.has(parent)) {
        const byKey = new Map(),
          exact = new Map();
        for (const child of [...nodes.get(parent).children].reverse()) {
          const k = key(child),
            e = JSON.stringify([k, child.title || ""]);
          if (!byKey.has(k)) byKey.set(k, []);
          if (!exact.has(e)) exact.set(e, []);
          byKey.get(k).push(child);
          exact.get(e).push(child);
        }
        queues.set(parent, { byKey, exact });
      }
      const spec = this.createSpec(step, parent),
        k = key(spec);
      const { byKey, exact } = queues.get(parent);
      const candidate =
        take(exact.get(JSON.stringify([k, spec.title || ""]))) ||
        take(byKey.get(k));
      if (!candidate) continue;
      used.add(candidate.id);
      plan.reused[step.node.id] = candidate.id;
      if (!this.matches(candidate, spec))
        plan.updates[step.node.id] = { title: spec.title };
    }
    plan.clear = [];
    const collect = (node) => {
      for (const child of [...(node.children || [])].reverse()) {
        if (used.has(child.id)) collect(child);
        else plan.clear.push(child.id);
      }
    };
    Object.values(roots).forEach(collect);
    const counts = {};
    for (const step of plan.steps)
      if (plan.reused[step.node.id])
        counts[step.parent] = (counts[step.parent] || 0) + 1;
    // Append new items so interrupted creates never collide with retained siblings.
    for (const step of plan.steps)
      if (!plan.reused[step.node.id]) {
        step.appendIndex = counts[step.parent] || 0;
        counts[step.parent] = step.appendIndex + 1;
      }
  }
  createSpec(step, parentId) {
    const spec = { parentId, index: step.index, title: step.node.title || "" };
    if (step.node.url === SEPARATOR && this.firefox) {
      spec.type = "separator";
      delete spec.title;
    } else if (step.node.url !== undefined) {
      spec.url = step.node.url;
      if (step.node.url === SEPARATOR) {
        spec.title = "|";
        spec.url = "chrome://newtab/";
      }
    }
    return spec;
  }
  orderPlan(plan, created, parents) {
    const ids = { ...plan.rootMap, ...created };
    const groups = new Map();
    for (const step of plan.steps) {
      if (!parents.has(step.parent)) continue;
      if (!ids[step.parent] || !ids[step.node.id])
        throw Error("순서 복구에 필요한 생성 기록이 없습니다.");
      if (!groups.has(step.parent)) groups.set(step.parent, []);
      groups
        .get(step.parent)
        .push({ id: ids[step.node.id], index: step.index });
    }
    return [...groups].map(([parent, children]) => ({
      parentId: ids[parent],
      ids: children.sort((a, b) => a.index - b.index).map((child) => child.id),
    }));
  }
  async reorderGroup(group, checkpoint, expired) {
    const children = await this.bookmarks.getChildren(group.parentId);
    const ids = children.map((node) => node.id);
    const members = new Set(ids);
    if (
      ids.length !== group.ids.length ||
      group.ids.some((id) => !members.has(id))
    )
      throw Error("순서 복구 도중 폴더 내용이 변경되어 중단했습니다.");
    for (let index = 0; index < group.ids.length; index++) {
      if (ids[index] === group.ids[index]) continue;
      const from = ids.indexOf(group.ids[index], index);
      // Await every move. Never remove/recreate bookmarks or change their parent.
      await checkpoint();
      await this.bookmarks.move(group.ids[index], { index });
      ids.splice(index, 0, ids.splice(from, 1)[0]);
      if (expired()) return false;
    }
    return true;
  }
  matches(native, spec) {
    if (!native) return false;
    if (spec.type === "separator") return native.type === "separator";
    return (
      (native.title === spec.title ||
        (!this.firefox && native.title === chromeTitle(spec.title))) &&
      sameURL(native.url, spec.url, !this.firefox) &&
      (spec.url !== undefined || native.url === undefined)
    );
  }
}
