import { newDocument, parseDocument, type Workspace } from './model';

let database: Promise<IDBDatabase> | undefined;
function openDB(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('creative-infinite-canvas', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('boards');
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('请关闭其他画布标签页后重试')); };
  });
  return database;
}
async function read(key: string): Promise<any> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction('boards').objectStore('boards').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadWorkspace(key: string): Promise<Workspace> {
  const saved = await read(`${key}:workspace-v2`);
  if (saved) {
    if (!Array.isArray(saved.projects) || !saved.projects.length) throw new Error('本地画布目录无法读取');
    const projects = saved.projects.map(parseDocument);
    return { version: 2, projects, activeId: projects.some(p => p.id === saved.activeId) ? saved.activeId : projects[0].id,
      cloudRevision: Number.isSafeInteger(saved.cloudRevision) ? saved.cloudRevision : 0, cloudPending: saved.cloudPending !== false };
  }
  const legacy = await read(key);
  const project = legacy ? parseDocument(legacy) : newDocument('我的灵感画布');
  return { version: 2, activeId: project.id, projects: [project] };
}
let writes: Promise<unknown> = Promise.resolve();
export function saveWorkspace(key: string, workspace: Workspace): Promise<void> {
  // Serialize transactions so an older autosave can never overwrite a newer edit.
  const write = writes.catch(() => {}).then(async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('boards', 'readwrite');
      tx.objectStore('boards').put(workspace, `${key}:workspace-v2`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
  writes = write;
  return write;
}
