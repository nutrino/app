import { ROOTS, SEPARATOR } from "./protocol.mjs";

// The server exposes only its current encrypted snapshot. Keep a bounded local
// journal of revisions this browser actually observes or uploads.
const MAX_BATCHES = 30;
const MAX_ITEMS_PER_BATCH = 100;
const ROOT_LABELS = ["북마크 도구 모음", "북마크 메뉴", "기타 북마크"];
const short = (value, limit = 240) => String(value || "").slice(0, limit);
const titleOf = (node) =>
  node.title || (node.url === SEPARATOR ? "구분선" : "(제목 없음)");

function indexTree(tree) {
  const index = new Map();
  const walk = (nodes, parentId) => {
    for (const node of nodes) {
      index.set(node.id, { node, parentId });
      if (node.children) walk(node.children, node.id);
    }
  };
  for (const root of tree) {
    const label = ROOT_LABELS[ROOTS.indexOf(root.title)] || root.title;
    index.set(root.id, { node: root, parentId: null, label });
    walk(root.children || [], root.id);
  }
  return index;
}

function pathOf(record, index) {
  const parts = [];
  for (let current = record; current; current = index.get(current.parentId))
    parts.push(current.label || titleOf(current.node));
  return parts.reverse().join(" » ");
}

function sameTags(a, b) {
  return (
    a === b ||
    (Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((tag, i) => tag === b[i]))
  );
}

export function appendServerHistory(
  history = [],
  before,
  after,
  revision,
  source,
) {
  if (!before || !after || history.some((batch) => batch.revision === revision))
    return history;
  const oldNodes = indexTree(before);
  const newNodes = indexTree(after);
  const counts = { added: 0, changed: 0, deleted: 0 };
  const deleted = [],
    changed = [],
    added = [];
  const entry = (kind, record, index, fields = [], details = []) => ({
    kind,
    id: record.node.id,
    title: short(titleOf(record.node), 160),
    path: short(pathOf(record, index), 400),
    url: short(record.node.url, 300),
    folder: !!record.node.children,
    fields,
    details,
  });
  for (const [id, previous] of oldNodes) {
    if (previous.parentId === null) continue;
    const current = newNodes.get(id);
    if (!current) {
      counts.deleted++;
      if (deleted.length < MAX_ITEMS_PER_BATCH)
        deleted.push(entry("deleted", previous, oldNodes));
      continue;
    }
    const fields = [];
    const details = [];
    for (const [key, label] of [
      ["title", "제목"],
      ["url", "주소"],
      ["description", "설명"],
      ["tags", "태그"],
    ])
      if (
        key === "tags"
          ? !sameTags(previous.node.tags, current.node.tags)
          : previous.node[key] !== current.node[key]
      ) {
        fields.push(label);
        if (changed.length < MAX_ITEMS_PER_BATCH) {
          const beforeValue = Array.isArray(previous.node[key])
            ? previous.node[key].join(", ")
            : previous.node[key];
          const afterValue = Array.isArray(current.node[key])
            ? current.node[key].join(", ")
            : current.node[key];
          details.push(
            `${label}: ${short(beforeValue, 100)} → ${short(afterValue, 100)}`,
          );
        }
      }
    if (previous.parentId !== current.parentId) {
      fields.push("폴더 위치");
      if (changed.length < MAX_ITEMS_PER_BATCH)
        details.push(
          `폴더 위치: ${short(pathOf(previous, oldNodes), 160)} → ${short(pathOf(current, newNodes), 160)}`,
        );
    }
    if (fields.length) {
      counts.changed++;
      if (changed.length < MAX_ITEMS_PER_BATCH)
        changed.push(entry("changed", current, newNodes, fields, details));
    }
  }
  for (const [id, current] of newNodes)
    if (current.parentId !== null && !oldNodes.has(id)) {
      counts.added++;
      if (added.length < MAX_ITEMS_PER_BATCH)
        added.push(entry("added", current, newNodes));
    }
  if (!counts.added && !counts.changed && !counts.deleted) return history;
  return [
    {
      revision,
      source,
      counts,
      items: [...deleted, ...changed, ...added]
        .slice(0, MAX_ITEMS_PER_BATCH)
        .map((item) => ({ ...item, revision, source })),
    },
    ...history,
  ].slice(0, MAX_BATCHES);
}

export function serverHistoryPage(
  history = [],
  { offset = 0, query = "" } = {},
) {
  const words = String(query)
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const all = history
    .flatMap((batch) => batch.items)
    .filter((item) =>
      words.every((word) =>
        [
          item.title,
          item.path,
          item.url,
          ...item.fields,
          ...(item.details || []),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(word),
      ),
    );
  offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const limit = 30;
  return {
    total: all.length,
    offset,
    limit,
    items: all.slice(offset, offset + limit),
    latest: history[0]
      ? {
          revision: history[0].revision,
          counts: history[0].counts,
          shown: history[0].items.length,
        }
      : null,
  };
}
