export const BUILD_INFO =
  typeof __XBS_BUILD_INFO__ === "undefined" ? null : __XBS_BUILD_INFO__;

export function describeBuild(info) {
  if (!info)
    return "빌드 정보 없음 — 기존 실행부일 수 있습니다. 확장을 다시 로드하세요.";
  const date = info.committedAt
    ? new Date(info.committedAt).toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul",
        hour12: false,
      }) + " KST"
    : "확인 불가";
  return (
    `소스 최종 커밋: ${info.commit.slice(0, 12)} · 수정 시각: ${date}` +
    `\n소스 지문: ${info.sourceHash.slice(0, 12)}${info.dirty ? " · 커밋되지 않은 변경 포함" : info.dirty === null ? " · Git 상태 확인 불가" : ""}` +
    `\n빌드 시각: ${info.builtAt}`
  );
}
export function sameBuild(a, b) {
  return (
    !!a &&
    !!b &&
    a.commit === b.commit &&
    a.sourceHash === b.sourceHash &&
    a.builtAt === b.builtAt &&
    a.platform === b.platform
  );
}
