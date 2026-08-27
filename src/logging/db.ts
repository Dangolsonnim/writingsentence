/** IndexedDB 래퍼 — 연구 로그 저장 + 업로드 재시도 큐 (수업 중 네트워크 불요) */

const DB_NAME = 'dictweb1';
const DB_VERSION = 1;

export interface StoreSpec {
  name: string;
  keyPath: string;
  indexes?: Array<{ name: string; keyPath: string }>;
}

const STORES: StoreSpec[] = [
  { name: 'participants', keyPath: 'participant_id' },
  { name: 'sessions', keyPath: 'session_id', indexes: [{ name: 'participant_id', keyPath: 'participant_id' }] },
  { name: 'attempts', keyPath: 'note_attempt_id', indexes: [{ name: 'session_id', keyPath: 'session_id' }] },
  { name: 'events', keyPath: 'event_id', indexes: [{ name: 'session_id', keyPath: 'session_id' }] },
  { name: 'assets', keyPath: 'file_asset_id', indexes: [{ name: 'session_id', keyPath: 'session_id' }] },
  { name: 'uploads', keyPath: 'upload_id', indexes: [{ name: 'status', keyPath: 'status' }] },
  { name: 'settings', keyPath: 'key' },
];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const spec of STORES) {
          if (!db.objectStoreNames.contains(spec.name)) {
            const store = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
            for (const idx of spec.indexes ?? []) store.createIndex(idx.name, idx.keyPath);
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return requestToPromise(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return requestToPromise(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllByIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return requestToPromise(
    db.transaction(store).objectStore(store).index(index).getAll(key)
  ) as Promise<T[]>;
}

export async function del(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
