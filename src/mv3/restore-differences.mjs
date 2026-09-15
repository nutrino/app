// Report identifiers and field names only; never expose bookmark text or URLs.
export function compareRestoreTrees(expected, actual) {
  const flatten = (tree) => {
    const map = new Map();
    const walk = (nodes, parent = null) =>
      nodes.forEach((node, index) => {
        map.set(node.id, { node, parent, index });
        if (node.children) walk(node.children, node.id);
      });
    walk(tree);
    return map;
  };
  const before = flatten(expected),
    after = flatten(actual);
  const counts = {},
    examples = [];
  const orderParents = new Set();
  const add = (field, id) => {
    counts[field] = (counts[field] || 0) + 1;
    if (examples.length < 8) examples.push(`ID ${id}: ${field}`);
  };
  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) {
      add("누락", id);
      continue;
    }
    for (const field of ["title", "url", "description", "tags"])
      if (JSON.stringify(a.node[field]) !== JSON.stringify(b.node[field]))
        add(field, id);
    if (!!a.node.children !== !!b.node.children) add("종류", id);
    if (a.parent !== b.parent) add("부모", id);
    if (a.index !== b.index) {
      add("순서", id);
      orderParents.add(a.parent);
    }
  }
  for (const id of after.keys()) if (!before.has(id)) add("추가", id);
  return { counts, examples, orderParents, size: before.size };
}
export function restoreDifferences(expected, actual) {
  const { counts, examples, size } = compareRestoreTrees(expected, actual);
  return Object.keys(counts).length
    ? `차이: ${Object.entries(counts)
        .map(([k, v]) => `${k} ${v}개`)
        .join(", ")}. ${examples.join("; ")}`
    : `차이 없음: ${size}개 항목 일치. 복원이 끝난 상태라면 동기화 재개로 최종 검사를 다시 실행할 수 있습니다.`;
}
