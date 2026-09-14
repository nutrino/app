import { ROOTS, SEPARATOR, validateTree } from "./protocol.mjs";
function sameURL(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}
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
      const out = { id, title: rootTitle || n.title || "" };
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
        out.url = sameURL(n.url, old?.url) ? old.url : n.url;
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
  async plan(tree) {
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
      for (const step of steps)
        if (
          step.parent === other.id &&
          step.node.id !== tree.find((n) => n.title === ROOTS[1]).id
        )
          step.index += 1;
    }
    return {
      steps,
      rootMap,
      clear: Object.values(roots).flatMap((root) =>
        root.children.map((child) => child.id),
      ),
    };
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
  matches(native, spec) {
    if (!native) return false;
    if (spec.type === "separator") return native.type === "separator";
    return (
      native.title === spec.title &&
      sameURL(native.url, spec.url) &&
      (spec.url !== undefined || native.url === undefined)
    );
  }
}
