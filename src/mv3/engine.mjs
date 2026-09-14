import {
  Api,
  countTree,
  decrypt,
  deriveKey,
  encrypt,
  hash,
  serviceURL,
  validateTree,
} from "./protocol.mjs";
export class Engine {
  constructor(store, native, apiFactory = (config) => new Api(config)) {
    this.store = store;
    this.native = native;
    this.apiFactory = apiFactory;
    this.tail = Promise.resolve();
  }
  exclusive(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  async state() {
    return (await this.store.get("state")) || { enabled: false };
  }
  async status() {
    const s = await this.state();
    return {
      connected: !!s.config,
      enabled: s.enabled,
      url: s.config?.url,
      id: s.config?.id,
      error: s.error,
      lastUpdated: s.lastUpdated,
      phase: s.apply
        ? "복원 중"
        : s.conflict
          ? "충돌 확인 필요"
          : s.preview
            ? "서버 복원 승인 대기"
            : s.pending
              ? "서버 저장 확인 중"
              : s.enabled
                ? "동기화 사용 중"
                : "일시 정지",
      progress: s.apply
        ? { done: s.apply.cursor, total: s.apply.total }
        : undefined,
      count: s.count,
      conflict: !!s.conflict,
      preview: !!s.preview,
      applying: !!s.apply,
    };
  }
  async save(s, entries = {}) {
    await this.store.put({ ...entries, state: s });
  }
  connect({ url, id, password }) {
    return this.exclusive(async () => {
      const old = await this.state();
      if (old.apply)
        throw Error("진행 중인 복원이 끝난 후 계정을 바꿀 수 있습니다.");
      url = serviceURL(url);
      id = id.trim();
      if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id) || !password)
        throw Error("동기화 ID와 비밀번호를 확인하세요.");
      const config = { url, id, key: await deriveKey(password, id) };
      const api = this.apiFactory(config);
      const version = await api.request(api.path("/version"));
      if (!version || !/^1\.(5|6|7|8)(\.|$)/.test(version.version))
        throw Error(
          "이 버전은 xBrowserSync 1.5–1.8 암호화 형식만 지원합니다. 기존 서버 데이터는 변경하지 않았습니다.",
        );
      config.version = version.version;
      const remote = await api.read();
      const tree = await decrypt(remote.bookmarks, config.key);
      // Authentication and schema validation finish before replacing the active configuration.
      await this.save(
        {
          config,
          enabled: false,
          preview: true,
          lastUpdated: remote.lastUpdated,
          count: countTree(tree),
        },
        { preview: tree, remote: remote.bookmarks },
      );
      return this.status();
    });
  }
  async backup(tree) {
    const previous = await this.store.get("backup");
    await this.store.put({
      previousBackup: previous,
      backup: {
        format: "xbrowsersync-mv3-backup",
        created: new Date().toISOString(),
        bookmarks: tree,
      },
    });
  }
  startRestore() {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.preview || s.apply)
        throw Error("서버 데이터 미리보기가 필요합니다.");
      // Fetch once more: a stale preview must never overwrite a newer server revision.
      const remote = await this.apiFactory(s.config).read();
      const tree = await decrypt(remote.bookmarks, s.config.key);
      await this.beginApply(s, tree, remote.lastUpdated);
      return this.status();
    });
  }
  async beginApply(s, tree, lastUpdated, pauseAfter = false, expectedHash) {
    tree = validateTree(tree);
    const base = (await this.store.get("base")) || [];
    const mapping = (await this.store.get("mapping")) || {};
    const local = await this.native.snapshot(base, mapping);
    if (expectedHash && (await hash(local.tree)) !== expectedHash)
      throw Error(
        "서버를 읽는 동안 로컬 북마크가 변경되었습니다. 다음 검사에서 충돌을 확인합니다.",
      );
    const plan = await this.native.plan(tree);
    // Commit the original data and complete target before issuing any native deletion.
    await this.backup(local.tree);
    s.apply = {
      phase: "clear",
      clearCursor: 0,
      cursor: 0,
      total: plan.steps.length,
      epoch: crypto.randomUUID(),
      lastUpdated,
      pauseAfter,
    };
    s.preview = false;
    s.conflict = false;
    s.error = undefined;
    s.enabled = true;
    s.pending = false;
    await this.save(s, {
      target: tree,
      plan,
      created: {},
      pendingUpload: undefined,
    });
  }
  async continueApply(s, budget = 12000) {
    const plan = await this.store.get("plan");
    const created = (await this.store.get("created")) || {};
    const rootMap = plan.rootMap;
    const start = Date.now();
    if (s.apply.intent) {
      // Recover a create acknowledged by the browser but not yet checkpointed in IndexedDB.
      const { spec, id } = s.apply.intent;
      const siblings = await this.native.bookmarks.getChildren(spec.parentId);
      const candidate = siblings[spec.index];
      if (
        this.native.matches(candidate, spec) &&
        !Object.values(created).includes(candidate.id)
      )
        created[id] = candidate.id;
      else if (candidate)
        throw Error(
          "복원 도중 북마크가 외부에서 변경되었습니다. 자동 재시도를 멈췄습니다. 백업을 내려받은 후 확인하세요.",
        );
      if (created[id]) {
        s.apply.cursor++;
        delete s.apply.intent;
        await this.save(s, { created });
      }
    }
    while (
      s.apply.phase === "clear" &&
      s.apply.clearCursor < plan.clear.length
    ) {
      const id = plan.clear[s.apply.clearCursor];
      let exists = true;
      try {
        await this.native.bookmarks.get(id);
      } catch {
        exists = false;
      }
      if (exists) await this.native.bookmarks.removeTree(id);
      s.apply.clearCursor++;
      await this.save(s);
      if (Date.now() - start >= budget) return;
    }
    if (s.apply.phase === "clear") {
      s.apply.phase = "create";
      await this.save(s);
    }
    while (s.apply.cursor < plan.steps.length) {
      const step = plan.steps[s.apply.cursor];
      const parent = rootMap[step.parent] || created[step.parent];
      if (!parent) throw Error("복원 부모 폴더를 찾을 수 없습니다.");
      const spec = this.native.createSpec(step, parent);
      s.apply.intent = { spec, id: step.node.id };
      await this.save(s);
      const node = await this.native.bookmarks.create(spec);
      created[step.node.id] = node.id;
      s.apply.cursor++;
      delete s.apply.intent;
      // Each record is small. A consolidated mapping is written only when the chunk completes.
      await this.store.put({
        [`created:${s.apply.epoch}:${step.node.id}`]: node.id,
        state: s,
      });
      if (Date.now() - start >= budget) {
        await this.store.put({ created });
        return;
      }
    }
    const tree = await this.store.get("target");
    const mapping = Object.fromEntries(
      Object.entries({ ...rootMap, ...created }).map(([sync, native]) => [
        native,
        Number(sync),
      ]),
    );
    const local = await this.native.snapshot(tree, mapping);
    if ((await hash(local.tree)) !== (await hash(tree)))
      throw Error(
        "복원 결과가 대상 데이터와 다릅니다. 외부 편집 또는 지원하지 않는 URL을 확인하세요. 자동 동기화를 중단했습니다.",
      );
    const epoch = s.apply.epoch;
    s.baseHash = s.apply.pauseAfter ? s.baseHash : await hash(local.tree);
    s.lastUpdated = s.apply.lastUpdated;
    s.enabled = !s.apply.pauseAfter;
    s.count = countTree(local.tree);
    s.apply = undefined;
    s.error = undefined;
    s.checkedAt = new Date().toISOString();
    await this.save(s, {
      base: local.tree,
      mapping: local.mapping,
      created: undefined,
      plan: undefined,
      target: undefined,
      preview: undefined,
    });
    await this.store.deletePrefix?.(`created:${epoch}:`);
  }
  async hydrateCreated(s) {
    if (!s.apply || !this.store.entries) return;
    const entries = await this.store.entries(`created:${s.apply.epoch}:`);
    const created = (await this.store.get("created")) || {};
    for (const [key, value] of entries) created[key.split(":").at(-1)] = value;
    await this.store.put({ created });
  }
  tick() {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.enabled || !s.config || s.conflict || s.preview) return;
      try {
        if (s.apply) {
          await this.hydrateCreated(s);
          await this.continueApply(s);
          return;
        }
        const api = this.apiFactory(s.config);
        const base = (await this.store.get("base")) || [];
        const local = await this.native.snapshot(
          base,
          (await this.store.get("mapping")) || {},
        );
        const localHash = await hash(local.tree);
        const updated =
          !s.pending && api.updated ? await api.updated() : undefined;
        const remote =
          updated === s.lastUpdated
            ? { lastUpdated: updated }
            : await api.read();
        if (s.pending) {
          const pending = await this.store.get("pendingUpload");
          if (remote.bookmarks === pending.cipher) {
            s.lastUpdated = remote.lastUpdated;
            s.baseHash = pending.hash;
            s.pending = false;
            s.count = countTree(pending.tree);
            s.error = undefined;
            await this.save(s, {
              base: pending.tree,
              mapping: pending.mapping,
              pendingUpload: undefined,
            });
            return;
          }
          if (remote.lastUpdated === pending.lastUpdated) {
            const lastUpdated = await api.write(
              pending.cipher,
              pending.lastUpdated,
            );
            s.lastUpdated = lastUpdated;
            s.baseHash = pending.hash;
            s.pending = false;
            s.error = undefined;
            s.count = countTree(pending.tree);
            await this.save(s, {
              base: pending.tree,
              mapping: pending.mapping,
              pendingUpload: undefined,
            });
            return;
          }
        }
        const remoteChanged = remote.lastUpdated !== s.lastUpdated;
        const localChanged = localHash !== s.baseHash;
        if (remoteChanged && (localChanged || s.pending)) {
          const tree = await decrypt(remote.bookmarks, s.config.key);
          s.conflict = true;
          s.error =
            "이 기기와 서버가 모두 변경되었습니다. 두 사본을 확인한 후 적용할 쪽을 선택하세요.";
          await this.save(s, {
            conflictLocal: local.tree,
            conflictRemote: tree,
          });
          return;
        }
        if (remoteChanged) {
          const tree = await decrypt(remote.bookmarks, s.config.key);
          await this.beginApply(s, tree, remote.lastUpdated, false, localHash);
          return;
        }
        if (localChanged) {
          const cipher = await encrypt(local.tree, s.config.key);
          const pending = {
            cipher,
            lastUpdated: s.lastUpdated,
            tree: local.tree,
            mapping: local.mapping,
            hash: localHash,
          };
          s.pending = true;
          await this.save(s, { pendingUpload: pending });
          const lastUpdated = await api.write(cipher, s.lastUpdated);
          s.lastUpdated = lastUpdated;
          s.baseHash = localHash;
          s.pending = false;
          s.count = countTree(local.tree);
          await this.save(s, {
            base: local.tree,
            mapping: local.mapping,
            pendingUpload: undefined,
          });
        }
        s.error = undefined;
        s.checkedAt = new Date().toISOString();
        await this.save(s);
      } catch (error) {
        // Do not persist a mutated in-memory checkpoint after a failed transaction.
        const durable = await this.state();
        durable.error = error.message;
        // A native restore error requires explicit resume; network failures retry on the periodic alarm.
        if (durable.apply) durable.enabled = false;
        await this.save(durable);
      }
    });
  }
  resolve(choice) {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.conflict) throw Error("충돌 상태가 아닙니다.");
      const api = this.apiFactory(s.config);
      const remote = await api.read();
      const remoteTree = await decrypt(remote.bookmarks, s.config.key);
      const local = await this.native.snapshot(
        (await this.store.get("base")) || [],
        (await this.store.get("mapping")) || {},
      );
      // Both sides remain downloadable after resolution.
      await this.store.put({
        conflictLocal: local.tree,
        conflictRemote: remoteTree,
      });
      if (choice === "server")
        await this.beginApply(s, remoteTree, remote.lastUpdated);
      else if (choice === "local") {
        const cipher = await encrypt(local.tree, s.config.key);
        s.conflict = false;
        s.pending = true;
        s.enabled = true;
        s.error = undefined;
        await this.save(s, {
          pendingUpload: {
            cipher,
            lastUpdated: remote.lastUpdated,
            tree: local.tree,
            mapping: local.mapping,
            hash: await hash(local.tree),
          },
        });
      } else throw Error("잘못된 충돌 해결 선택입니다.");
      return this.status();
    });
  }
  pause(enabled) {
    return this.exclusive(async () => {
      const s = await this.state();
      s.enabled = enabled;
      await this.save(s);
      return this.status();
    });
  }
  disconnect() {
    return this.exclusive(async () => {
      const s = await this.state();
      if (s.apply)
        throw Error(
          "복원이 끝날 때까지 연결을 해제할 수 없습니다. 일시 정지는 가능합니다.",
        );
      await this.save(
        { enabled: false },
        { pendingUpload: undefined, preview: undefined, remote: undefined },
      );
      return this.status();
    });
  }
  async export(kind) {
    if (kind === "current") {
      const s = await this.native.snapshot(
        (await this.store.get("base")) || [],
        (await this.store.get("mapping")) || {},
      );
      return { format: "xbrowsersync-mv3-backup", bookmarks: s.tree };
    }
    if (
      !["backup", "previousBackup", "conflictLocal", "conflictRemote"].includes(
        kind,
      )
    )
      throw Error("알 수 없는 백업 종류입니다.");
    const data = await this.store.get(kind);
    if (!data) throw Error("저장된 백업이 없습니다.");
    return Array.isArray(data)
      ? { format: "xbrowsersync-mv3-backup", bookmarks: data }
      : data;
  }
  rollback() {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.apply) throw Error("중단할 복원이 없습니다.");
      const backup = await this.store.get("backup");
      if (!backup?.bookmarks) throw Error("교체 전 백업을 찾을 수 없습니다.");
      await this.beginApply(s, backup.bookmarks, s.lastUpdated, true);
      return this.status();
    });
  }
  restoreBackup(data) {
    return this.exclusive(async () => {
      const s = await this.state();
      if (s.apply) throw Error("복원이 이미 진행 중입니다.");
      if (!s.config) throw Error("서버 연결 후 백업을 복원할 수 있습니다.");
      const tree = validateTree(data.bookmarks);
      await this.beginApply(s, tree, s.lastUpdated, true);
      return this.status();
    });
  }
}
