import { SEPARATOR, validateTree } from "./protocol.mjs";

export function serverPage(
  tree,
  { view = "recent", parent = null, offset = 0, query = "" } = {},
) {
  if (!["recent", "folders"].includes(view))
    throw Error("알 수 없는 목록 보기입니다.");
  const all = [],
    folders = new Map();
  const walk = (nodes, path = []) => {
    for (const node of nodes) {
      if (node.children) {
        const trail = [...path, { id: node.id, title: node.title }];
        folders.set(node.id, { node, path: trail });
        walk(node.children, trail);
      } else if (node.url !== SEPARATOR) all.push(node);
    }
  };
  walk(tree);
  const folder = parent === null ? null : folders.get(parent);
  if (view === "folders" && parent !== null && !folder)
    throw Error("서버 폴더가 없습니다. 목록을 새로 읽어 주세요.");
  let items =
    view === "recent"
      ? all.sort((a, b) => b.id - a.id)
      : folder?.node.children || tree;
  const words = String(query)
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  items = items.filter((node) =>
    words.every((word) =>
      [node.title, node.url, node.description, ...(node.tags || [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(word),
    ),
  );
  offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const limit = 100;
  return {
    total: items.length,
    offset,
    limit,
    path: view === "folders" ? folder?.path || [] : [],
    items: items.slice(offset, offset + limit).map((node) => ({
      id: node.id,
      title: node.title || (node.url === SEPARATOR ? "구분선" : "(제목 없음)"),
      url: node.url,
      folder: !!node.children,
      count: node.children?.length,
    })),
  };
}

// Initial two-way sync has no common history. Preserve both sides, matching
// duplicate entries one-to-one; server order/metadata wins for shared entries.
export function mergeInitial(server, local, matchKey) {
  const result = structuredClone(server);
  let next = 0;
  const scan = (nodes) =>
    nodes.forEach((node) => {
      next = Math.max(next, node.id + 1);
      if (node.children) scan(node.children);
    });
  scan(result);
  const copy = (node) => ({
    ...structuredClone(node),
    id: next++,
    ...(node.children ? { children: node.children.map(copy) } : {}),
  });
  const key =
    matchKey ||
    ((node) =>
      JSON.stringify([!!node.children, node.title || "", node.url || ""]));
  const merge = (target, incoming) => {
    const queues = new Map();
    for (const node of [...target].reverse()) {
      const k = key(node);
      if (!queues.has(k)) queues.set(k, []);
      queues.get(k).push(node);
    }
    for (const node of incoming) {
      const match = queues.get(key(node))?.pop();
      if (!match) target.push(copy(node));
      else if (node.children) merge(match.children, node.children);
    }
  };
  for (const root of result)
    merge(
      root.children,
      local.find((node) => node.title === root.title)?.children || [],
    );
  return validateTree(result);
}
