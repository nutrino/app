// Reserved .invalid hostname: browser cookie storage only, never fetched.
// A stable website origin survives extension removal and changing extension IDs.
const URL = "https://settings.xbrowsersync.invalid/";
const NAME = "xbs_connection_v1";
export async function readConnectionCookie(browser) {
  if (!browser.cookies) throw Error("쿠키 권한을 사용할 수 없습니다.");
  const cookie = await browser.cookies.get({ url: URL, name: NAME });
  if (!cookie) return {};
  try {
    const data = JSON.parse(decodeURIComponent(cookie.value));
    if (
      typeof data.url === "string" &&
      typeof data.id === "string" &&
      data.url.length <= 2048 &&
      data.id.length <= 128
    )
      return { url: data.url, id: data.id };
  } catch {
    /* Ignore malformed cookies without importing other fields. */
  }
  return {};
}
export async function writeConnectionCookie(browser, { url, id }) {
  if (!browser.cookies) throw Error("쿠키 권한을 사용할 수 없습니다.");
  const value = encodeURIComponent(JSON.stringify({ url, id }));
  if (value.length > 3800)
    throw Error("연결 정보가 쿠키 저장 한도를 초과했습니다.");
  const saved = await browser.cookies.set({
    url: URL,
    name: NAME,
    value,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
  });
  if (!saved) throw Error("쿠키를 저장하지 못했습니다.");
}
