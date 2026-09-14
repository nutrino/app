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
      const result = [];
      const request = db
        .transaction("data")
        .objectStore("data")
        .openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(result);
          return;
        }
        result.push([cursor.key, cursor.value]);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async deletePrefix(prefix) {
    const db = await this.ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("data", "readwrite");
      const request = tx
        .objectStore("data")
        .openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
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
