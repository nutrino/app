import LZUTF8 from "lzutf8";
export const ROOTS = ["[xbs] Toolbar", "[xbs] Menu", "[xbs] Other"];
export const SEPARATOR = "xbs:separator";
export const MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
export function serviceURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("서버 주소는 인증 정보·쿼리가 없는 HTTP(S) 주소여야 합니다.");
  return url.href.replace(/\/+$/, "");
}
export function hostPermission(value) {
  const url = new URL(serviceURL(value));
  return `${url.protocol}//${url.hostname}/*`;
}
export function validateTree(tree) {
  if (!Array.isArray(tree)) throw Error("북마크 데이터가 배열이 아닙니다.");
  let count = 0;
  const ids = new Set();
  function walk(nodes, depth) {
    if (depth > 150) throw Error("폴더 깊이가 안전 한도를 초과했습니다.");
    return nodes.map((node) => {
      if (
        ++count > 250000 ||
        !node ||
        typeof node !== "object" ||
        !Number.isSafeInteger(node.id) ||
        node.id < 0 ||
        ids.has(node.id)
      )
        throw Error("북마크 ID가 중복되거나 데이터가 손상되었습니다.");
      ids.add(node.id);
      const out = { id: node.id };
      for (const key of ["title", "url", "description"]) {
        if (node[key] !== undefined) {
          if (typeof node[key] !== "string" || node[key].length > 1048576)
            throw Error("북마크 텍스트가 올바르지 않습니다.");
          out[key] = node[key];
        }
      }
      if (node.tags !== undefined) {
        if (
          !Array.isArray(node.tags) ||
          node.tags.some((t) => typeof t !== "string")
        )
          throw Error("태그가 올바르지 않습니다.");
        out.tags = [...node.tags];
      }
      if (node.children !== undefined) {
        if (!Array.isArray(node.children) || node.url !== undefined)
          throw Error("폴더 데이터가 올바르지 않습니다.");
        out.children = walk(node.children, depth + 1);
      } else if (!node.url) out.children = [];
      if (out.url === SEPARATOR) delete out.title;
      else out.title ??= "";
      return out;
    });
  }
  const clean = walk(tree, 0);
  if (
    clean.some((n) => !ROOTS.includes(n.title) || !n.children) ||
    new Set(clean.map((n) => n.title)).size !== clean.length
  )
    throw Error("지원하지 않는 북마크 루트 구조입니다.");
  let next = Math.max(-1, ...clean.map((n) => n.id)) + 1;
  for (const title of ROOTS)
    if (!clean.some((n) => n.title === title)) {
      while (ids.has(next)) next++;
      clean.push({ id: next++, title, children: [] });
    }
  return ROOTS.map((title) => clean.find((n) => n.title === title));
}
export function countTree(tree) {
  return tree.reduce(
    (n, b) => n + 1 + (b.children ? countTree(b.children) : 0),
    0,
  );
}
export function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export async function deriveKey(password, id) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return toBase64(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: encoder.encode(id),
          iterations: 250000,
          hash: "SHA-256",
        },
        material,
        256,
      ),
    ),
  );
}
async function importKey(raw) {
  return crypto.subtle.importKey("raw", fromBase64(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(tree, raw) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importKey(raw),
      LZUTF8.compress(JSON.stringify(tree)),
    ),
  );
  const bytes = new Uint8Array(iv.length + cipher.length);
  bytes.set(iv);
  bytes.set(cipher, 16);
  return toBase64(bytes);
}
export async function decrypt(text, raw) {
  if (typeof text !== "string" || text.length > MAX_BYTES)
    throw Error("서버 데이터 크기가 안전 한도를 초과했습니다.");
  try {
    const bytes = fromBase64(text);
    const compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 16) },
        await importKey(raw),
        bytes.subarray(16),
      ),
    );
    const decompressor = new LZUTF8.Decompressor();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const pieces = [];
    let expanded = 0;
    for (let offset = 0; offset < compressed.length; offset += 4096) {
      const part = decompressor.decompressBlock(
        compressed.subarray(offset, offset + 4096),
      );
      expanded += part.length;
      if (expanded > MAX_BYTES) throw Error("too large");
      pieces.push(decoder.decode(part, { stream: true }));
    }
    pieces.push(decoder.decode());
    const json = pieces.join("");
    return validateTree(JSON.parse(json));
  } catch {
    throw Error(
      "복호화 실패: 비밀번호 또는 서버 데이터가 올바르지 않습니다. 로컬 북마크는 변경하지 않았습니다.",
    );
  }
}
export async function hash(value) {
  return toBase64(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(value)),
      ),
    ),
  );
}
export class Api {
  constructor(config, fetcher = globalThis.fetch.bind(globalThis)) {
    this.config = config;
    this.fetcher = fetcher;
  }
  async request(path, body) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30000);
    try {
      const response = await this.fetcher(
        `${serviceURL(this.config.url)}${path}`,
        {
          method: body === undefined ? "GET" : "PUT",
          headers: {
            "Accept-Version": "1.1.9",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: abort.signal,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        },
      );
      if (!response.ok) {
        const error = Error(
          {
            401: "동기화 ID를 찾을 수 없습니다.",
            409: "서버가 다른 기기에서 변경되었습니다.",
            413: "서버 저장 용량을 초과했습니다.",
            429: "요청이 너무 많습니다. 잠시 후 재시도합니다.",
          }[response.status] || `서버 요청 실패 (${response.status})`,
        );
        error.status = response.status;
        throw error;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw Error("서버 응답 크기가 너무 큽니다.");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (abort.signal.aborted)
        throw Error(
          "서버 응답 시간이 초과되었습니다. 다음 동기화에서 재시도합니다.",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  path(suffix = "") {
    return `/bookmarks/${encodeURIComponent(this.config.id)}${suffix}`;
  }
  async updated() {
    const result = await this.request(this.path("/lastUpdated"));
    if (
      typeof result.lastUpdated !== "string" ||
      !Number.isFinite(Date.parse(result.lastUpdated))
    )
      throw Error("서버 수정 시각이 올바르지 않습니다.");
    return result.lastUpdated;
  }
  async read() {
    const result = await this.request(this.path());
    if (
      !result ||
      typeof result.bookmarks !== "string" ||
      typeof result.lastUpdated !== "string" ||
      !Number.isFinite(Date.parse(result.lastUpdated))
    )
      throw Error("서버 응답 형식이 올바르지 않습니다.");
    return result;
  }
  async write(bookmarks, lastUpdated) {
    const result = await this.request(this.path(), { bookmarks, lastUpdated });
    if (
      typeof result.lastUpdated !== "string" ||
      !Number.isFinite(Date.parse(result.lastUpdated))
    )
      throw Error("서버 저장 결과를 확인하지 못했습니다. 재확인합니다.");
    return result.lastUpdated;
  }
}
