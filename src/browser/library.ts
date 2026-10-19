import type { ResumeInfo } from "../../shared/types";

export interface SavedDocument { info: ResumeInfo; bytes: ArrayBuffer }
let connection: Promise<IDBDatabase> | undefined;
function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("resumator-device-library", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("resumes", { keyPath: "info.id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser storage could not be opened. Allow website storage or use a non-private browser window."));
    request.onblocked = () => reject(new Error("Close other Resumator tabs to update device storage, then reload."));
  });
  return connection;
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("resumes", mode);
    const request = action(tx.objectStore("resumes"));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(new Error("The resume could not be saved or read. Browser storage may be full or unavailable. Download a backup before clearing website data."));
    tx.onerror = () => reject(new Error("Device storage failed. Check available storage and browser permissions."));
  });
}
export async function listDocuments() {
  const records = await transaction("readonly", (store) => store.getAll() as IDBRequest<SavedDocument[]>);
  return records.map((record) => record.info).sort((a, b) =>
    (b.version ?? 0) - (a.version ?? 0) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}
export async function getDocument(id: string) {
  const record = await transaction("readonly", (store) => store.get(id) as IDBRequest<SavedDocument | undefined>);
  if (!record) throw new Error("This resume is no longer in this browser's library. Select another version or upload it again.");
  return record;
}
export async function saveDocument(record: SavedDocument) {
  const db = await database();
  return new Promise<ResumeInfo>((resolve, reject) => {
    const tx = db.transaction("resumes", "readwrite");
    const store = tx.objectStore("resumes");
    const all = store.getAll() as IDBRequest<SavedDocument[]>;
    all.onsuccess = () => {
      record.info.version = Math.max(0, ...all.result.map((item) => item.info.version ?? 0)) + 1;
      store.add(record);
    };
    tx.oncomplete = () => resolve(record.info);
    tx.onabort = () => reject(new Error("Could not save the resume on this device. Check storage capacity and permissions. The upload was not saved."));
    tx.onerror = () => reject(new Error("Could not save the resume on this device. The upload was not saved."));
  });
}
export async function deleteDocument(id: string) {
  await transaction("readwrite", (store) => store.delete(id));
}
