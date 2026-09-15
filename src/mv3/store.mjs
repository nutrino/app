// IndexedDB commits each checkpoint atomically; bookmark payloads are separate from small state.
export class Store {
  constructor(name = "xbrowsersync-mv3-v1") {
    this.ready = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("data");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async get(key) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const request = db.transaction("data").objectStore("data").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async entries(prefix) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      // Two bulk requests in one snapshot instead of one IPC roundtrip per row.
      const tx = db.transaction("data");
      const store = tx.objectStore("data");
      const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
      const keys = store.getAllKeys(range);
      const values = store.getAll(range);
      tx.oncomplete = () =>
        resolve(keys.result.map((key, i) => [key, values.result[i]]));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || Error("저장소 읽기가 중단됐습니다."));
    });
  }
  async deletePrefix(prefix) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").delete(
        IDBKeyRange.bound(prefix, prefix + "\uffff"),
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async put(entries) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("data", "readwrite");
      const store = transaction.objectStore("data");
      try {
        for (const [key, value] of Object.entries(entries))
          value === undefined ? store.delete(key) : store.put(value, key);
      } catch (error) {
        transaction.abort();
        reject(error);
        return;
      }
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
}
