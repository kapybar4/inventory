/**
 * Electron 主进程。
 *
 * 职责边界（重要）：
 *   - **这里不做任何领域逻辑**。所有业务都在 src/core/ 里，CLI 与桌面端共用。
 *   - core 里禁止 import electron —— 一旦破例，CLI 就无法在纯 Node 下运行了。
 *   - 渲染进程拿不到 Node，只能通过 preload 暴露的白名单通道访问数据。
 */
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { APP_NAME, APP_VERSION } from '../core/meta';
import { SCHEMA_VERSION } from '../core/schema';
import { ENUMS, CATEGORY_LEAD_DAYS, TABLES, exportedFields } from '../core/fields';
import {
  createWorkspace,
  listWorkspaces,
  readRegistry,
  writeRegistry,
  removeWorkspace,
  renameWorkspace,
  updateWorkspacePrefs,
  requireWorkspace,
  resolveWorkspace,
  setActiveWorkspace,
  workspaceDbPath,
  workspaceStats,
  WorkspaceNotFoundError,
  WorkspaceUnusableError,
  assertUsable,
  isUsable,
  workspaceStatus,
  quarantineWorkspace,
  unquarantineWorkspace,
  defaultDataDir,
} from '../core/workspace';
import {
  openDatabase,
  insertRow,
  updateRow,
  deleteRow,
  selectWhere,
  selectOne,
  transaction,
  TOP_LEVEL,
  applyItemOrder,
  nextItemCode,
  type Row,
} from '../core/db';
import { computeOverview, groupByCategory, expiriesForItem, leadDaysFor, lowStockItems } from '../core/alerts';
import {
  buildTree,
  uncategorizedCount,
  SORT_FIELDS,
  UNCATEGORIZED,
  type SortField,
} from '../core/ordering';
import {
  DEFAULT_COLUMNS,
  ITEM_COLUMNS,
  LOCKED_COLUMNS,
  isMinimal,
  resolveColumns,
} from '../core/columns';
import {
  addStock,
  removeStock,
  stocksOf,
  stockCounts,
  toBulkStocks,
  refreshParentTotals,
  consumeFromStocks,
  hasStocks,
} from '../core/bulk';
import { exportWorkspace, exportWorkspaces } from '../core/export';
import { importArchive, importAnything, previewArchive, detectMultiArchive } from '../core/import';
import { seedWorkspace } from '../core/seed';
import { buildManifest } from '../core/manifest';
import { formatDaysLeft, daysUntil, today } from '../core/dates';
import { centsToYuan, yuanToCents, parseExtra, serializeExtra } from '../core/values';
import { formatBytes } from '../core/util';

/**
 * 把 Chromium 的 profile 目录从**漫游** AppData 挪到**本地** AppData。
 *
 * Electron 默认用 `%APPDATA%`（Roaming）放 profile —— 但 profile 是缓存、
 * GPU 着色器、单实例锁这类东西，**本来就不该跟着漫游走**：漫游目录在企业域里
 * 会被同步、被组策略限制。本地 AppData 才是它该在的地方，
 * 而且 `%LOCALAPPDATA%` 已经是本项目放数据的地方（见 workspace.ts 的 defaultDataDir），
 * 两者放一起，"这个应用的东西在哪"只有一个答案。
 *
 * **必须在 app ready 之前调用**：userData 决定 Chromium 初始化时去哪读写。
 *
 * 命令行显式传了 `--user-data-dir` 就**不要覆盖** —— 那个参数的用途正是
 * 指定 profile 位置（自动化测试、隔离运行都靠它）。
 * 早先这里无条件覆盖，结果传进来的 `--user-data-dir` 被静默忽略，
 * 排查时看到报错路径还是默认目录，白绕了一圈。
 */
function useLocalUserData(): void {
  const explicit = process.argv.some(
    (a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='),
  );
  if (explicit) return;

  try {
    const local = process.env['LOCALAPPDATA'];
    if (!local || !local.trim()) return;
    app.setPath('userData', join(local.trim(), 'dsh-inventory'));
  } catch {
    /* 设不了就用默认值，不该因为这个起不来 */
  }
}

useLocalUserData();

/** 数据根目录：测试可用 DSH_INVENTORY_HOME 覆盖 */
function dataDir(): string {
  const env = process.env['DSH_INVENTORY_HOME'];
  if (env && env.trim()) return env.trim();
  return join(app.getPath('userData'), 'inventory');
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    // 标题栏只留应用名，不带版本号 —— 版本在「字段与格式」页和 --version 里看
    title: APP_NAME,
    /*
     * `backgroundColor` 对齐 `--bg`：首帧防白闪。
     *
     * 系统标题栏的颜色**不在这里设**，靠下面的 `themeSource = 'dark'`。
     * 这里试过 `titleBarOverlay`，那个配置只在自绘标题栏
     * （`titleBarStyle: 'hidden'`）时才生效；而本项目的顶栏没给窗口按钮
     * 留位置（导航右边界距窗口右边只有 16px），改成自绘会把按钮压在内容上。
     */
    backgroundColor: THEME_BG,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      // 安全基线：渲染进程不许碰 Node，只能走白名单 IPC
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  // 外链一律走系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 窗口重新获得焦点时查一次日期 —— 电脑睡了一夜再唤醒，setTimeout 可能被推迟，
  // 靠这一个检查兜住「跨天了但定时器还没响」的空档
  mainWindow.on('focus', () => checkDateRollover());
}

// ─────────────────────────────────────────────────────────────
// 跨天刷新
//
// 「剩余时间」是算出来的（到期日 − 今天），不是存下来的。所以它在页面上
// **会自己过期**：开着应用过一夜，昨天写的"剩 7 个月"今天就错了。
//
// 刷新时机（需求里点名了三个，这里都覆盖）：
//   1. **零点** —— 精确定时到下一个零点，响过之后再排下一次
//   2. **打开程序** —— 渲染层首屏本来就会重算，不需要额外做什么
//   3. **改了到期时间** —— 走既有的 reloadAll() 路径
//
// 另外加一道兜底：窗口获得焦点时比对日期。定时器在系统睡眠期间不保证准时，
// 只靠它会出现"醒了但没刷新"。
// ─────────────────────────────────────────────────────────────

/** 上次广播时的日期（YYYY-MM-DD），用来判断是不是真跨天了 */
let lastSeenDay = today();

/** 若有需要，广播一次「跨天了」 */
function checkDateRollover(): void {
  const now = today();
  if (now === lastSeenDay) return;
  lastSeenDay = now;
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('date:changed');
  }
}

/**
 * 排到下一个零点之后一秒再触发。
 *
 * 用「距离下个零点的毫秒数」而不是固定 24 小时轮询：
 * 后者会在夏令时切换、系统改时间之后越漂越远。
 * 每次响完重新算一次，永远贴着真实的零点。
 */
function scheduleMidnightTick(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  const delay = Math.max(1000, next.getTime() - now.getTime());

  const timer = setTimeout(() => {
    checkDateRollover();
    scheduleMidnightTick();
  }, delay);
  // 这个定时器不该拖住进程退出
  timer.unref?.();
}

// ─────────────────────────────────────────────────────────────
// IPC：返回统一的 { ok, data } / { ok:false, error } 信封
// ─────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (_event, ...args) => {
    try {
      return { ok: true, data: fn(...args) };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        error: {
          name: e.name || 'Error',
          message: e.message,
          notFound: e instanceof WorkspaceNotFoundError,
          // 界面靠这个标记区分"找不到"和"坏了" —— 后者要显示修复指引
          unusable: e instanceof WorkspaceUnusableError,
          status: e instanceof WorkspaceUnusableError ? e.status : undefined,
        },
      };
    }
  });
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`参数 ${name} 必须是非空字符串`);
  return v;
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error('参数必须是对象');
  return v as Record<string, unknown>;
}

/** 工作区来源的显示名：新建 / 示例 / 导入 */
function workspaceSourceLabel(key: string): string {
  return ENUMS['workspace_source']?.find((e) => e.key === key)?.label ?? key;
}

/** 出入库原因的显示名 */
function moveReasonLabel(key: string): string {
  return ENUMS['move_reason']?.find((e) => e.key === key)?.label ?? key;
}

/** 把渲染进程传回的「字符串模型」值限制在我们认识的列上 */
function pickKnownFields(table: string, input: Record<string, unknown>): Record<string, string | null> {
  const def = TABLES.find((t) => t.name === table);
  if (!def) throw new Error(`未知的表: ${table}`);
  const allowed = new Set(def.fields.filter((f) => !f.internal).map((f) => f.name));
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!allowed.has(k)) continue;
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false';
    else out[k] = String(v);
  }
  return out;
}

/**
 * 主题色。**必须与 `src/renderer/styles.css` 里的 `--bg` / `--fg` 保持一致。**
 *
 * 写在这里是因为主进程开窗口时就要用到（首帧底色、系统标题栏），
 * 那时候渲染层还没加载、拿不到 CSS 变量。改配色时两处一起改。
 */
const THEME_BG = '#000000';

/**
 * 把数据库裸行补成界面能直接渲染的物品对象。
 *
 * **一份实现，两个入口共用**（`item:list` 与 `group:list`）。
 * 早先两处各写了一遍，结果 `isLongTerm` 的判法就不一样：
 * 一处看 `expires_on` 是不是空，另一处看有没有任何到期来源 ——
 * 于是"只有质保期"的物品在一个接口里是长期、在另一个里不是。
 * 映射逻辑复制一份就会漂移，所以只留这一份。
 */
/**
 * 界面用的物品对象：数据库裸行 + 一批派生字段。
 *
 * 派生出来的 `expiry` 是对象数组、`remaining` 是数字，都不满足 `Row` 的
 * 「纯标量」约束，所以类型放宽成 Record —— 它只在 IPC 边界上流动。
 */
type DecoratedItem = Record<string, unknown>;

function decorateItem(r: Row, counts: Map<string, number>): DecoratedItem {
  const remaining = Number(r['remaining'] ?? 0);
  const minStock = Number(r['min_stock'] ?? 0);
  const expiresOn = r['expires_on'] ? String(r['expires_on']) : null;
  const left = expiresOn ? daysUntil(expiresOn) : null;
  const expiry = expiriesForItem(r);

  const warrantyUntil = r['warranty_until'] ? String(r['warranty_until']) : null;

  return {
    ...r,
    remaining,
    minStock,
    lowStock: minStock > 0 && remaining < minStock,
    expiresOn,
    warrantyUntil,
    daysLeft: left,
    daysLeftText: expiresOn ? formatDaysLeft(left) : '长期',
    /**
     * 「长期」= **完全没有到期来源**。
     *
     * 不能只看 `expires_on` 是不是空：只有质保期的物品（鼠标）确实有日期要记，
     * 它不是"不用盯"的长期物品。
     */
    isLongTerm: expiry.length === 0,
    leadDays: leadDaysFor(r),
    unitPriceYuan: centsToYuan(r['unit_price_cents'] as string | null),
    amountYuan: centsToYuan(r['amount_cents'] as string | null),
    stockCount: counts.get(String(r['uuid'])) ?? 0,
    expiry,
  };
}

/**
 * 开库并执行。**这里是异常工作区的唯一闸门。**
 *
 * 调用方要用一个不可用的工作区做读写，就会在这里被 `assertUsable` 挡下，
 * 抛 `WorkspaceUnusableError`，界面据此显示"这个工作区坏了"。
 *
 * `allowUnusable` 只给**导出**用：恢复路径是"导出备份 → 重建 → 删掉坏的"，
 * 把导出也堵上等于把人锁在门外，数据就拿不出来了。
 */
function withDb<T>(
  wsId: string | null,
  readOnly: boolean,
  fn: (db: ReturnType<typeof openDatabase>, entry: ReturnType<typeof requireWorkspace>) => T,
  opts: { allowUnusable?: boolean } = {},
): T {
  const dd = dataDir();
  const entry = resolveWorkspace(dd, wsId);
  if (!opts.allowUnusable) assertUsable(entry);
  const db = openDatabase(workspaceDbPath(dd, entry), readOnly ? { readOnly: true, skipMigrate: true } : {});
  try {
    return fn(db, entry);
  } finally {
    db.close();
  }
}

/**
 * 展开区的数据：把「真实字段」与「自定义字段」合成一个扁平对象。
 *
 * 界面拿到的是 `{ fields: [{key,label,value,real}], custom: {...} }`：
 *   - `fields` 是固定展示的三个真实字段（位置/规格/备注），带中文标签
 *   - `custom` 是这件东西自己加的字段，界面照原样列出来
 *
 * 合并放在这里而不是界面，是为了让"位置到底存在哪"这个实现细节不外泄 ——
 * 界面只管画，不管某个键是在列里还是在 JSON 里。
 */
function buildExtraPayload(row: Row): {
  uuid: string;
  name: string;
  fields: { key: string; label: string; value: string }[];
  custom: Record<string, string>;
  count: number;
} {
  const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

  // 位置是 room + container 两列拼出来的，展开区里当一栏用
  const location = [s(row['room']), s(row['container'])].filter(Boolean).join(' / ');

  const fields = [
    { key: 'location', label: '位置', value: location },
    { key: 'spec', label: '规格', value: s(row['spec']) },
    { key: 'notes', label: '备注', value: s(row['notes']) },
  ];

  const custom = parseExtra(s(row['extra_json']));

  return {
    uuid: s(row['uuid']),
    name: s(row['name']),
    fields,
    custom,
    count: fields.filter((f) => f.value !== '').length + Object.keys(custom).length,
  };
}

function registerHandlers(): void {
  // ── 元信息 / 静态数据 ──
  handle('app:info', () => ({
    name: APP_NAME,
    version: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    dataDir: dataDir(),
    isDefaultDataDir: dataDir() === defaultDataDir(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  handle('app:schema', () => ({
    tables: TABLES.map((t) => ({
      name: t.name,
      label: t.label,
      columns: exportedFields(t).map((f) => ({
        name: f.name,
        label: f.label,
        kind: f.kind,
        required: Boolean(f.required),
        description: f.description ?? null,
        enumName: f.enumName ?? null,
        default: f.default ?? null,
      })),
    })),
    enums: ENUMS,
    /** 排序字段清单：界面不自己维护一份，避免两处漂移 */
    sortFields: SORT_FIELDS,
    categoryLeadDays: CATEGORY_LEAD_DAYS,
  }));

  handle('app:manifest', () => {
    const dd = dataDir();
    let wsInfo = { id: 'preview', name: '预览', createdAt: new Date().toISOString(), source: 'none' };
    let rowCounts: Record<string, number> = {};
    try {
      const entry = resolveWorkspace(dd, null);
      wsInfo = { id: entry.id, name: entry.name, createdAt: entry.createdAt, source: entry.source };
      const stats = workspaceStats(dd, entry);
      rowCounts = stats.tableCounts;
    } catch {
      /* 没有工作区时给出空 manifest 预览 */
    }
    return buildManifest({ workspace: wsInfo, rowCounts, exportedAt: new Date().toISOString() });
  });

  // ── 工作区 ──
  handle('ws:list', () => {
    const dd = dataDir();
    const reg = readRegistry(dd);
    return {
      dataDir: dd,
      activeWorkspaceId: reg.activeWorkspaceId,
      workspaces: reg.workspaces
        .filter((w) => !w.archived)
        .map((w) => {
          const status = workspaceStatus(w);
          const usable = isUsable(w);
          let items: number | null = null;
          let moves: number | null = null;
          let purgeable = 0;
          let dbBytes: number | null = null;
          let integrityOk: boolean | null = null;
          try {
            const s = workspaceStats(dd, w);
            items = s.tableCounts['items'] ?? 0;
            moves = s.tableCounts['stock_moves'] ?? 0;
            dbBytes = s.dbBytes;
            integrityOk = s.integrityOk;
          } catch {
            /* 目录被手工删掉时不让整个列表崩掉 */
          }
          // 「可一键清理」= 非批量且剩余为 0 的记录数。
          // 异常工作区不去读它的库 —— 状态都不对了，数字也不可信
          if (usable) {
            try {
              const db = openDatabase(workspaceDbPath(dd, w), { readOnly: true });
              try {
                const row = db
                  .prepare('SELECT COUNT(*) AS n FROM items WHERE is_bulk = 0 AND remaining <= 0')
                  .get() as { n: number } | undefined;
                purgeable = Number(row?.n ?? 0);
              } finally {
                db.close();
              }
            } catch {
              purgeable = 0;
            }
          }
          return {
            id: w.id,
            name: w.name,
            createdAt: w.createdAt,
            // 来源统一给中文标签，界面直接用
            source: w.source,
            sourceLabel: workspaceSourceLabel(w.source),
            notes: w.notes ?? null,
            active: w.id === reg.activeWorkspaceId,
            items,
            moves,
            purgeable,
            dbBytes,
            integrityOk,
            /** 'ok' | 'importing' | 'quarantined'。界面据此禁止操作并显示修复指引 */
            status,
            usable,
            statusReason: w.statusReason ?? null,
            statusAt: w.statusAt ?? null,
          };
        }),
    };
  });

  // 手动隔离 / 解除隔离
  handle('ws:quarantine', (id, reason) =>
    quarantineWorkspace(dataDir(), asString(id, 'id'), String(reason ?? '用户手动标记')),
  );
  handle('ws:unquarantine', (id) => unquarantineWorkspace(dataDir(), asString(id, 'id')));

  handle('ws:create', (name, seed) => {
    const dd = dataDir();
    const created = createWorkspace(dd, {
      name: asString(name, 'name'),
      source: seed === true ? 'demo' : 'blank',
    });
    const seeded = seed === true ? seedWorkspace(dd, created.entry) : null;
    return { id: created.entry.id, name: created.entry.name, dbPath: created.dbPath, seeded };
  });

  handle('ws:update', (id, patch) => {
    const dd = dataDir();
    const entry = requireWorkspace(dd, asString(id, 'id'));
    const input = asObject(patch);
    let updated = entry;

    const name = input['name'];
    if (typeof name === 'string' && name.trim() && name.trim() !== entry.name) {
      updated = renameWorkspace(dd, entry.id, name.trim());
    }

    // 备注写进注册表，界面上可以给工作区加一句说明
    if ('notes' in input) {
      const notes = typeof input['notes'] === 'string' ? (input['notes'] as string) : '';
      const reg = readRegistry(dd);
      const target = reg.workspaces.find((w) => w.id === entry.id);
      if (target) {
        if (notes.trim()) target.notes = notes.trim();
        else delete target.notes;
        writeRegistry(dd, reg);
        updated = target;
      }
    }

    return {
      id: updated.id,
      name: updated.name,
      notes: updated.notes ?? '',
      source: updated.source,
      sourceLabel: workspaceSourceLabel(updated.source),
    };
  });

  handle('ws:use', (id) => {
    const dd = dataDir();
    const entry = requireWorkspace(dd, asString(id, 'id'));
    setActiveWorkspace(dd, entry.id);
    return { id: entry.id, name: entry.name };
  });

  handle('ws:rename', (id, name) => {
    const dd = dataDir();
    const entry = requireWorkspace(dd, asString(id, 'id'));
    const updated = renameWorkspace(dd, entry.id, asString(name, 'name'));
    return { id: updated.id, name: updated.name };
  });

  handle('ws:remove', (id) => {
    const dd = dataDir();
    const entry = requireWorkspace(dd, asString(id, 'id'));
    const result = removeWorkspace(dd, entry.id, { snapshot: true });
    return { id: entry.id, name: entry.name, snapshotPath: result.snapshotPath ?? null };
  });

  handle('ws:seed', (id) => {
    const dd = dataDir();
    const entry = requireWorkspace(dd, asString(id, 'id'));
    return seedWorkspace(dd, entry);
  });

  handle('ws:stats', (id) => {
    const dd = dataDir();
    const entry = id ? requireWorkspace(dd, asString(id, 'id')) : resolveWorkspace(dd, null);
    const stats = workspaceStats(dd, entry);
    return {
      id: stats.id,
      name: stats.name,
      createdAt: stats.createdAt,
      source: stats.source,
      dir: stats.dir,
      dbPath: stats.dbPath,
      dbBytes: stats.dbBytes,
      dbBytesText: formatBytes(stats.dbBytes),
      schemaVersion: stats.schemaVersion,
      integrityOk: stats.integrityOk,
      tableCounts: stats.tableCounts,
      verifyMessages: stats.verify.messages,
    };
  });

  handle('ws:verify', (id) => {
    const dd = dataDir();
    const entry = id ? requireWorkspace(dd, asString(id, 'id')) : resolveWorkspace(dd, null);
    return workspaceStats(dd, entry).verify;
  });

  // ── 物品（v2：一行 = 一件实际存在的东西，没有批次层）──
  handle('item:list', (wsId, filterRaw) => {
    const filter = filterRaw ? asObject(filterRaw) : {};
    return withDb(wsId ? asString(wsId, 'wsId') : null, true, (db) => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (typeof filter['category'] === 'string' && filter['category']) {
        where.push('category = ?');
        params.push(filter['category']);
      }
      if (typeof filter['room'] === 'string' && filter['room']) {
        where.push('room = ?');
        params.push(filter['room']);
      }
      if (typeof filter['status'] === 'string' && filter['status']) {
        where.push('status = ?');
        params.push(filter['status']);
      } else if (filter['all'] !== true) {
        where.push(`status IN ('in_stock','in_use')`);
      }
      if (typeof filter['search'] === 'string' && filter['search']) {
        where.push('(name LIKE ? OR brand LIKE ? OR model LIKE ? OR barcode = ?)');
        const q = `%${filter['search']}%`;
        params.push(q, q, q, String(filter['search']));
      }
      if (filter['lowStock'] === true) where.push('min_stock > 0 AND remaining < min_stock');
      if (filter['longTerm'] === true) where.push(`(expires_on IS NULL OR expires_on = '')`);
      if (filter['dated'] === true) where.push(`expires_on IS NOT NULL AND expires_on <> ''`);

      // 顶层物品：不含「一组库存」的子行
      where.push(TOP_LEVEL);

      const rows = selectWhere(db, 'items', where.join(' AND ') + ' ORDER BY sort_order ASC, rowid ASC', params);
      const counts = stockCounts(db);
      return rows.map((r) => decorateItem(r, counts));
    });
  });

  handle('item:get', (wsId, uuid) => {
    return withDb(wsId ? asString(wsId, 'wsId') : null, true, (db) => {
      const item = selectOne(db, 'items', 'uuid = ?', [asString(uuid, 'uuid')]);
      if (!item) throw new WorkspaceNotFoundError(`物品 ${String(uuid)}`);

      const remaining = Number(item['remaining'] ?? 0);
      const minStock = Number(item['min_stock'] ?? 0);

      const moves = db
        .prepare('SELECT * FROM stock_moves WHERE item_uuid = ? ORDER BY moved_on DESC, created_at DESC')
        .all(String(uuid)) as Record<string, unknown>[];

      // 「一组库存」
      const isBulk = item['is_bulk'] === 'true';
      const nested = isBulk ? stocksOf(db, String(uuid)) : [];
      const { stocks, totals } = toBulkStocks(nested);

      return {
        item,
        expiry: expiriesForItem(item),
        isLongTerm: expiriesForItem(item).length === 0,
        remaining,
        minStock,
        lowStock: minStock > 0 && remaining < minStock,
        isBulk,
        stocks,
        stockTotals: stocks.length > 0 ? totals : null,
        leadDays: leadDaysFor(item),
        unitPriceYuan: centsToYuan(item['unit_price_cents'] as string | null),
        amountYuan: centsToYuan(item['amount_cents'] as string | null),
        moves: moves.map((m) => ({
          uuid: String(m['uuid']),
          movedOn: String(m['moved_on']),
          qtyDelta: Number(m['qty_delta']),
          reason: String(m['reason']),
          reasonLabel: moveReasonLabel(String(m['reason'])),
          notes: m['notes'] === null ? null : String(m['notes']),
        })),
      };
    });
  });

  handle('item:save', (wsId, input) => {
    const raw = asObject(input);
    const values = pickKnownFields('items', raw);

    // 金额：界面传的是「元」，库里存「分」
    if (raw['unitPriceYuan'] !== undefined) {
      const cents = raw['unitPriceYuan'] === null || raw['unitPriceYuan'] === '' ? null : yuanToCents(String(raw['unitPriceYuan']));
      values['unit_price_cents'] = cents === null ? null : String(cents);
    }
    if (raw['amountYuan'] !== undefined) {
      const cents = raw['amountYuan'] === null || raw['amountYuan'] === '' ? null : yuanToCents(String(raw['amountYuan']));
      values['amount_cents'] = cents === null ? null : String(cents);
    } else if (values['unit_price_cents'] && values['quantity']) {
      values['amount_cents'] = String(Number(values['unit_price_cents']) * Number(values['quantity']));
    }

    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const uuid = values['uuid'];

      if (uuid) {
        const before = selectOne(db, 'items', 'uuid = ?', [uuid], { includeInternal: true });
        if (!before) throw new WorkspaceNotFoundError(`物品 ${uuid}`);

        // 数量改了但没给剩余 → 剩余跟着数量走（不超过原剩余）
        if (values['quantity'] !== undefined && values['remaining'] === undefined) {
          const q = Number(values['quantity']);
          const cur = Number(before['remaining'] ?? 0);
          if (cur > q) values['remaining'] = String(q);
        }
        const updated = updateRow(db, 'items', uuid, values);
        return { created: false, item: updated };
      }

      // 缺省值
      if (!values['quantity']) values['quantity'] = '1';
      values['remaining'] = values['remaining'] ?? values['quantity'];
      values['status'] = values['status'] ?? 'in_stock';
      if (!values['purchased_on']) values['purchased_on'] = today();

      // 内部标识按分类前缀自动生成（界面上不显示，只给命令行定位用）
      // 生成规则在 core 里只有一份实现
      if (!values['code']) {
        values['code'] = nextItemCode(db, String(values['category'] ?? 'other'));
      } else if (selectOne(db, 'items', 'code = ?', [values['code']])) {
        throw new Error(`内部标识已存在: ${values['code']}`);
      }

      let item: Record<string, unknown> | null = null;
      transaction(db, () => {
        item = insertRow(db, 'items', values) as unknown as Record<string, unknown>;
        insertRow(db, 'stock_moves', {
          item_uuid: String(item['uuid']),
          moved_on: values['purchased_on']!,
          qty_delta: values['quantity']!,
          reason: 'purchase',
          notes: values['store'] ? `购自 ${values['store']}` : null,
        });
      });
      return { created: true, item: item as unknown as Record<string, unknown> };
    });
  });

  // ── 「一组库存」：批量物品的嵌套条目 ──

  handle('stock:add', (wsId, itemUuid, input) => {
    const values = pickKnownFields('items', asObject(input));
    delete values['uuid'];
    delete values['code'];
    delete values['parent_uuid'];
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const parent = findItemByUuid(db, asString(itemUuid, 'itemUuid'));
      if (parent['is_bulk'] !== 'true') {
        throw new Error(`「${String(parent['name'])}」没有开启「批量」，不能配置一组库存`);
      }
      const row = addStock(db, parent, values);
      const { stocks, totals } = toBulkStocks(stocksOf(db, String(parent['uuid'])));
      return { created: true, stock: row, stocks, totals };
    });
  });

  handle('stock:update', (wsId, stockUuid, input) => {
    const values = pickKnownFields('items', asObject(input));
    delete values['uuid'];
    delete values['code'];
    delete values['parent_uuid'];
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const row = selectOne(db, 'items', 'uuid = ?', [asString(stockUuid, 'stockUuid')], { includeInternal: true });
      if (!row) throw new WorkspaceNotFoundError(`库存条目 ${String(stockUuid)}`);
      const parentUuid = row['parent_uuid'] ? String(row['parent_uuid']) : '';
      if (!parentUuid) throw new Error('这条记录不是库存条目');

      const updated = updateRow(db, 'items', String(stockUuid), values);
      refreshParentTotals(db, parentUuid);
      const { stocks, totals } = toBulkStocks(stocksOf(db, parentUuid));
      return { updated, stocks, totals };
    });
  });

  handle('stock:remove', (wsId, stockUuid) => {
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const row = selectOne(db, 'items', 'uuid = ?', [asString(stockUuid, 'stockUuid')], { includeInternal: true });
      if (!row) throw new WorkspaceNotFoundError(`库存条目 ${String(stockUuid)}`);
      const parentUuid = row['parent_uuid'] ? String(row['parent_uuid']) : '';
      const ok = removeStock(db, String(stockUuid));
      if (!ok) return { removed: false };
      const { stocks, totals } = parentUuid
        ? toBulkStocks(stocksOf(db, parentUuid))
        : { stocks: [], totals: { quantity: 0, remaining: 0, expiresOn: null } };
      return { removed: true, stocks, totals };
    });
  });

  handle('group:list', (wsId, opts) => {
    const o = opts ? asObject(opts) : {};
    return withDb(wsId ? asString(wsId, 'wsId') : null, true, (db) => {
      const entry = wsId ? requireWorkspace(dataDir(), asString(wsId, 'wsId')) : resolveWorkspace(dataDir(), null);
      const where = [`${TOP_LEVEL} AND status IN ('in_stock','in_use')`];
      const params: (string | number)[] = [];
      if (typeof o['category'] === 'string' && o['category']) {
        where.push('category = ?');
        params.push(o['category']);
      }
      const rows = selectWhere(db, 'items', where.join(' AND ') + ' ORDER BY sort_order ASC, rowid ASC', params);

      // 分组层级与排序字段：界面传优先，否则用工作区里存的偏好
      const levels = Number(o['levels'] ?? entry.groupLevels ?? 1);
      const sortField = String(o['sort'] ?? entry.sortField ?? 'manual') as SortField;

      /**
       * 把原始数据库行补成界面能直接渲染的物品对象。
       *
       * `selectWhere` 给的是**裸行**，没有 expiry / isLongTerm / stockCount 这些
       * 派生字段 —— 界面拿裸行去画会直接抛错（曾经就是这样崩的）。
       * 所以这里补齐，字段口径与 `item:list` 保持一致。
       */
      const counts = stockCounts(db);
      // 用与 item:list 同一份映射，别在这里再写一遍
      const decorate = (r: Row): DecoratedItem => decorateItem(r, counts);

      const tree = buildTree(rows, {
        levels,
        sort: sortField,
        order: entry.groupOrder ?? {},
        now: new Date(),
      });

      // 树里的 items 是裸行，递归补一遍
      const decorateNode = (n: (typeof tree.nodes)[number]): unknown => ({
        key: n.key,
        label: n.label,
        path: n.path,
        level: n.level,
        count: n.count,
        pinned: n.pinned,
        expired: n.expired,
        soon: n.soon,
        longTerm: n.longTerm,
        // 过保单列 —— 界面靠它区分「要处理的」和「只是不保修了」
        warranty: n.warranty,
        items: n.items.map(decorate),
        children: n.children.map(decorateNode),
      });

      return {
        levels: tree.maxLevel,
        requestedLevels: Math.max(1, Math.min(3, levels)),
        sortedBy: sortField,
        dragEnabled: sortField === 'manual',
        total: tree.total,
        uncategorized: uncategorizedCount(rows),
        groups: tree.nodes.map(decorateNode),
        collapsed: entry.collapsed ?? [],
        // 顺带把列配置带回去：界面首屏就能按用户的选择画表，不用再往返一次
        columns: resolveColumns(entry.columns),
      };
    });
  });

  /**
   * 列配置：读。
   *
   * 返回 `available` 让界面能画出勾选框（含 `lock` 标记），
   * `visible` 是解析后的结果 —— 锁定列一定在里面。
   */
  handle('column:get', (wsId) => {
    const entry = wsId ? requireWorkspace(dataDir(), asString(wsId, 'wsId')) : resolveWorkspace(dataDir(), null);
    return {
      available: ITEM_COLUMNS,
      locked: LOCKED_COLUMNS,
      visible: resolveColumns(entry.columns),
      defaults: DEFAULT_COLUMNS,
      minimal: isMinimal(entry.columns),
    };
  });

  /**
   * 列配置：写。
   *
   * 传进来的清单可以是任意内容（含空的），`resolveColumns` 会把
   * 「物品」「到期时间」补回来 —— **约束在数据层**，界面就算被绕过了也改不坏。
   */
  handle('column:set', (wsId, visible) => {
    if (!Array.isArray(visible)) throw new Error('column:set 需要一个数组');
    const entry = wsId ? requireWorkspace(dataDir(), asString(wsId, 'wsId')) : resolveWorkspace(dataDir(), null);
    const saved = updateWorkspacePrefs(dataDir(), entry.id, { columns: visible as string[] });
    return {
      visible: resolveColumns(saved.columns),
      minimal: isMinimal(saved.columns),
    };
  });

  /**
   * 展开区：一次性取某件物品的全部补充信息。
   *
   * 位置 / 规格 / 备注来自**真实字段**，自定义字段来自 `extra_json`。
   * 合成一个扁平对象返回，界面不用关心某个键到底存在哪 ——
   * 这个划分是存储的实现细节，不该漏到界面上。
   */
  handle('item:extra', (wsId, uuid) => {
    const u = asString(uuid, 'uuid');
    return withDb(wsId ? asString(wsId, 'wsId') : null, true, (db) => {
      const row = selectOne(db, 'items', 'uuid = ?', [u], { includeInternal: true });
      if (!row) throw new WorkspaceNotFoundError(`物品 ${u}`);
      return buildExtraPayload(row);
    });
  });

  /**
   * 展开区：保存。
   *
   * 传进来的 patch 里：
   *   - 属于真实字段的键（room/container/spec/notes）写回各自的列
   *   - 其余键进 `extra_json`，**值为空串表示删除该字段**
   *
   * 分成两拨写是刻意的：位置要参与分组、规格要参与搜索、备注要参与导出，
   * 全都塞进 JSON 会让这些功能全部失效。
   */
  handle('item:extraSave', (wsId, uuid, patch) => {
    const u = asString(uuid, 'uuid');
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('item:extraSave 需要一个对象');
    }
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const row = selectOne(db, 'items', 'uuid = ?', [u], { includeInternal: true });
      if (!row) throw new WorkspaceNotFoundError(`物品 ${u}`);

      const incoming = patch as Record<string, unknown>;
      const values: Record<string, string | null> = {};
      const custom: Record<string, string> = {};

      for (const [k, raw] of Object.entries(incoming)) {
        const text = raw === null || raw === undefined ? '' : String(raw);
        if (k === 'room' || k === 'container' || k === 'spec' || k === 'notes') {
          values[k] = text;
        } else if (k === 'name' || k === 'category' || k === 'extra_json') {
          // 这几个不接受从这个入口改：名称/分类有自己的表单，
          // extra_json 由下面的 custom 计算，直接放行会绕过校验
          continue;
        } else {
          custom[k] = text;
        }
      }

      // 自定义字段：空值 = 删除。整份覆盖而不是逐个合并，
      // 因为界面每次传的是"这一行现在全部的自定义字段"。
      values['extra_json'] = serializeExtra(
        Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== '')),
      );

      const updated = updateRow(db, 'items', u, values);
      return buildExtraPayload(updated ?? row);
    });
  });

  /**
   * 拖动固定物品顺序。
   *
   * 界面把「这一组里物品的新顺序」整份传上来，这里按顺序重写 sort_order。
   * 传整份而不是「谁移到谁前面」是刻意的：整份重写是幂等的，
   * 拖动的中间态、重复请求都不会把顺序搞乱。
   */
  handle('item:reorder', (wsId, uuids) => {
    if (!Array.isArray(uuids)) throw new Error('item:reorder 需要一个 uuid 数组');
    const list = uuids.map((u) => asString(u, 'uuid'));
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const n = applyItemOrder(db, list);
      return { reordered: n };
    });
  });

  /** 拖动固定分组顺序 / 改展开层级 / 改排序字段 / 收起展开 */
  handle('group:prefs', (wsId, patch) => {
    const dd = dataDir();
    const entry = wsId ? requireWorkspace(dd, asString(wsId, 'wsId')) : resolveWorkspace(dd, null);
    const input = patch ? asObject(patch) : {};
    const next: Parameters<typeof updateWorkspacePrefs>[2] = {};

    // 组顺序：路径 → 有序 key 列表
    if (input['order'] !== undefined && typeof input['order'] === 'object' && input['order'] !== null) {
      const order: Record<string, string[]> = { ...(entry.groupOrder ?? {}) };
      for (const [path, keys] of Object.entries(input['order'] as Record<string, unknown>)) {
        if (!Array.isArray(keys)) continue;
        // 未分类永远置顶：无论界面传什么，都把它从可排序列表里剔掉
        order[path] = keys.map((k) => String(k)).filter((k) => k !== UNCATEGORIZED);
      }
      next.groupOrder = order;
    }
    if (input['levels'] !== undefined) next.groupLevels = Number(input['levels']);
    if (input['sort'] !== undefined) next.sortField = String(input['sort']);
    if (Array.isArray(input['collapsed'])) next.collapsed = input['collapsed'].map((c) => String(c));

    const updated = updateWorkspacePrefs(dd, entry.id, next);
    return {
      id: updated.id,
      groupOrder: updated.groupOrder ?? {},
      groupLevels: updated.groupLevels ?? 1,
      sortField: updated.sortField ?? 'manual',
      collapsed: updated.collapsed ?? [],
    };
  });

  handle('timeline:data', (wsId, opts) => {
    const o = opts ? asObject(opts) : {};
    const granularity = typeof o['granularity'] === 'string' ? o['granularity'] : 'month';
    return withDb(wsId ? asString(wsId, 'wsId') : null, true, (db) => {
      const rows = selectWhere(db, 'items', `${TOP_LEVEL} AND status IN ('in_stock','in_use')`, []);
      const now = new Date();
      const slots = buildSlots(now, granularity, Number(o['past'] ?? 6), Number(o['future'] ?? 24));

      const groups = groupByCategory(rows, now).map((g) => ({
        key: g.key,
        label: g.label,
        entries: g.entries.map((e) => ({
          itemUuid: String(e.item['uuid'] ?? ''),
          itemName: String(e.item['name'] ?? ''),
          kind: e.kind,
          expiresOn: e.expiresOn,
          daysLeft: e.daysLeft,
          daysLeftText: e.daysLeftText,
          expired: e.expired,
          slot: slotIndexOf(e.expiresOn, slots),
          location: [e.item['room'], e.item['container']].filter(Boolean).join(' / '),
          remaining: Number(e.item['remaining'] ?? 0),
          isBulk: e.item['is_bulk'] === 'true',
          unit: e.item['unit'] === null ? '' : String(e.item['unit'] ?? ''),
        })),
        longTerm: g.longTerm.map((l) => ({
          itemUuid: String(l.item['uuid'] ?? ''),
          itemName: String(l.item['name'] ?? ''),
          remaining: Number(l.item['remaining'] ?? 0),
          unit: l.item['unit'] === null ? '' : String(l.item['unit'] ?? ''),
        })),
      }));

      return {
        granularity,
        today: today(now),
        slots,
        categories: groups
          .map((g) => ({ key: g.key, label: g.label, count: g.entries.length + g.longTerm.length }))
          .filter((c) => c.count > 0),
        groups: groups.filter((g) => g.entries.length > 0 || g.longTerm.length > 0),
        counts: {
          dated: groups.reduce((n, g) => n + g.entries.length, 0),
          longTerm: groups.reduce((n, g) => n + g.longTerm.length, 0),
        },
      };
    });
  });

  handle('item:consume', (wsId, uuid, qty, reason) => {
    const n = Number(qty);
    if (!Number.isInteger(n) || n <= 0) throw new Error('扣减数量必须是正整数');
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const key = asString(uuid, 'uuid');
      const item = selectOne(db, 'items', 'uuid = ?', [key], { includeInternal: true });
      if (!item) throw new WorkspaceNotFoundError(`物品 ${key}`);

      const remaining = Number(item['remaining'] ?? 0);
      // 非批量物品是一次性的：不管传多少，一次就是「用掉这一件」
      const isBulk = item['is_bulk'] === 'true';
      const nested = isBulk && hasStocks(db, key);
      const take = isBulk ? n : Math.min(n, remaining);
      if (take > remaining) throw new Error(`「${String(item['name'])}」剩余 ${remaining}，不足以扣减 ${take}`);

      const newRemaining = remaining - take;
      const r = typeof reason === 'string' && reason ? reason : 'consume';
      const terminal =
        newRemaining === 0
          ? r === 'discard'
            ? 'discarded'
            : r === 'expired_dispose'
              ? 'expired_disposed'
              : 'consumed'
          : 'in_use';

      const taken: { uuid: string; taken: number }[] = [];
      transaction(db, () => {
        if (nested) {
          // 配了「一组库存」：按先到期先出从各组扣，父项数量由子行汇总
          for (const t of consumeFromStocks(db, key, take)) {
            taken.push(t);
            insertRow(db, 'stock_moves', {
              item_uuid: t.uuid,
              moved_on: today(),
              qty_delta: String(-t.taken),
              reason: r,
              notes: null,
            });
          }
          refreshParentTotals(db, key);
        } else {
          updateRow(db, 'items', key, { remaining: String(newRemaining), status: terminal });
          insertRow(db, 'stock_moves', {
            item_uuid: key,
            moved_on: today(),
            qty_delta: String(-take),
            reason: r,
            notes: null,
          });
        }
      });

      const after = toBulkStocks(stocksOf(db, key));

      return {
        itemUuid: key,
        name: item['name'],
        consumed: take,
        reason: r,
        remaining: nested ? after.totals.remaining : newRemaining,
        status: terminal,
        isBulk,
        fromStocks: taken.length > 0 ? taken : null,
      };
    });
  });

  /**
   * 一键清理：删掉这个工作区里所有「非批量且剩余为 0」的记录。
   *
   * dryRun=true 只返回清单，不落库 —— 界面先弹确认框用。
   */
  handle('item:purgeSpent', (wsId, dryRun) => {
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const rows = selectWhere(db, 'items', `is_bulk = 0 AND remaining <= 0`, []);
      const list = rows.map((r) => ({
        uuid: String(r['uuid']),
        code: String(r['code'] ?? ''),
        name: String(r['name'] ?? ''),
        category: String(r['category'] ?? ''),
        location: [r['room'], r['container']].filter(Boolean).join(' / '),
      }));

      if (dryRun === true) return { purged: 0, items: list, dryRun: true };

      transaction(db, () => {
        for (const it of list) deleteRow(db, 'items', it.uuid);
      });
      return { purged: list.length, items: list, dryRun: false };
    });
  });

  handle('item:delete', (wsId, uuid) => {
    return withDb(wsId ? asString(wsId, 'wsId') : null, false, (db) => {
      const ok = deleteRow(db, 'items', asString(uuid, 'uuid'));
      if (!ok) throw new WorkspaceNotFoundError(`物品 ${String(uuid)}`);
      return { deleted: true };
    });
  });

  // ── 到期概览（v3：按分类分组 + 组内按到期时间排序，不再分级）──
  handle('alert:summary', (wsId) => {
    const dd = dataDir();
    const entry = wsId ? requireWorkspace(dd, asString(wsId, 'wsId')) : resolveWorkspace(dd, null);
    const overview = computeOverview(entry, workspaceDbPath(dd, entry));

    const db = openDatabase(workspaceDbPath(dd, entry), { readOnly: true });
    let lowStock: {
      itemUuid: string;
      itemName: string;
      category: string;
      remaining: number;
      minStock: number;
      shortfall: number;
      unit: string;
    }[] = [];
    try {
      const rows = selectWhere(db, 'items', `${TOP_LEVEL} AND status IN ('in_stock','in_use')`, []);
      lowStock = lowStockItems(rows).map((x) => ({
        itemUuid: String(x.item['uuid'] ?? ''),
        itemName: String(x.item['name'] ?? ''),
        category: String(x.item['category'] ?? ''),
        remaining: x.remaining,
        minStock: x.minStock,
        shortfall: x.shortfall,
        unit: x.item['unit'] === null ? '' : String(x.item['unit'] ?? ''),
      }));
    } finally {
      db.close();
    }

    return {
      workspaceId: overview.workspaceId,
      workspaceName: overview.workspaceName,
      generatedAt: overview.generatedAt,
      today: overview.today,
      counts: overview.counts,
      headline: overview.headline,
      // 分组结构直接给界面：每组里的 entries 已经按到期日升序排好
      groups: overview.groups.map((g) => ({
        key: g.key,
        label: g.label,
        counts: g.counts,
        entries: g.entries.map((e) => ({
          itemUuid: String(e.item['uuid'] ?? ''),
          itemName: String(e.item['name'] ?? ''),
          kind: e.kind,
          expiresOn: e.expiresOn,
          daysLeft: e.daysLeft,
          daysLeftText: e.daysLeftText,
          expired: e.expired,
          category: String(e.item['category'] ?? ''),
          brand: e.item['brand'] === null ? null : String(e.item['brand'] ?? ''),
          location: [e.item['room'], e.item['container']].filter(Boolean).join(' / '),
          remaining: Number(e.item['remaining'] ?? 0),
          quantity: Number(e.item['quantity'] ?? 0),
          isBulk: e.item['is_bulk'] === 'true',
          unit: e.item['unit'] === null ? '' : String(e.item['unit'] ?? ''),
        })),
        longTerm: g.longTerm.map((l) => ({
          itemUuid: String(l.item['uuid'] ?? ''),
          itemName: String(l.item['name'] ?? ''),
          category: String(l.item['category'] ?? ''),
          brand: l.item['brand'] === null ? null : String(l.item['brand'] ?? ''),
          location: [l.item['room'], l.item['container']].filter(Boolean).join(' / '),
          remaining: Number(l.item['remaining'] ?? 0),
          quantity: Number(l.item['quantity'] ?? 0),
          isBulk: l.item['is_bulk'] === 'true',
          unit: l.item['unit'] === null ? '' : String(l.item['unit'] ?? ''),
        })),
      })),
      lowStock,
    };
  });

  handle('alert:multi', () => {
    const dd = dataDir();
    return listWorkspaces(dd).map((entry) => {
      const s = computeOverview(entry, workspaceDbPath(dd, entry));
      return { workspaceId: entry.id, name: entry.name, counts: s.counts, headline: s.headline };
    });
  });

  // ── 导入导出 ──
  /**
   * 导出：支持多选。
   *
   *   - 选 1 个 → 单工作区归档（根目录就是数据），文件名默认 `<名字>.zip`
   *   - 选多个 → 多工作区归档（`workspaces/<名字>/…`），默认 `多工作区-<时间>.zip`
   *
   * 两种结构不同但都能被 `io:import` 认出来。**异常工作区也允许导出** ——
   * 这正是拿回数据的唯一途径。
   */
  handle('io:export', async (wsIds) => {
    const dd = dataDir();
    const ids = Array.isArray(wsIds)
      ? (wsIds as unknown[]).map((x) => asString(x, 'wsId'))
      : [asString(wsIds, 'wsId')];

    const entries = ids.map((id) => requireWorkspace(dd, id));
    const multi = entries.length > 1;
    const safe = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_');

    const result = await dialog.showSaveDialog({
      title: multi ? `导出 ${entries.length} 个工作区` : '导出工作区',
      defaultPath: join(
        app.getPath('documents'),
        multi ? `多工作区-${entries.length}个.zip` : `${safe(entries[0]!.name)}.zip`,
      ),
      filters: [{ name: 'Inventory 归档', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    if (!multi) {
      const out = exportWorkspace(dd, entries[0]!, { outPath: result.filePath });
      return {
        canceled: false,
        multi: false,
        archivePath: out.archivePath,
        bytesText: formatBytes(out.bytes),
        fileCount: out.fileCount,
        rowCounts: out.rowCounts,
        workspaces: [{ id: out.workspace.id, name: out.workspace.name }],
      };
    }

    const out = exportWorkspaces(dd, entries, { outPath: result.filePath });
    return {
      canceled: false,
      multi: true,
      archivePath: out.archivePath,
      bytesText: formatBytes(out.bytes),
      fileCount: out.fileCount,
      rowCounts: {},
      workspaces: out.workspaces.map((w) => ({ id: w.id, name: w.name })),
    };
  });

  handle('io:previewImport', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的归档',
      properties: ['openFile'],
      filters: [{ name: 'Inventory 归档', extensions: ['zip'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };

    // 多工作区包没有单工作区的 manifest 结构，先探一下再决定怎么预览
    const detected = detectMultiArchive(picked.filePaths[0]!);
    if (detected.multi) {
      return {
        canceled: false,
        multi: true,
        archivePath: picked.filePaths[0]!,
        workspaceCount: detected.workspaces.length,
        workspaces: detected.workspaces,
      };
    }

    const preview = previewArchive(picked.filePaths[0]!);
    return {
      canceled: false,
      multi: false,
      archivePath: picked.filePaths[0]!,
      workspaceName: preview.workspaceName,
      exportedAt: preview.manifest.exportedAt,
      formatVersion: preview.manifest.formatVersion,
      schemaVersion: preview.manifest.schemaVersion,
      checksumVerified: preview.checksumVerified,
      totalRows: preview.totalRows,
      errorCount: preview.errorCount,
      warningCount: preview.warningCount,
      tables: preview.tables,
      issues: preview.issues.slice(0, 100),
    };
  });

  /**
   * 导入。单工作区与多工作区自动识别：多工作区包会**分别新建多个工作区**。
   *
   * 一个失败不影响其余；失败的会被隔离，`items[].error` 里带着原因。
   */
  handle('io:import', (archivePath, name) => {
    const dd = dataDir();
    const opts: Parameters<typeof importArchive>[1] = { dataDir: dd };
    if (typeof name === 'string' && name.trim()) opts.name = name.trim();
    const r = importAnything(asString(archivePath, 'archivePath'), opts);
    return {
      ok: r.ok,
      multi: r.multi,
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      items: r.items,
      // 兼容老界面：单工作区时把第一个结果摊平上来
      workspaceId: r.items[0]?.workspaceId ?? null,
      workspaceName: r.items[0]?.name ?? '',
      rowCounts: r.items[0]?.rowCounts ?? {},
    };
  });

  handle('io:openPath', async (target) => {
    const p = asString(target, 'path');
    if (!existsSync(p)) throw new Error(`路径不存在: ${p}`);
    await shell.openPath(p);
    return { opened: true };
  });

  handle('io:revealPath', (target) => {
    const p = asString(target, 'path');
    if (!existsSync(p)) throw new Error(`路径不存在: ${p}`);
    shell.showItemInFolder(p);
    return { revealed: true };
  });
}

// ─────────────────────────────────────────────────────────────
// 时间轴：分格
// ─────────────────────────────────────────────────────────────

interface Slot {
  start: string;
  end: string;
  label: string;
  current: boolean;
}

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function monthEndOf(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y!, m!, 0);
  return isoOf(d);
}

/** 生成时间格，覆盖 [今天 - past 月, 今天 + future 月] */
function buildSlots(now: Date, granularity: string, monthsBack: number, monthsAhead: number): Slot[] {
  const todayStr = today(now);
  const slots: Slot[] = [];

  if (granularity === 'year') {
    const y0 = now.getFullYear() - Math.ceil(monthsBack / 12);
    const y1 = now.getFullYear() + Math.ceil(monthsAhead / 12);
    for (let y = y0; y <= y1; y += 1) {
      slots.push({ start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}`, current: y === now.getFullYear() });
    }
    return slots;
  }

  if (granularity === 'month') {
    for (let i = -monthsBack; i <= monthsAhead; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      slots.push({
        start: `${ym}-01`,
        end: monthEndOf(ym),
        label: ym,
        current: d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth(),
      });
    }
    return slots;
  }

  if (granularity === 'week') {
    // 以本周一为基准，前后展开
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    base.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    const back = Math.ceil((monthsBack * 30) / 7);
    const ahead = Math.ceil((monthsAhead * 30) / 7);
    for (let i = -back; i <= ahead; i += 1) {
      const s = new Date(base);
      s.setDate(s.getDate() + i * 7);
      const e = new Date(s);
      e.setDate(e.getDate() + 6);
      const ss = isoOf(s);
      const ee = isoOf(e);
      slots.push({
        start: ss,
        end: ee,
        label: `${ss.slice(5)}~${ee.slice(5)}`,
        current: todayStr >= ss && todayStr <= ee,
      });
    }
    return slots;
  }

  // day：以今天为中心，前后各展开半个月数
  const span = Math.round(((monthsBack + monthsAhead) * 30) / 2);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = -span; i <= span; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const s = isoOf(d);
    slots.push({ start: s, end: s, label: s.slice(5), current: s === todayStr });
  }
  return slots;
}

function slotIndexOf(date: string, slots: Slot[]): number {
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]!;
    if (date >= s.start && date <= s.end) return i;
  }
  return -1;
}

/** 按 uuid 取一条物品，找不到就抛「未找到」 */
function findItemByUuid(db: ReturnType<typeof openDatabase>, uuid: string): Row {
  const row = selectOne(db, 'items', 'uuid = ?', [uuid], { includeInternal: true });
  if (!row) throw new WorkspaceNotFoundError(`物品 ${uuid}`);
  return row;
}

// ─────────────────────────────────────────────────────────────
// 启动
// ─────────────────────────────────────────────────────────────

// 同一时间只允许一个实例：两个进程同时写同一个 SQLite 虽然安全（WAL），
// 但用户会看到两个窗口在互相刷新，体验很差
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    /*
     * 强制暗色。这一步必须在开窗口**之前**做。
     *
     * 系统标题栏是 Windows 画的、跟着系统主题走 —— 这台机器处于浅色模式，
     * 所以界面内容再黑，标题栏也还是浅灰的一条，像两个程序拼在一起。
     * 设成 dark 之后系统会把标题栏、窗口边框、原生右键菜单都按暗色渲染。
     * 界面本来就只有暗色一套配色（styles.css 里没有浅色变量），
     * 所以不需要再判断系统偏好。
     */
    nativeTheme.themeSource = 'dark';

    registerHandlers();
    createWindow();
    // 起点：排到下一个零点，之后每次响完再排下一次
    scheduleMidnightTick();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

export { dataDir };
