import {
  compareRestoreTrees,
  restoreDifferences,
} from "./restore-differences.mjs";
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
import { mergeInitial, serverPage } from "./server-library.mjs";
import { localFolders, bookmarkBlock } from "./folder-picker.mjs";
const MODES = ["download", "upload", "both"];
const readTree = (remote, key) =>
  remote.bookmarks === "" ? validateTree([]) : decrypt(remote.bookmarks, key);
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
        ? s.apply.phase === "clear"
          ? "기존 북마크 정리 중"
          : s.apply.phase === "order"
            ? "복원 순서 조정 중"
            : "복원 중"
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
        ? s.apply.phase === "clear"
          ? {
              done: (s.apply.clearedBefore || 0) + s.apply.clearCursor,
              total: s.apply.clearTotal || 1,
            }
          : s.apply.phase === "order"
            ? { done: s.apply.orderCursor || 0, total: s.apply.orderTotal || 1 }
            : { done: s.apply.cursor, total: s.apply.total }
        : undefined,
      count: s.count,
      conflict: !!s.conflict,
      preview: !!s.preview,
      initialUpload: !!s.initialUpload,
      mode:
        s.mode ||
        (s.preview ? (s.initialUpload ? "upload" : "download") : "both"),
      pending: !!s.pending,
      applying: !!s.apply,
      restoreState: s.apply
        ? {
            phase: s.apply.phase,
            cursor: s.apply.cursor,
            total: s.apply.total,
            passes: s.apply.orderPasses || 0,
            moves: s.apply.orderMoves || 0,
          }
        : undefined,
    };
  }
  async save(s, entries = {}) {
    await this.store.put({ ...entries, state: s });
  }
  connect({ url, id, password }) {
    return this.exclusive(async () => {
      const old = await this.state();
      if (old.apply || old.pending)
        throw Error(
          "진행 중인 복원 또는 서버 저장 확인이 끝난 후 계정을 바꿀 수 있습니다.",
        );
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
      const tree =
        remote.bookmarks === ""
          ? validateTree([])
          : await decrypt(remote.bookmarks, config.key);
      // Authentication and schema validation finish before replacing the active configuration.
      await this.save(
        {
          config,
          enabled: false,
          preview: true,
          initialUpload: tree.every((root) => !root.children.length),
          mode: tree.every((root) => !root.children.length)
            ? "upload"
            : "download",
          lastUpdated: remote.lastUpdated,
          count: countTree(tree),
        },
        { preview: tree, remote: remote.bookmarks, serverView: undefined },
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
      const tree =
        remote.bookmarks === ""
          ? validateTree([])
          : await decrypt(remote.bookmarks, s.config.key);
      const empty = tree.every((root) => !root.children.length);
      if (empty !== !!s.initialUpload) {
        s.initialUpload = empty;
        s.count = countTree(tree);
        s.lastUpdated = remote.lastUpdated;
        await this.save(s, { preview: tree, remote: remote.bookmarks });
        throw Error(
          "서버 내용이 변경되어 최초 동기화 방향을 다시 확인해야 합니다. 화면을 확인하고 다시 실행하세요.",
        );
      }
      if (s.mode === "upload" || (!s.mode && empty)) {
        const local = await this.native.snapshot(
          (await this.store.get("base")) || [],
          (await this.store.get("mapping")) || {},
        );
        const cipher = await encrypt(local.tree, s.config.key);
        await this.backup(local.tree);
        await this.backupServer(tree);
        s.preview = false;
        s.initialUpload = false;
        s.enabled = true;
        s.pending = true;
        s.error = undefined;
        s.lastUpdated = remote.lastUpdated;
        await this.save(s, {
          pendingUpload: {
            cipher,
            lastUpdated: remote.lastUpdated,
            tree: local.tree,
            mapping: local.mapping,
            hash: await hash(local.tree),
          },
          preview: undefined,
        });
      } else if (s.mode === "both") {
        const local = await this.native.snapshot(
          (await this.store.get("base")) || [],
          (await this.store.get("mapping")) || {},
        );
        const merged = mergeInitial(tree, local.tree, (node) =>
          this.native.initialKey(node),
        );
        await this.backupServer(tree);
        await this.beginApply(
          s,
          merged,
          remote.lastUpdated,
          false,
          await hash(local.tree),
          true,
          (await hash(merged)) !== (await hash(tree)),
        );
      } else
        await this.beginApply(
          s,
          tree,
          remote.lastUpdated,
          false,
          undefined,
          true,
        );
      return this.status();
    });
  }
  async beginApply(
    s,
    tree,
    lastUpdated,
    pauseAfter = false,
    expectedHash,
    incremental = false,
    uploadAfter = false,
  ) {
    tree = validateTree(tree);
    const base = (await this.store.get("base")) || [];
    const mapping = (await this.store.get("mapping")) || {};
    const local = await this.native.snapshot(base, mapping);
    if (expectedHash && (await hash(local.tree)) !== expectedHash)
      throw Error(
        "서버를 읽는 동안 로컬 북마크가 변경되었습니다. 다음 검사에서 충돌을 확인합니다.",
      );
    const plan = await this.native.plan(tree, incremental);
    // Commit the original data and complete target before issuing any native deletion.
    await this.backup(local.tree);
    s.apply = {
      phase: "clear",
      clearCursor: 0,
      clearTotal: plan.clear.length,
      cursor: 0,
      total: plan.steps.length,
      epoch: crypto.randomUUID(),
      lastUpdated,
      pauseAfter,
      uploadAfter,
    };
    s.preview = false;
    s.initialUpload = false;
    s.conflict = false;
    s.error = undefined;
    s.enabled = true;
    s.pending = false;
    await this.save(s, {
      target: tree,
      plan,
      orderPlan: undefined,
      created: plan.reused || {},
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
    // Upgrade an interrupted older restore without touching its original backup.
    // Only the not-yet-acknowledged deletions are reordered; IDs remain unchanged.
    if (s.apply.phase === "clear" && !plan.clearFromEnd) {
      s.apply.clearTotal = plan.clear.length;
      s.apply.clearedBefore = s.apply.clearCursor;
      plan.clear = plan.clear.slice(s.apply.clearCursor).reverse();
      plan.clearFromEnd = true;
      s.apply.clearCursor = 0;
      await this.save(s, { plan });
    }
    while (
      s.apply.phase === "clear" &&
      s.apply.clearCursor < plan.clear.length
    ) {
      // Deletions are idempotent. Persist only after every member settles;
      // interrupted batches safely retry already-missing IDs on the next wake.
      const batch = plan.clear.slice(
        s.apply.clearCursor,
        s.apply.clearCursor + 8,
      );
      const results = await Promise.allSettled(
        batch.map(async (id) => {
          let exists = true;
          try {
            await this.native.bookmarks.get(id);
          } catch {
            exists = false;
          }
          if (exists) await this.native.bookmarks.removeTree(id);
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      s.apply.clearCursor += batch.length;
      await this.save(s);
      if (Date.now() - start >= budget) return;
    }
    if (s.apply.phase === "clear") {
      s.apply.phase = "create";
      await this.save(s);
    }
    while (s.apply.cursor < plan.steps.length) {
      const step = plan.steps[s.apply.cursor];
      if (plan.reused?.[step.node.id]) {
        if (plan.updates[step.node.id])
          await this.native.bookmarks.update(
            plan.reused[step.node.id],
            plan.updates[step.node.id],
          );
        s.apply.cursor++;
        if (plan.updates[step.node.id] || Date.now() - start >= budget) {
          await this.save(s);
          if (Date.now() - start >= budget) return;
        }
        continue;
      }
      const parent = rootMap[step.parent] || created[step.parent];
      if (!parent) throw Error("복원 부모 폴더를 찾을 수 없습니다.");
      const spec = this.native.createSpec(step, parent);
      if (plan.incremental) spec.index = step.appendIndex;
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
    if ((await hash(local.tree)) !== (await hash(tree))) {
      const diff = compareRestoreTrees(tree, local.tree);
      if (Object.keys(diff.counts).length === 1 && diff.counts["순서"]) {
        // Resume older failed restores from their existing target/mapping. Only order
        // may differ; missing nodes, edits and parent changes must still stop here.
        let orderPlan = await this.store.get("orderPlan");
        if (!s.apply.ordering) {
          if ((s.apply.orderPasses || 0) >= 2)
            throw Error(
              "순서를 조정한 뒤에도 다시 변경됐습니다. " +
                restoreDifferences(tree, local.tree) +
                " 자동 동기화를 중단했습니다.",
            );
          orderPlan = this.native.orderPlan(plan, created, diff.orderParents);
          if (!orderPlan.length)
            throw Error("복구할 북마크 순서 기록을 찾을 수 없습니다.");
          s.apply.orderPasses = (s.apply.orderPasses || 0) + 1;
          s.apply.ordering = true;
          s.apply.phase = "order";
          s.apply.orderCursor = 0;
          s.apply.orderTotal = orderPlan.length;
          await this.save(s, { orderPlan });
        }
        while (s.apply.orderCursor < orderPlan.length) {
          const complete = await this.native.reorderGroup(
            orderPlan[s.apply.orderCursor],
            async () => {
              s.apply.orderMoves = (s.apply.orderMoves || 0) + 1;
              if (s.apply.orderMoves > plan.steps.length * 2)
                throw Error("순서 변경이 반복되어 복구를 중단했습니다.");
              await this.save(s);
            },
            () => Date.now() - start >= budget,
          );
          if (!complete) return;
          s.apply.orderCursor++;
          await this.save(s);
          if (Date.now() - start >= budget) return;
        }
        s.apply.ordering = false;
        await this.save(s, { orderPlan: undefined });
        // Fresh full snapshot/hash on the next tick, including after a restart.
        return;
      }
      throw Error(
        "복원 결과가 대상 데이터와 다릅니다. " +
          restoreDifferences(tree, local.tree) +
          " 자동 동기화를 중단했습니다.",
      );
    }
    const epoch = s.apply.epoch;
    const pendingUpload = s.apply.uploadAfter
      ? {
          cipher: await encrypt(local.tree, s.config.key),
          lastUpdated: s.apply.lastUpdated,
          tree: local.tree,
          mapping: local.mapping,
          hash: await hash(local.tree),
        }
      : undefined;
    s.pending = !!pendingUpload;
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
      orderPlan: undefined,
      preview: undefined,
      pendingUpload,
    });
    await this.store.deletePrefix?.(`created:${epoch}:`);
  }
  async diagnoseRestore(details = false) {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.apply) throw Error("진행 중인 복원이 없습니다.");
      const plan = await this.store.get("plan");
      const created = (await this.store.get("created")) || {};
      const entries = await this.store.entries(`created:${s.apply.epoch}:`);
      for (const [key, value] of entries)
        created[key.split(":").at(-1)] = value;
      const mapping = Object.fromEntries(
        Object.entries({ ...plan.rootMap, ...created }).map(
          ([sync, native]) => [native, Number(sync)],
        ),
      );
      const target = await this.store.get("target");
      const local = await this.native.snapshot(target, mapping);
      const summary = restoreDifferences(target, local.tree);
      if (!details) return summary;
      const flatten = (nodes, map = new Map()) => {
        for (const node of nodes) {
          map.set(node.id, node);
          if (node.children) flatten(node.children, map);
        }
        return map;
      };
      const expected = flatten(target),
        actual = flatten(local.tree);
      const nativeIds = new Map(
        Object.entries(mapping).map(([native, sync]) => [sync, native]),
      );
      const differences = [];
      for (const [id, node] of expected) {
        const found = actual.get(id);
        if (found && node.url !== found.url) {
          differences.push({
            syncId: id,
            nativeId: nativeIds.get(id),
            expectedURL: node.url ?? null,
            actualURL: found.url ?? null,
          });
          if (differences.length === 20) break;
        }
      }
      return (
        summary +
        "\n\nURL 차이 상세 (최대 20개):\n" +
        JSON.stringify(differences, null, 2)
      );
    });
  }
  async hydrateCreated(s) {
    if (!s.apply || !this.store.entries) return;
    const entries = await this.store.entries(`created:${s.apply.epoch}:`);
    const created = (await this.store.get("created")) || {};
    for (const [key, value] of entries) created[key.split(":").at(-1)] = value;
    await this.store.put({ created });
  }
  async backupServer(tree) {
    await this.store.put({
      previousServerBackup: await this.store.get("serverBackup"),
      serverBackup: tree,
    });
  }
  listLocalFolders() {
    return this.exclusive(async () =>
      localFolders(await this.native.bookmarks.getTree()),
    );
  }
  addBookmark({ parentId, url, title } = {}) {
    return this.exclusive(async () => {
      const blocked = bookmarkBlock(await this.state());
      if (blocked) throw Error(blocked);
      if (
        typeof parentId !== "string" ||
        typeof url !== "string" ||
        typeof title !== "string"
      )
        throw Error("저장할 페이지 또는 폴더가 올바르지 않습니다.");
      const parsed = new URL(url);
      if (
        [
          "javascript:",
          "data:",
          "moz-extension:",
          "chrome-extension:",
        ].includes(parsed.protocol)
      )
        throw Error("이 페이지 주소는 빠른 북마크 추가를 지원하지 않습니다.");
      const folders = localFolders(await this.native.bookmarks.getTree());
      if (!folders.some((folder) => folder.id === parentId))
        throw Error(
          "저장할 폴더가 없거나 읽기 전용입니다. 폴더를 새로 읽어 주세요.",
        );
      const children = await this.native.bookmarks.getChildren(parentId);
      const existing = children.find((node) => node.url === url);
      if (existing) return { id: existing.id, existing: true };
      const node = await this.native.bookmarks.create({ parentId, title, url });
      return { id: node.id, existing: false };
    });
  }
  setMode(mode) {
    return this.exclusive(async () => {
      if (!MODES.includes(mode)) throw Error("알 수 없는 동기화 방식입니다.");
      const s = await this.state();
      if (!s.config) throw Error("서버에 먼저 연결하세요.");
      if (s.apply || s.pending)
        throw Error(
          "진행 중인 복원 또는 서버 저장 확인을 완료한 뒤 방식을 변경하세요.",
        );
      if (
        mode !==
        (s.mode ||
          (s.preview ? (s.initialUpload ? "upload" : "download") : "both"))
      ) {
        s.mode = mode;
        s.forceDirection = !s.preview && mode !== "both";
        if (mode !== "both") {
          s.conflict = false;
          s.error = undefined;
        }
        await this.save(s);
      } else if (!s.mode) {
        s.mode = mode;
        await this.save(s);
      }
      return this.status();
    });
  }
  listServer(options = {}) {
    return this.exclusive(async () => {
      const s = await this.state();
      if (!s.config) throw Error("서버에 먼저 연결하세요.");
      let cached = await this.store.get("serverView");
      if (options.refresh || !cached) {
        const remote = await this.apiFactory(s.config).read();
        cached = {
          tree: await readTree(remote, s.config.key),
          lastUpdated: remote.lastUpdated,
          fetchedAt: new Date().toISOString(),
        };
        await this.store.put({ serverView: cached });
      }
      return {
        ...serverPage(cached.tree, options),
        lastUpdated: cached.lastUpdated,
        fetchedAt: cached.fetchedAt,
      };
    });
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
        if (s.mode === "download" || s.mode === "upload") {
          if (remoteChanged || localChanged || s.forceDirection || s.pending) {
            const fullRemote =
              remote.bookmarks === undefined ? await api.read() : remote;
            const remoteTree = await readTree(fullRemote, s.config.key);
            if ((await hash(remoteTree)) === localHash) {
              s.baseHash = localHash;
              s.lastUpdated = fullRemote.lastUpdated;
              s.pending = false;
              s.forceDirection = false;
              s.error = undefined;
              s.count = countTree(local.tree);
              await this.save(s, {
                base: local.tree,
                mapping: local.mapping,
                pendingUpload: undefined,
              });
            } else if (s.mode === "download") {
              s.forceDirection = false;
              await this.beginApply(
                s,
                remoteTree,
                fullRemote.lastUpdated,
                false,
                localHash,
                true,
              );
            } else {
              await this.backupServer(remoteTree);
              s.forceDirection = false;
              s.pending = true;
              s.error = undefined;
              await this.save(s, {
                pendingUpload: {
                  cipher: await encrypt(local.tree, s.config.key),
                  lastUpdated: fullRemote.lastUpdated,
                  tree: local.tree,
                  mapping: local.mapping,
                  hash: localHash,
                },
              });
            }
          } else {
            s.error = undefined;
            s.checkedAt = new Date().toISOString();
            await this.save(s);
          }
          return;
        }
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
      if (
        (s.mode === "download" && choice !== "server") ||
        (s.mode === "upload" && choice !== "local")
      )
        throw Error(
          "선택한 동기화 방향과 다른 충돌 해결입니다. 먼저 방식을 변경하세요.",
        );
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
      if (enabled && !s.enabled) {
        s.error = undefined;
        if (s.apply) {
          s.apply.orderPasses = 0;
          s.apply.orderMoves = 0;
        }
      }
      s.enabled = enabled;
      await this.save(s);
      return this.status();
    });
  }
  disconnect() {
    return this.exclusive(async () => {
      const s = await this.state();
      if (s.apply || s.pending)
        throw Error(
          "복원 또는 서버 저장 확인이 끝날 때까지 연결을 해제할 수 없습니다. 일시 정지는 가능합니다.",
        );
      await this.save(
        { enabled: false },
        {
          pendingUpload: undefined,
          preview: undefined,
          remote: undefined,
          serverView: undefined,
        },
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
      ![
        "backup",
        "previousBackup",
        "conflictLocal",
        "conflictRemote",
        "serverBackup",
        "previousServerBackup",
      ].includes(kind)
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
