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
    /** 弹出目录选择框，只选不改 */
    pickDataDir: () => call('app:pickDataDir'),
    /** 把选中的目录写进启动配置（不搬数据） */
    setDataDir: (dir: string) => call('app:setDataDir', dir),
    /** 回到默认数据目录 */
    resetDataDir: () => call('app:resetDataDir'),
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
    /**
     * 一次删多条，**在一个事务里做完**。
     * 已经不存在的 uuid 跳过（计入 missing）而不报错 ——
     * 界面上的清单可能是几秒前拉的，期间别处可能已经删过那一条。
     */
    deleteMany: (wsId: string | null, uuids: string[]) => call('item:deleteMany', wsId, uuids),
    /**
     * 展开区：位置 / 规格 / 备注 + 这件东西自己的补充字段。
     *
     * 保存时值为空串表示删除该字段；位置/规格/备注会写回各自的真实列，
     * 其余进 extra_json —— 这个划分由主进程处理，界面不用关心。
     */
    extra: (wsId: string | null, uuid: string) => call('item:extra', wsId, uuid),
    extraSave: (wsId: string | null, uuid: string, patch: Record<string, string>) =>
      call('item:extraSave', wsId, uuid, patch),
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
  /** 表格列配置 */
  column: {
    get: (wsId?: string | null) => call('column:get', wsId ?? null),
    set: (wsId: string | null, visible: string[]) => call('column:set', wsId, visible),
  },
  /** 订阅「跨天了」事件 —— 剩余时间是算出来的，过了零点要重画 */
  onDateChanged: (fn: () => void): (() => void) => {
    const listener = (): void => fn();
    ipcRenderer.on('date:changed', listener);
    return () => ipcRenderer.removeListener('date:changed', listener);
  },
  /** 时间轴 */
  timeline: {
    data: (wsId: string | null) => call('timeline:data', wsId),
  },
  io: {
    /** 传一个 id 或一组 id：多个时导出成多工作区包 */
    exportWs: (wsIds: string | string[]) => call('io:export', wsIds),
    previewImport: () => call('io:previewImport'),
    /** 单工作区与多工作区包都走这里，自动识别 */
    import: (archivePath: string, name?: string) => call('io:import', archivePath, name ?? null),
    openPath: (p: string) => call('io:openPath', p),
    revealPath: (p: string) => call('io:revealPath', p),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type DshApi = typeof api;
