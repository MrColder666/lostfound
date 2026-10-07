// public/js/idb.js —— stores: drafts(登记草稿+photo Blob), queue(待补发 POST)
const DB = 'lf', VER = 1;
export function open() { return new Promise((res, rej) => {
  const r = indexedDB.open(DB, VER);
  r.onupgradeneeded = () => { const d = r.result;
    if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts');
    if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });}
export async function put(store, key, val) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite');
    // 接线修正：keyPath+autoIncrement 的 store（queue）必须单参 put，key===undefined 时省略第二参
    if (key === undefined) t.objectStore(store).put(val); else t.objectStore(store).put(val, key);
    t.oncomplete = res; t.onerror = () => rej(t.error); });}
export async function all(store) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readonly');
    const q = t.objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });}
export async function del(store, key) { const d = await open();
  return new Promise((res, rej) => { const t = d.transaction(store, 'readwrite');
    t.objectStore(store).delete(key); t.oncomplete = res; t.onerror = () => rej(t.error); });}
