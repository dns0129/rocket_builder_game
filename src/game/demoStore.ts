import { decodeDemo, encodeDemo, type DemoData, type DemoMeta } from './demo';

/**
 * Demo 数据库：浏览器本地的 IndexedDB。
 * - demoMeta：列表用的摘要（很小，列出全部时只读这一张表）
 * - demoData：完整的关键帧与事件（定型数组直接结构化克隆存储）
 */
const DB_NAME = 'rocket-game';
const DB_VERSION = 1;
const META = 'demoMeta';
const DATA = 'demoData';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('浏览器不支持 IndexedDB，无法保存 demo'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'meta.id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地数据库'));
    req.onblocked = () => reject(new Error('本地数据库被其他标签页占用，请关闭其他标签页后重试'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('数据库写入失败'));
    tx.onabort = () => reject(tx.error ?? new Error('数据库写入被中止（可能是存储空间不足）'));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 保存（同 id 覆盖）。 */
export async function saveDemo(d: DemoData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).put(d.meta);
  tx.objectStore(DATA).put(d);
  await done(tx);
}

/** 我的 demo 列表（按时间倒序）。 */
export async function listDemos(): Promise<DemoMeta[]> {
  const db = await openDb();
  const tx = db.transaction(META, 'readonly');
  const all = await request(tx.objectStore(META).getAll() as IDBRequest<DemoMeta[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadDemo(id: string): Promise<DemoData | null> {
  const db = await openDb();
  const tx = db.transaction(DATA, 'readonly');
  const d = await request(tx.objectStore(DATA).get(id) as IDBRequest<DemoData | undefined>);
  return d ?? null;
}

export async function deleteDemo(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}

export async function renameDemo(id: string, name: string): Promise<void> {
  const d = await loadDemo(id);
  if (!d) return;
  d.meta.name = name;
  await saveDemo(d);
}

// ------------------------------------------------------------------ 内置演示

export interface BuiltinDemo {
  id: string;
  file: string;
  icon: string;
  title: string;
  desc: string;
}

/** 电脑驾驶预设火箭“登月者 L-1”的三次全航程飞行（由 scripts/generateDemos.ts 生成）。 */
export const BUILTIN_DEMOS: BuiltinDemo[] = [
  { id: 'moon', file: 'demos/moon.json', icon: '🌕', title: '登月往返', desc: '发射入轨 → 奔月 → 环月 → 月面着陆 → 起飞返回 → 再入溅落' },
  { id: 'mars', file: 'demos/mars.json', icon: '🔴', title: '飞向火星', desc: '在发射台等待窗口 → 入轨 → 行星际转移 → 中途修正 → 火星捕获 → 着陆火星' },
  { id: 'jupiter', file: 'demos/jupiter.json', icon: '🪐', title: '飞向木星', desc: '发射入轨 → 等待窗口 → 约 260 天的转移 → 中途修正 → 木星捕获，环绕木星' },
];

const builtinCache = new Map<string, Promise<DemoData>>();

export function loadBuiltinDemo(id: string): Promise<DemoData> {
  let p = builtinCache.get(id);
  if (!p) {
    const b = BUILTIN_DEMOS.find((x) => x.id === id);
    if (!b) return Promise.reject(new Error(`没有这个演示：${id}`));
    p = fetch(b.file)
      .then((r) => {
        if (!r.ok) throw new Error(`下载演示失败（${r.status}）`);
        return r.json();
      })
      .then((j) => decodeDemo(j));
    builtinCache.set(id, p);
    p.catch(() => builtinCache.delete(id));
  }
  return p;
}

// ------------------------------------------------------------------ 导入 / 导出

export function exportDemo(d: DemoData): void {
  const blob = new Blob([JSON.stringify(encodeDemo(d))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = d.meta.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'demo';
  a.download = `${safe}.rocketdemo.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** 读入导出的 demo 文件，换一个新 id 保存（避免覆盖已有的）。 */
export async function importDemo(file: File): Promise<DemoData> {
  const d = decodeDemo(JSON.parse(await file.text()));
  d.meta.id = `demo-import-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  d.meta.builtin = undefined;
  d.meta.createdAt = Date.now();
  await saveDemo(d);
  return d;
}
