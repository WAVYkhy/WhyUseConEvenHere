const MAX_RECENT = 40;

const IDB_NAME = "koreanEmoticonsCache";
const IDB_VERSION = 1;
const IDB_STORE = "blobs";

interface CachedBlobRecord {
    key: string;
    blob: Blob;
    size: number;
    updatedAt: number;
    lastAccessedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openCacheDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE, { keyPath: "key" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            dbPromise = null;
            reject(req.error ?? new Error("Failed to open IndexedDB cache"));
        };
    });

    return dbPromise;
}

export async function getCachedBlob(key: string): Promise<Blob | null> {
    try {
        const db = await openCacheDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(key);
            req.onsuccess = () => {
                const record = req.result as CachedBlobRecord | undefined;
                if (!record?.blob) {
                    resolve(null);
                    return;
                }
                const updated: CachedBlobRecord = {
                    ...record,
                    lastAccessedAt: Date.now(),
                };
                store.put(updated);
                resolve(record.blob);
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return null;
    }
}

export async function putCachedBlob(key: string, blob: Blob): Promise<void> {
    try {
        const db = await openCacheDb();
        const now = Date.now();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            const store = tx.objectStore(IDB_STORE);
            const record: CachedBlobRecord = {
                key,
                blob,
                size: blob.size,
                updatedAt: now,
                lastAccessedAt: now,
            };
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch {
        // Cache writes are best-effort; never block sending on quota/IDB errors.
    }
}

export async function deleteCachedBlobsByPrefix(prefix: string): Promise<void> {
    try {
        const db = await openCacheDb();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            const store = tx.objectStore(IDB_STORE);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (typeof cursor.key === "string" && cursor.key.includes(prefix)) {
                    cursor.delete();
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        // Ignore cleanup errors.
    }
}

export async function clearBinaryCache(): Promise<void> {
    const db = await openCacheDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

export async function getCacheStats(): Promise<{ count: number; bytes: number }> {
    try {
        const db = await openCacheDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const store = tx.objectStore(IDB_STORE);
            const req = store.openCursor();
            let count = 0;
            let bytes = 0;
            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve({ count, bytes });
                    return;
                }
                const record = cursor.value as CachedBlobRecord | undefined;
                count += 1;
                bytes += record?.size ?? record?.blob?.size ?? 0;
                cursor.continue();
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return { count: 0, bytes: 0 };
    }
}

export function addRecentKey(current: string[], itemKey: string): string[] {
    return [itemKey, ...current.filter(k => k !== itemKey)].slice(0, MAX_RECENT);
}

export function toggleFavoriteKey(current: string[], itemKey: string): string[] {
    if (current.includes(itemKey)) {
        return current.filter(k => k !== itemKey);
    }
    return [itemKey, ...current];
}
