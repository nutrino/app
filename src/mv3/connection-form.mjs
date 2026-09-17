import { hostPermission } from "./protocol.mjs";

import {
  readConnectionCookie,
  writeConnectionCookie,
} from "./connection-cookie.mjs";

const DRAFT = "connectionDraft";
const SECRET = "connectionPassword";

// Keep setup in a tab: permission prompts may close an action popup.
export function needsSetupTab(connected, search) {
  return !connected && new URLSearchParams(search).has("popup");
}

export class ConnectionForm {
  constructor(browser, fields, notify) {
    this.browser = browser;
    this.fields = fields;
    this.notify = notify;
    this.pending = Promise.resolve();
    this.revision = 0;
  }
  values() {
    return {
      url: this.fields.url.value,
      id: this.fields.id.value,
      password: this.fields.password.value,
    };
  }
  async load(status = {}) {
    const [local, session] = await Promise.all([
      this.browser.storage.local.get(DRAFT),
      this.browser.storage.session.get(SECRET),
    ]);
    let cookie = {};
    try {
      cookie = await readConnectionCookie(this.browser);
    } catch {
      this.notify(
        "연결 정보 쿠키를 읽지 못했습니다. 확장 권한과 쿠키 설정을 확인하세요.",
        true,
      );
    }
    const draft = local[DRAFT] || cookie;
    // An existing connection is authoritative when upgrading older builds.
    this.fields.url.value = status.url ?? draft.url ?? "";
    this.fields.id.value = status.id ?? draft.id ?? "";
    this.fields.password.value = session[SECRET] || "";
    const { url, id } = this.values();
    if (
      (url || id) &&
      (local[DRAFT]?.url !== url ||
        local[DRAFT]?.id !== id ||
        cookie.url !== url ||
        cookie.id !== id)
    )
      await this.save();
    await this.checkPermission();
  }
  save() {
    const { url, id, password } = this.values();
    const write = () =>
      Promise.all([
        this.browser.storage.local.set({ [DRAFT]: { url, id } }),
        this.browser.storage.session.set({ [SECRET]: password }),
        writeConnectionCookie(this.browser, { url, id }).catch(() => {
          this.notify(
            "주소·ID는 이 확장에 저장했지만 쿠키 저장에 실패했습니다. 재설치 후 복원하려면 확장 권한과 쿠키 설정을 확인하세요.",
            true,
          );
        }),
      ]);
    // Serialize rapid edits so a slower previous write cannot win.
    this.pending = this.pending.then(write, write);
    return this.pending;
  }
  showPermission(granted) {
    this.fields.permission.hidden = granted;
    this.fields.credentials.hidden = !granted;
    this.fields.credentials.disabled = !granted;
  }
  async checkPermission() {
    const revision = ++this.revision;
    this.showPermission(false);
    let granted = false;
    try {
      granted = await this.browser.permissions.contains({
        origins: [hostPermission(this.fields.url.value)],
      });
    } catch {
      // Empty or unfinished URLs are expected while typing.
    }
    if (revision === this.revision) this.showPermission(granted);
    return granted;
  }
  grant() {
    // Call synchronously from the click handler, before any awaited storage write.
    let permission;
    const revision = ++this.revision;
    try {
      permission = this.browser.permissions.request({
        origins: [hostPermission(this.fields.url.value)],
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.all([permission, this.save()]).then(([granted]) => {
      if (revision === this.revision) this.showPermission(granted);
      if (!granted)
        throw Error("서버 접근 권한이 필요합니다. 입력 내용은 보관했습니다.");
    });
  }
  async connect(send) {
    const data = this.values();
    await this.save();
    if (
      !(await this.browser.permissions.contains({
        origins: [hostPermission(data.url)],
      }))
    ) {
      await this.checkPermission();
      throw Error(
        "서버 접근 권한을 먼저 허용해 주세요. 입력 내용은 보관했습니다.",
      );
    }
    // Preserve the password on failure and across popup closes, only in session storage.
    return send(data);
  }
  bind() {
    for (const field of [
      this.fields.url,
      this.fields.id,
      this.fields.password,
    ]) {
      const changed = () => {
        this.save().catch((error) => this.notify(error.message, true));
        if (field === this.fields.url)
          this.checkPermission().catch((error) =>
            this.notify(error.message, true),
          );
      };
      field.addEventListener("input", changed);
      field.addEventListener("change", changed);
    }
  }
}
