/**
 * Preload：渲染进程与主进程之间唯一的通道。
 *
 * 安全要点：
 *   - 只暴露**具名方法**，不暴露 ipcRenderer 本体（否则渲染层可调任意通道）
 *   - 通道名在这里写死，渲染层无法构造新通道
 *   - contextIsolation 打开，渲染层拿不到 Node 与 require
 */
import { contextBridge, ipcRenderer } from 'electron';

type Invoke = (...args: unknown[]) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return (ipcRenderer.invoke(channel, ...args) as ReturnType<Invoke>).then((res) => {
    if (!res.ok) {
      const err = res.error as { message?: string; name?: string; notFound?: boolean } | undefined;
      const e = new Error(err?.message ?? '未知错误');
      e.name = err?.name ?? 'Error';
      (e as Error & { notFound?: boolean }).notFound = Boolean(err?.notFound);
      throw e;
    }
    return res.data;
  });
}

const api = {
  app: {
    info: () => call('app:info'),
    schema: () => call('app:schema'),
    manifest: () => call('app:manifest'),
  },
  ws: {
    list: () => call('ws:list'),
    create: (name: string, seed: boolean) => call('ws:create', name, seed),
    use: (id: string) => call('ws:use', id),
    rename: (id: string, name: string) => call('ws:rename', id, name),
    update: (id: string, patch: { name?: string; notes?: string }) => call('ws:update', id, patch),
    remove: (id: string) => call('ws:remove', id),
    seed: (id: string) => call('ws:seed', id),
    stats: (id?: string) => call('ws:stats', id ?? null),
    verify: (id?: string) => call('ws:verify', id ?? null),
  },
  item: {
    list: (wsId: string | null, filter?: Record<string, unknown>) => call('item:list', wsId, filter ?? null),
    get: (wsId: string | null, uuid: string) => call('item:get', wsId, uuid),
    save: (wsId: string | null, input: Record<string, unknown>) => call('item:save', wsId, input),
    consume: (wsId: string | null, uuid: string, qty: number, reason?: string) =>
      call('item:consume', wsId, uuid, qty, reason ?? 'consume'),
    /** 一键清理「非批量且剩余为 0」的记录；dryRun 只取清单 */
    purgeSpent: (wsId: string | null, dryRun?: boolean) => call('item:purgeSpent', wsId, dryRun === true),
    delete: (wsId: string | null, uuid: string) => call('item:delete', wsId, uuid),
  },
  /** 批量物品的「一组库存」 */
  stock: {
    add: (wsId: string | null, itemUuid: string, input: Record<string, unknown>) =>
      call('stock:add', wsId, itemUuid, input),
    update: (wsId: string | null, stockUuid: string, input: Record<string, unknown>) =>
      call('stock:update', wsId, stockUuid, input),
    remove: (wsId: string | null, stockUuid: string) => call('stock:remove', wsId, stockUuid),
  },
  alert: {
    summary: (wsId?: string | null) => call('alert:summary', wsId ?? null),
    multi: () => call('alert:multi'),
  },
  /** 按分类分组、组内按到期时间排序 */
  group: {
    list: (wsId: string | null, opts?: Record<string, unknown>) => call('group:list', wsId, opts ?? null),
    prefs: (wsId: string | null, patch: Record<string, unknown>) => call('group:prefs', wsId, patch),
  },
  /** 拖动固定顺序 */
  reorder: {
    items: (wsId: string | null, uuids: string[]) => call('item:reorder', wsId, uuids),
  },
  /** 时间轴 */
  timeline: {
    data: (wsId: string | null, opts?: Record<string, unknown>) => call('timeline:data', wsId, opts ?? null),
  },
  io: {
    exportWs: (wsId?: string | null) => call('io:export', wsId ?? null),
    previewImport: () => call('io:previewImport'),
    import: (archivePath: string, name?: string) => call('io:import', archivePath, name ?? null),
    openPath: (p: string) => call('io:openPath', p),
    revealPath: (p: string) => call('io:revealPath', p),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type DshApi = typeof api;
