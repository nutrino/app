import test from "node:test";
import assert from "node:assert/strict";
import { describeBuild, sameBuild } from "../../src/mv3/build-info.mjs";
import {
  ConnectionForm,
  needsSetupTab,
} from "../../src/mv3/connection-form.mjs";

function fixture(persisted = {}, transient = {}) {
  const area = (data) => ({
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
  });
  const storage = { local: area(persisted), session: area(transient) };
  const granted = new Set();
  let allow = true;
  let requests = 0;
  const browser = {
    storage,
    permissions: {
      async contains({ origins }) {
        return origins.every((origin) => granted.has(origin));
      },
      request({ origins }) {
        requests++;
        if (allow) origins.forEach((origin) => granted.add(origin));
        return Promise.resolve(allow);
      },
    },
  };
  function form() {
    const field = (value = "") => ({ value, addEventListener() {} });
    const fields = {
      url: field("https://unrelated.example"),
      id: field(),
      password: field(),
      permission: {},
      credentials: {},
    };
    return new ConnectionForm(browser, fields, () => {});
  }
  return {
    browser,
    form,
    granted,
    setAllow: (value) => {
      allow = value;
    },
    requests: () => requests,
  };
}

test("build labels distinguish stale runtime, uncommitted code and missing Git metadata", () => {
  const info = {
    commit: "1234567890abcdef",
    sourceHash: "a".repeat(64),
    committedAt: "2026-09-15T00:00:00Z",
    builtAt: "2026-09-15T01:00:00Z",
    platform: "firefox",
    dirty: true,
  };
  assert.match(describeBuild(info), /KST/);
  assert.match(describeBuild(info), /커밋되지 않은 변경/);
  assert.match(describeBuild(null), /빌드 정보 없음/);
  assert.equal(sameBuild(info, { ...info }), true);
  assert.equal(sameBuild(info, { ...info, sourceHash: "b".repeat(64) }), false);
  assert.equal(sameBuild(info, { ...info, builtAt: "older" }), false);
  assert.equal(sameBuild(info, null), false);
  assert.match(
    describeBuild({ ...info, committedAt: null, dirty: null }),
    /확인 불가/,
  );
});

test("first setup requests only the selected server before credentials and connects once", async () => {
  const f = fixture();
  const form = f.form();
  await form.load();
  assert.equal(
    form.fields.url.value,
    "",
    "browser autofill must not seed our saved server",
  );
  assert.equal(form.fields.credentials.disabled, true);
  form.fields.url.value = "https://sync.example/api";
  const granting = form.grant();
  assert.equal(
    f.requests(),
    1,
    "permission request must run before yielding the user gesture",
  );
  await granting;
  assert.equal(form.fields.credentials.hidden, false);
  assert.deepEqual([...f.granted], ["https://sync.example/*"]);
  form.fields.id.value = "test-account-123456";
  form.fields.password.value = "fake-test-secret";
  let connections = 0;
  await form.connect(async (data) => {
    connections++;
    assert.equal(data.password, "fake-test-secret");
  });
  assert.equal(connections, 1);
  assert.equal(f.requests(), 1, "connect must not prompt again");
});

test("draft survives closing setup and browser restart clears only the password", async () => {
  const f = fixture();
  const form = f.form();
  await form.load();
  form.fields.url.value = "http://sync.example:8686";
  form.fields.id.value = "test-account-123456";
  form.fields.password.value = "fake-test-secret";
  await form.save();
  const reopened = f.form();
  await reopened.load();
  assert.deepEqual(reopened.values(), form.values());
  assert.equal(
    JSON.stringify(f.browser.storage.local.data).includes("fake-test-secret"),
    false,
  );
  const restarted = fixture(f.browser.storage.local.data).form();
  await restarted.load();
  assert.equal(restarted.fields.url.value, form.fields.url.value);
  assert.equal(restarted.fields.id.value, form.fields.id.value);
  assert.equal(restarted.fields.password.value, "");
});

test("permission denial, revocation and connection failure retain all input", async () => {
  const f = fixture();
  const form = f.form();
  await form.load();
  form.fields.url.value = "https://sync.example";
  form.fields.id.value = "test-account-123456";
  form.fields.password.value = "fake-test-secret";
  const original = form.values();
  f.setAllow(false);
  await assert.rejects(form.grant(), /접근 권한/);
  assert.deepEqual(form.values(), original);
  f.setAllow(true);
  await form.grant();
  await assert.rejects(
    form.connect(async () => {
      throw Error("offline");
    }),
    /offline/,
  );
  assert.deepEqual(form.values(), original);
  f.granted.clear();
  await assert.rejects(
    form.connect(() => assert.fail("must not connect without permission")),
    /먼저 허용/,
  );
  assert.equal(form.fields.credentials.disabled, true);
  const reopened = f.form();
  await reopened.load();
  assert.deepEqual(reopened.values(), original);
});

test("rapid edits persist the last value and stale permission checks cannot reveal credentials", async () => {
  const f = fixture();
  const form = f.form();
  await form.load();
  form.fields.url.value = "https://old.example";
  const first = form.save();
  form.fields.url.value = "https://new.example";
  await form.save();
  await first;
  assert.equal(
    f.browser.storage.local.data.connectionDraft.url,
    "https://new.example",
  );
  let release;
  f.browser.permissions.contains = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const check = form.checkPermission();
  form.fields.url.value = "";
  await form.checkPermission();
  release(true);
  await check;
  assert.equal(form.fields.credentials.disabled, true);
});

test("existing connection supplies correct address and only unconnected popups open setup tabs", async () => {
  const f = fixture({
    connectionDraft: { url: "https://outdated.example", id: "old" },
  });
  const form = f.form();
  await form.load({ url: "https://current.example", id: "current-account" });
  assert.equal(form.fields.url.value, "https://current.example");
  assert.equal(form.fields.id.value, "current-account");
  assert.equal(
    f.browser.storage.local.data.connectionDraft.url,
    "https://current.example",
  );
  assert.equal(needsSetupTab(false, "?popup=1"), true);
  assert.equal(needsSetupTab(true, "?popup=1"), false);
  assert.equal(needsSetupTab(false, ""), false);
});
