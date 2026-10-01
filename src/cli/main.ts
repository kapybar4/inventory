/**
 * CLI —— 完整的命令行工具。
 *
 * 设计定位：
 *   **桌面端能做的事，命令行全都能做。** 不存在"只能用界面操作"的能力。
 *
 * 输出约定：
 *   - **默认人读**（表格/摘要），`--json` 才输出机器用的信封。
 *   - `--json` 时 stdout 只有一个 JSON 对象，日志走 stderr，便于脚本与 agent 解析。
 *   - 退出码稳定：0 成功 / 1 运行错误 / 2 参数错误 / 3 数据校验失败 / 4 未找到。
 *   - 永不交互：需要确认的地方一律要 `--yes`，缺参数直接报错而不是等待输入。
 *
 * ── v2：取消批次 ──
 * 一行 items = 一件实际存在的东西。同一件东西买两次就是两条记录，
 * 各自带自己的购买日期、到期日与价格。所以没有 batch 子命令。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { APP_NAME, APP_VERSION, APP_FORMAT, APP_FORMAT_VERSION } from '../core/meta';
import { SCHEMA_VERSION } from '../core/schema';
import { ENUMS, CATEGORY_LEAD_DAYS, TABLES } from '../core/fields';
import { exportWorkspace, exportWorkspaces } from '../core/export';
import {
  importArchive,
  importAnything,
  previewArchive,
  detectMultiArchive,
  type ImportPreview,
} from '../core/import';
import {
  createWorkspace,
  defaultDataDir,
  listWorkspaces,
  readRegistry,
  removeWorkspace,
  renameWorkspace,
  requireWorkspace,
  resolveWorkspace,
  setActiveWorkspace,
  workspaceDbPath,
  workspaceStats,
  updateWorkspacePrefs,
  WorkspaceNotFoundError,
  WorkspaceUnusableError,
  isUsable,
  workspaceStatus,
  quarantineWorkspace,
  unquarantineWorkspace,
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
  type Row,
} from '../core/db';
import {
  computeOverview,
  groupByCategory,
  expiriesForItem,
  categoryLabel,
  lowStockItems,
  leadDaysFor,
  SOON_DAYS,
} from '../core/alerts';
import {
  addStock,
  removeStock,
  stocksOf,
  toBulkStocks,
  refreshParentTotals,
  consumeFromStocks,
  hasStocks,
  stockCounts,
} from '../core/bulk';
import {
  buildTree,
  sortItems,
  sortFieldDef,
  uncategorizedCount,
  SORT_FIELDS,
  categoryLabel as categoryLabelOf,
  type SortField,
} from '../core/ordering';
import {
  DEFAULT_COLUMNS,
  ITEM_COLUMNS,
  LOCKED_COLUMNS,
  isColumnKey,
  isMinimal,
  resolveColumns,
} from '../core/columns';
import { applyItemOrder, nextItemCode } from '../core/db';
import { formatDaysLeft, daysUntil, today, monthEnd } from '../core/dates';
import { seedWorkspace } from '../core/seed';
import { buildManifest } from '../core/manifest';
import { centsToYuan, yuanToCents, FieldError, mergeExtra, parseExtra, serializeExtra } from '../core/values';
import { formatBytes } from '../core/util';
import { ArgError, arr, bool, num, parseArgv, requireStr, str, type OptionSpec, type ParsedArgs } from './args';

// ─────────────────────────────────────────────────────────────
// 退出码
// ─────────────────────────────────────────────────────────────

const EXIT = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  VALIDATION: 3,
  NOT_FOUND: 4,
} as const;

/** 「没找到」而不是「出错了」：退出码 4 */
class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// ─────────────────────────────────────────────────────────────
// 输出层
// ─────────────────────────────────────────────────────────────

interface Output {
  json: boolean;
  quiet: boolean;
}

const out: Output = { json: false, quiet: false };

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

interface Envelope<T> {
  ok: boolean;
  data: T | null;
  warnings: string[];
  error?: { code: number; name: string; message: string };
  meta: Record<string, unknown>;
}

function emitJson<T>(data: T, warnings: string[] = [], meta: Record<string, unknown> = {}): void {
  const env: Envelope<T> = {
    ok: true,
    data,
    warnings,
    meta: { app: APP_NAME, version: APP_VERSION, ...meta },
  };
  process.stdout.write(JSON.stringify(env, null, 2) + '\n');
}

function emitError(code: number, name: string, message: string, extra: Record<string, unknown> = {}): void {
  if (out.json) {
    const env: Envelope<never> = {
      ok: false,
      data: null,
      warnings: [],
      error: { code, name, message },
      meta: { app: APP_NAME, version: APP_VERSION, ...extra },
    };
    process.stdout.write(JSON.stringify(env, null, 2) + '\n');
  } else {
    process.stderr.write(`错误: ${message}\n`);
  }
}

function write(line = ''): void {
  process.stdout.write(line + '\n');
}

// ─────────────────────────────────────────────────────────────
// 表格绘制（CJK 按 2 列）
// ─────────────────────────────────────────────────────────────

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEnd(s: string, cols: number): string {
  const d = cols - displayWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function padStart(s: string, cols: number): string {
  const d = cols - displayWidth(s);
  return d > 0 ? ' '.repeat(d) + s : s;
}

function clip(s: string, cols: number): string {
  if (displayWidth(s) <= cols) return s;
  let acc = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols - 1) break;
    acc += ch;
    w += cw;
  }
  return acc + '…';
}

interface Col<T> {
  title: string;
  get: (row: T) => string;
  align?: 'right';
  max?: number;
}

function printTable<T>(rows: T[], cols: Col<T>[], opts: { indent?: number } = {}): void {
  if (rows.length === 0) {
    write('（空）');
    return;
  }
  const indent = ' '.repeat(opts.indent ?? 0);
  const widths = cols.map((c) => {
    let w = displayWidth(c.title);
    for (const r of rows) w = Math.max(w, displayWidth(c.get(r)));
    return Math.min(c.max ?? 40, Math.max(3, w));
  });

  const render = (cells: string[]): string =>
    indent +
    cells
      .map((c, i) =>
        cols[i]!.align === 'right' ? padStart(clip(c, widths[i]!), widths[i]!) : padEnd(clip(c, widths[i]!), widths[i]!),
      )
      .join('  ');

  write(render(cols.map((c) => c.title)));
  write(indent + widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) write(render(cols.map((c) => c.get(r))));
}

function printKv(pairs: [string, string][], indent = 0): void {
  const keyW = Math.max(...pairs.map(([k]) => displayWidth(k)));
  const pre = ' '.repeat(indent);
  for (const [k, v] of pairs) write(`${pre}${padEnd(k, keyW)}  ${v}`);
}

function printSection(title: string, right = ''): void {
  const cols = process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 88;
  const used = displayWidth(title) + (right ? displayWidth(right) + 2 : 0);
  const ruleLen = Math.max(2, cols - used - 1);
  write(`\n${title} ${'─'.repeat(ruleLen)}${right ? ' ' + right : ''}`);
}

// ─────────────────────────────────────────────────────────────
// 全局选项
// ─────────────────────────────────────────────────────────────

const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: 'json', type: 'boolean', desc: '以 JSON 输出（机器可解析，stdout 只有一个对象）' },
  { name: 'dataDir', type: 'string', desc: '数据根目录，默认 %LOCALAPPDATA%\\dsh-inventory', valueName: 'path' },
  { name: 'ws', type: 'string', desc: '指定工作区（id / id 前缀 / 名称）', valueName: 'id' },
  { name: 'help', short: 'h', type: 'boolean', desc: '显示帮助' },
  { name: 'quiet', short: 'q', type: 'boolean', desc: '少输出（只打印关键结果）' },
  { name: 'yes', short: 'y', type: 'boolean', desc: '对破坏性操作确认' },
  { name: 'dryRun', type: 'boolean', desc: '只显示将要做什么，不落库' },
];

const DRY_RUN: OptionSpec = { name: 'dryRun', type: 'boolean', desc: '只显示将要做什么，不落库' };

/** JSON 输入选项（批量录入 / 部分更新共用） */
const JSON_INPUT_OPTS: OptionSpec[] = [
  { name: 'item', type: 'string', multiple: true, desc: '一行 JSON 描述一条记录（可重复）', valueName: 'json' },
  { name: 'stdin', type: 'boolean', desc: '从标准输入读 JSON（支持管道）' },
  { name: 'jsonFile', type: 'string', desc: '从文件读 JSON（数组=批量，对象=单条）', valueName: 'path' },
];

function dataDirOf(args: ParsedArgs): string {
  const d = str(args, 'dataDir');
  return d ? resolve(d) : defaultDataDir();
}

// ─────────────────────────────────────────────────────────────
// 领域辅助
// ─────────────────────────────────────────────────────────────

type Db = ReturnType<typeof openDatabase>;

/**
 * JSON 批量录入接受的字段名 —— **从 `fields.ts` 派生，不手写**。
 *
 * 早先这是一份手抄的清单，于是必然漂移：`model` 和 `is_bulk` 先后漏在里面，
 * 后果是**静默丢字段** —— `--json-file` 传 `{"model":"X1"}` 或 `{"bulk":true}`，
 * 命令照样报"已新增"，回头才发现型号没写进去、批量也没开。
 * 逐个往里补是治标：下一次给 items 加字段还会漏。
 * 所以改成从表定义算出来，加字段自动生效，漏不掉。
 *
 * 排除的只有三类：
 *   - `parent_uuid`：结构字段，「一组库存」的子行由 `item stock` 专门管
 *   - `code`：内部标识，缺省自动生成（要指定时用 `--code`，那是另一条路径）
 *   - `uuid` 不排除 —— 往返导入要靠它保住父子引用
 */
const ITEM_JSON_FIELDS: ReadonlySet<string> = (() => {
  const def = TABLES.find((t) => t.name === 'items');
  const names = new Set<string>();
  for (const f of def?.fields ?? []) {
    if (f.name === 'parent_uuid' || f.name === 'code') continue;
    names.add(f.name);
    names.add(camelizeKey(f.name));
  }
  return names;
})();

/** `unit_price_cents` → `unitPriceCents`，让两种写法都认 */
function camelizeKey(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * 内部标识：委托给 core 的 nextItemCode。
 * 生成规则只留一份实现，避免各入口各写一遍、修了一处漏两处。
 */
function nextCode(db: Db, category: string): string {
  return nextItemCode(db, category);
}

/** 编码前缀：`MED-0007` → `MED` */
function codePrefix(code: string): string {
  const i = code.lastIndexOf('-');
  return i > 0 ? code.slice(0, i) : code;
}

/** 编码序号：`MED-0007` → 7；对不上格式给 0 */
function codeNumber(code: string): number {
  const m = /-(\d+)$/.exec(code);
  return m ? Number(m[1]) : 0;
}

/**
 * 一批物品的编码分配器。
 *
 * 为什么不能直接循环调 `nextItemCode`：它返回的是**当前库里**第一个没被占用的
 * 序号，而同一批的多条在算编码时都还没落库 —— 于是同批里几个未分类的物品
 * 会全部拿到 `GEN-0002`，然后第二条起报"物品编码已存在"，整批失败。
 *
 * 这里按前缀记住"已经发到几号"，保证批内不重复，同时也不跟库里已有的撞。
 */
function makeCodeAllocator(db: Db): (category: string) => string {
  const allocated = new Map<string, number>();

  return (category: string): string => {
    // 先按老规矩从库里取一个基准，再往后推到本批没用过的号
    let candidate = nextCode(db, category);
    const prefix = codePrefix(candidate);
    let n = codeNumber(candidate);

    const seen = new Set<number>();
    for (const [code] of allocated) {
      if (codePrefix(code) === prefix) seen.add(codeNumber(code));
    }
    while (seen.has(n)) {
      n += 1;
      candidate = `${prefix}-${String(n).padStart(4, '0')}`;
    }
    // 同时也要避开库里已有的（nextItemCode 只保证起点没被占，往后推仍可能撞）
    while (selectOne(db, 'items', 'code = ?', [candidate])) {
      n += 1;
      candidate = `${prefix}-${String(n).padStart(4, '0')}`;
    }

    allocated.set(candidate, n);
    return candidate;
  };
}

/**
 * 按名称 / uuid / 内部标识 定位一条物品。
 *
 * 界面上不再显示编号，但命令行仍然可以用它定位 —— 比逼用户去复制 UUID 友好。
 * 名称命中多条时会明确报错并列出候选，而不是悄悄取第一条。
 */
function findItem(db: Db, key: string): Row {
  const exact = selectOne(db, 'items', 'uuid = ? OR code = ?', [key, key], { includeInternal: true });
  if (exact) return exact;

  // 按名称精确匹配（只在顶层物品里找，不含库存子行）
  const byName = selectWhere(db, 'items', `name = ? AND ${TOP_LEVEL}`, [key], { includeInternal: true });
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    const list = byName
      .map((r) => `  ${String(r['expires_on'] ?? '长期')}  ${String(r['uuid'])}`)
      .join('\n');
    throw new ArgError(`「${key}」匹配到 ${byName.length} 条，请用后面的 UUID 指定具体一条：\n${list}`);
  }

  // 最后按 uuid 前缀
  const byPrefix = selectWhere(db, 'items', 'uuid LIKE ?', [`${key}%`], { includeInternal: true });
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) throw new ArgError(`物品标识 "${key}" 不唯一，匹配到 ${byPrefix.length} 条`);
  throw new WorkspaceNotFoundError(`物品 ${key}`);
}

/** 选项名 → 列名 */
const ITEM_FIELDS: [string, string][] = [
  ['name', 'name'],
  ['category', 'category'],
  ['subcategory', 'subcategory'],
  ['brand', 'brand'],
  ['model', 'model'],
  ['spec', 'spec'],
  ['unit', 'unit'],
  ['barcode', 'barcode'],
  ['room', 'room'],
  ['container', 'container'],
  ['store', 'store'],
  ['notes', 'notes'],
  ['tags', 'tags'],
  ['serial', 'serial_no'],
  ['photoPath', 'photo_path'],
  ['purchasedOn', 'purchased_on'],
  ['openedOn', 'opened_on'],
  ['expiresOn', 'expires_on'],
  ['expiresYm', 'expires_ym'],
  ['precision', 'expiry_precision'],
  ['status', 'status'],
  ['warrantyUntil', 'warranty_until'],
];

const ITEM_NUM_FIELDS: [string, string][] = [
  ['qty', 'quantity'],
  ['remaining', 'remaining'],
  ['minStock', 'min_stock'],
  ['warrantyMonths', 'warranty_months'],
  ['openShelfLifeDays', 'open_shelf_life_days'],
  ['sortOrder', 'sort_order'],
];

/** 金额类选项单独处理（元 → 分） */
function itemMoneyValues(args: ParsedArgs): Record<string, string | null> {
  const v: Record<string, string | null> = {};
  const unitPrice = str(args, 'unitPrice');
  if (unitPrice !== undefined) {
    const cents = yuanToCents(unitPrice);
    if (cents === null) throw new ArgError(`--unit-price 不是合法金额: ${unitPrice}`);
    v['unit_price_cents'] = String(cents);
  }
  const amount = str(args, 'amount');
  if (amount !== undefined) {
    const cents = yuanToCents(amount);
    if (cents === null) throw new ArgError(`--amount 不是合法金额: ${amount}`);
    v['amount_cents'] = String(cents);
  }
  return v;
}

function itemOptionSpecs(): OptionSpec[] {
  return [
    { name: 'name', short: 'n', type: 'string', desc: '名称', valueName: '名称' },
    {
      name: 'unclassified',
      type: 'boolean',
      desc: '清空分类，归入「未分类」（分组页会置顶提醒你去分类）',
    },
    { name: 'sortOrder', type: 'number', desc: '手动顺序（默认状态下的排列位置）', valueName: 'N' },
    { name: 'code', type: 'string', desc: '编码（缺省自动生成）', valueName: 'code' },
    { name: 'category', short: 'c', type: 'string', desc: '分类 key（见 enums）', valueName: 'key' },
    { name: 'brand', type: 'string', desc: '品牌（选填）', valueName: '品牌' },
    { name: 'model', type: 'string', desc: '型号（选填，与规格不同）', valueName: '型号' },
    { name: 'spec', type: 'string', desc: '规格', valueName: '规格' },
    { name: 'unit', type: 'string', desc: '单位', valueName: '单位' },
    { name: 'barcode', type: 'string', desc: '条码', valueName: 'code' },
    { name: 'room', type: 'string', desc: '房间', valueName: '房间' },
    { name: 'container', type: 'string', desc: '容器/柜格', valueName: '位置' },
    { name: 'subcategory', type: 'string', desc: '子类', valueName: '文本' },
    { name: 'tags', type: 'string', desc: '标签（逗号分隔）', valueName: '文本' },
    { name: 'photoPath', type: 'string', desc: '照片相对路径', valueName: 'path' },
    { name: 'qty', type: 'number', desc: '数量（买入时多少个）', valueName: 'N' },
    { name: 'remaining', type: 'number', desc: '剩余数量', valueName: 'N' },
    { name: 'minStock', type: 'number', desc: '最低库存', valueName: 'N' },
    { name: 'unitPrice', type: 'string', desc: '单价（元）', valueName: '元' },
    { name: 'amount', type: 'string', desc: '总价（元，缺省 = 单价 × 数量）', valueName: '元' },
    { name: 'store', type: 'string', desc: '购买渠道', valueName: '名称' },
    { name: 'purchasedOn', type: 'string', desc: '购买日期（缺省今天）', valueName: '日期' },
    { name: 'expiresOn', type: 'string', desc: '到期日 YYYY-MM-DD；不填即「长期」', valueName: '日期' },
    { name: 'expiresYm', type: 'string', desc: '只到月份时填 YYYY-MM（自动折算到当月最后一天）', valueName: '年月' },
    { name: 'longTerm', type: 'boolean', desc: '标记为长期：清空到期日，不参与到期提示' },
    { name: 'openedOn', type: 'string', desc: '开封日期', valueName: '日期' },
    { name: 'openShelfLifeDays', type: 'number', desc: '开封后可用天数', valueName: 'N' },
    { name: 'warrantyMonths', type: 'number', desc: '质保月数', valueName: 'N' },
    { name: 'warrantyUntil', type: 'string', desc: '质保到期日', valueName: '日期' },
    { name: 'serial', type: 'string', desc: '序列号', valueName: 'sn' },
    { name: 'status', type: 'string', desc: '状态 key，缺省 in_stock', valueName: 'key' },
    {
      name: 'bulk',
      type: 'boolean',
      desc: '开启「批量」：数量可设、可多次领用、可设最低库存',
    },
    { name: 'noBulk', type: 'boolean', desc: '关闭「批量」（默认）：数量恒为 1' },
    { name: 'prescription', type: 'boolean', desc: '标记为处方药' },
    { name: 'notes', type: 'string', desc: '备注', valueName: '文本' },
    {
      name: 'extra',
      type: 'string',
      desc: '补充信息：扁平 JSON 对象，如 \'{"滤网型号":"M8R-FLP"}\'。整份覆盖',
      valueName: 'JSON',
    },
    ...JSON_INPUT_OPTS,
  ];
}

function itemValuesFromArgs(args: ParsedArgs, partial: boolean): Record<string, string | null> {
  const v: Record<string, string | null> = {};
  for (const [opt, col] of ITEM_FIELDS) {
    const x = str(args, opt);
    if (x !== undefined) v[col] = x;
  }
  for (const [opt, col] of ITEM_NUM_FIELDS) {
    const x = num(args, opt);
    if (x !== undefined) v[col] = String(x);
  }
  Object.assign(v, itemMoneyValues(args));

  if (bool(args, 'prescription')) v['is_prescription'] = 'true';
  // 补充信息：值在写入层会被解析与归一，这里原样传下去
  const extra = str(args, 'extra');
  if (extra !== undefined) v['extra_json'] = extra;
  if (bool(args, 'bulk')) v['is_bulk'] = 'true';
  if (bool(args, 'noBulk')) v['is_bulk'] = 'false';
  if (bool(args, 'unclassified')) v['category'] = null;
  // 长期 = 清空到期信息
  if (bool(args, 'longTerm')) {
    v['expires_on'] = null;
    v['expires_ym'] = null;
  }

  if (!partial) {
    // 分类可以留空 = 未分类（刻意保留这个空值，不做兜底）
    // 默认非批量：数量恒为 1，写入层还会再兜一道
    if (v['is_bulk'] === undefined) v['is_bulk'] = 'false';
    if (v['quantity'] === undefined) v['quantity'] = '1';
    if (v['remaining'] === undefined) v['remaining'] = v['quantity'];
    if (v['is_prescription'] === undefined) v['is_prescription'] = 'false';
    if (v['is_prescription'] === undefined) v['is_prescription'] = 'false';
    // 没写任何到期信息就是长期
    if (v['expires_on'] === undefined && v['expires_ym'] === undefined) {
      v['expires_on'] = null;
      v['expires_ym'] = null;
    }
    // 没写总价但有单价 → 自动乘数量
    if (!v['amount_cents'] && v['unit_price_cents']) {
      v['amount_cents'] = String(Number(v['unit_price_cents']) * Number(v['quantity']));
    }
  }
  return v;
}

/**
 * 去掉 UTF-8 BOM。
 *
 * Windows 上太常见：记事本另存、PowerShell 的 `Out-File -Encoding utf8`、
 * Excel 导出，都会在开头塞一个 U+FEFF。`JSON.parse` 见到它会直接抛
 * 「Unexpected token」，而用户看到的只是一个完全正常的 JSON 文件。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读取 JSON 输入：--json-file / --stdin / --item 三种来源合并 */
function readJsonInputs(args: ParsedArgs): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  const push = (raw: unknown, source: string): void => {
    if (Array.isArray(raw)) {
      for (const x of raw) {
        if (typeof x !== 'object' || x === null) throw new ArgError(`${source}: 数组元素必须是对象`);
        results.push(x as Record<string, unknown>);
      }
    } else if (typeof raw === 'object' && raw !== null) {
      results.push(raw as Record<string, unknown>);
    } else {
      throw new ArgError(`${source}: 期望 JSON 对象或数组`);
    }
  };

  const file = str(args, 'jsonFile');
  if (file) {
    const p = resolve(file);
    if (!existsSync(p)) throw new NotFoundError(`文件不存在: ${p}`);
    try {
      push(JSON.parse(stripBom(readFileSync(p, 'utf8'))), file);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new ArgError(`${file} 解析失败: ${(err as Error).message}`);
    }
  }

  if (bool(args, 'stdin')) {
    let text = '';
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      throw new ArgError('无法读取标准输入');
    }
    if (text.trim()) {
      try {
        push(JSON.parse(stripBom(text)), 'stdin');
      } catch (err) {
        throw new ArgError(`标准输入解析失败: ${(err as Error).message}`);
      }
    }
  }

  for (const raw of arr(args, 'item')) {
    try {
      push(JSON.parse(raw), '--item');
    } catch (err) {
      throw new ArgError(`--item 不是合法 JSON: ${raw}（${(err as Error).message}）`);
    }
  }

  return results;
}

/** JSON 键名归一：同时接受列名与驼峰写法 */
const JSON_KEY_ALIAS: Record<string, string> = {
  minStock: 'min_stock',
  warrantyMonths: 'warranty_months',
  openShelfLifeDays: 'open_shelf_life_days',
  prescription: 'is_prescription',
  isPrescription: 'is_prescription',
  qty: 'quantity',
  bulk: 'is_bulk',
  isBulk: 'is_bulk',
  unitPrice: 'unit_price_cents',
  amount: 'amount_cents',
  serial: 'serial_no',
  purchasedOn: 'purchased_on',
  expiresOn: 'expires_on',
  expiresYm: 'expires_ym',
  openedOn: 'opened_on',
  warrantyUntil: 'warranty_until',
  precision: 'expiry_precision',
};

function normalizeJsonKeys(input: Record<string, unknown>): Record<string, string | null> {
  const v: Record<string, string | null> = {};
  for (const [k, raw] of Object.entries(input)) {
    const key = JSON_KEY_ALIAS[k] ?? k;
    if (!ITEM_JSON_FIELDS.has(key)) continue;
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'boolean') v[key] = raw ? 'true' : 'false';
    else v[key] = String(raw);
  }
  // 元 → 分
  for (const yuanKey of ['unit_price', 'amount'] as const) {
    const y = input[yuanKey] ?? input[yuanKey === 'unit_price' ? 'unitPrice' : 'amount'];
    if (y !== undefined && y !== null) {
      const cents = yuanToCents(String(y));
      if (cents !== null) v[yuanKey === 'unit_price' ? 'unit_price_cents' : 'amount_cents'] = String(cents);
    }
  }
  delete v['unit_price'];
  delete v['amount'];
  return v;
}

/** 把一行物品渲染成人读的键值对 */
function itemFacts(it: Record<string, unknown>): [string, string][] {
  const num2 = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
  const yuan = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    const s = centsToYuan(v as string);
    return s ? `¥${s}` : '—';
  };
  const expiresOn = it['expires_on'] ? String(it['expires_on']) : '';
  const lead = leadDaysFor(it as Row);
  const bulk = it['is_bulk'] === 'true';
  return [
    ['分类', categoryLabel(String(it['category'] ?? ''))],
    ['品牌', num2(it['brand'])],
    ['型号', num2(it['model'])],
    ['规格', num2(it['spec'])],
    ['单位', num2(it['unit'])],
    ['位置', [it['room'], it['container']].filter(Boolean).join(' / ') || '—'],
    [
      '数量 / 剩余',
      bulk ? `${num2(it['quantity'])} / ${num2(it['remaining'])}` : `${num2(it['remaining'])}　(一件)`,
    ],
    ['批量物品', bulk ? '是' : '否'],
    ['最低库存', bulk ? num2(it['min_stock']) : '—（仅批量物品）'],
    ['状态', ENUMS['item_status']?.find((e) => e.key === it['status'])?.label ?? num2(it['status'])],
    ['购买日期', num2(it['purchased_on'])],
    ['购买渠道', num2(it['store'])],
    ['单价 / 总价', `${yuan(it['unit_price_cents'])} / ${yuan(it['amount_cents'])}`],
    ['到期', expiresOn ? `${expiresOn}（${formatDaysLeft(daysUntil(expiresOn))}）` : '长期'],
    ['开封日期', num2(it['opened_on'])],
    ['开封后可用', it['open_shelf_life_days'] ? `${it['open_shelf_life_days']} 天` : '—'],
    ['质保', it['warranty_months'] ? `${it['warranty_months']} 个月` : num2(it['warranty_until'])],
    ['条码', num2(it['barcode'])],
    ['序列号', num2(it['serial_no'])],
    ['提醒提前量', `${lead} 天（按分类）`],
    ['UUID', String(it['uuid'] ?? '')],
  ];
}

// ─────────────────────────────────────────────────────────────
// info
// ─────────────────────────────────────────────────────────────

function cmdInfo(_args: ParsedArgs, dataDir: string): number {
  const reg = readRegistry(dataDir);
  const ws = listWorkspaces(dataDir);
  const data = {
    app: APP_NAME,
    version: APP_VERSION,
    format: `${APP_FORMAT} v${APP_FORMAT_VERSION}`,
    schemaVersion: SCHEMA_VERSION,
    dataDir,
    dataDirIsDefault: dataDir === defaultDataDir(),
    exists: existsSync(dataDir),
    workspaceCount: ws.length,
    activeWorkspaceId: reg.activeWorkspaceId,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    categories: CATEGORY_LEAD_DAYS,
  };

  if (out.json) {
    emitJson(data);
    return EXIT.OK;
  }

  printKv([
    ['应用', `${APP_NAME} ${APP_VERSION}`],
    ['归档格式', `${APP_FORMAT} v${APP_FORMAT_VERSION}`],
    ['数据结构版本', String(SCHEMA_VERSION)],
    ['数据目录', dataDir + (data.exists ? '' : '  (不存在)')],
    ['工作区数量', String(ws.length)],
    ['默认工作区', reg.activeWorkspaceId ?? '(未设置)'],
    ['运行环境', `Node ${process.version} · ${process.platform} ${process.arch}`],
  ]);

  if (ws.length === 0) {
    write('\n还没有工作区。运行 `init` 创建第一个，或 `import <归档.zip>` 导入一个。');
  }
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────
// 工作区
// ─────────────────────────────────────────────────────────────

/** 来源 key → 中文（界面与命令行统一） */
function sourceLabel(key: string): string {
  return ENUMS['workspace_source']?.find((e) => e.key === key)?.label ?? key;
}

function cmdWsList(_args: ParsedArgs, dataDir: string): number {
  const reg = readRegistry(dataDir);
  const items = reg.workspaces.filter((w) => !w.archived);

  const rows = items.map((w) => {
    let stats: ReturnType<typeof workspaceStats> | null = null;
    // 异常工作区不去读它的库：状态都不对了，数字也不可信
    if (isUsable(w)) {
      try {
        stats = workspaceStats(dataDir, w);
      } catch {
        stats = null;
      }
    }
    const st = workspaceStatus(w);
    return {
      active: w.id === reg.activeWorkspaceId ? '●' : ' ',
      id: w.id,
      name: w.name,
      items: stats?.tableCounts['items'] ?? null,
      moves: stats?.tableCounts['stock_moves'] ?? null,
      source: sourceLabel(w.source),
      createdAt: w.createdAt.slice(0, 19).replace('T', ' '),
      bytes: stats?.dbBytes ?? null,
      ok: stats?.integrityOk ?? null,
      status: st,
      statusText: st === 'ok' ? '正常' : st === 'importing' ? '导入未完成' : '已隔离',
      statusReason: w.statusReason ?? null,
    };
  });

  if (out.json) {
    emitJson({
      dataDir,
      activeWorkspaceId: reg.activeWorkspaceId,
      count: rows.length,
      abnormal: rows.filter((r) => r.status !== 'ok').length,
      workspaces: rows.map((r) => ({
        id: r.id,
        name: r.name,
        active: r.active === '●',
        items: r.items,
        moves: r.moves,
        source: r.source,
        createdAt: r.createdAt,
        dbBytes: r.bytes,
        integrityOk: r.ok,
        status: r.status,
        usable: r.status === 'ok',
        statusReason: r.statusReason,
      })),
    });
    return EXIT.OK;
  }

  if (rows.length === 0) {
    write(`还没有工作区。数据目录: ${dataDir}`);
    write('用 `ws create --name "我的家"` 或 `import <归档.zip>` 创建。');
    return EXIT.OK;
  }

  printTable(rows, [
    { title: '', get: (r) => r.active, max: 1 },
    { title: 'ID', get: (r) => r.id, max: 22 },
    { title: '名称', get: (r) => r.name, max: 24 },
    { title: '状态', get: (r) => r.statusText, max: 12 },
    { title: '物品', get: (r) => (r.items === null ? '—' : String(r.items)), align: 'right' },
    { title: '流水', get: (r) => (r.moves === null ? '—' : String(r.moves)), align: 'right' },
    { title: '来源', get: (r) => r.source, max: 8 },
    { title: '创建', get: (r) => r.createdAt },
    { title: '大小', get: (r) => (r.bytes === null ? '—' : formatBytes(r.bytes)), align: 'right' },
    { title: '完整性', get: (r) => (r.ok === null ? '?' : r.ok ? 'ok' : '异常') },
  ]);

  const bad = rows.filter((r) => r.status !== 'ok');
  if (bad.length > 0) {
    write(`\n有 ${bad.length} 个工作区不可用（禁止读写）：`);
    for (const b of bad) {
      write(`  ${b.name} —— ${b.statusText}${b.statusReason ? `：${b.statusReason}` : ''}`);
    }
    write('恢复方式：导出备份 → 删除 → 重新导入。');
    write(`  dsh-inv export --ws "<工作区>" -o 备份.zip`);
    write(`  dsh-inv ws rm "<工作区>" --yes`);
    write(`  dsh-inv import 备份.zip`);
  }
  return EXIT.OK;
}

function cmdWsCreate(args: ParsedArgs, dataDir: string): number {
  const name = requireStr(args, 'name', '--name <名称>');
  const withSeed = bool(args, 'seed');

  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, would: { action: 'createWorkspace', name, seed: withSeed } });
    else write(`将创建工作区「${name}」${withSeed ? '（含演示数据）' : '（空）'}`);
    return EXIT.OK;
  }

  const created = createWorkspace(dataDir, {
    name,
    source: withSeed ? 'demo' : 'blank',
    // 显式 --use 才切默认；否则不动，避免「新建一个空工作区把默认抢走」
    makeActive: bool(args, 'use'),
  });
  const seeded = withSeed ? seedWorkspace(dataDir, created.entry) : null;
  const stats = workspaceStats(dataDir, created.entry);

  if (out.json) {
    emitJson({
      id: created.entry.id,
      name: created.entry.name,
      dir: created.dir,
      dbPath: created.dbPath,
      seed: seeded,
      tableCounts: stats.tableCounts,
    });
    return EXIT.OK;
  }

  write(`已创建工作区「${created.entry.name}」`);
  printKv([
    ['ID', created.entry.id],
    ['数据库', created.dbPath],
    ['物品数', String(stats.tableCounts['items'])],
  ]);
  if (seeded) write(`已写入演示数据：${seeded.items} 条物品记录 / ${seeded.moves} 条流水`);
  return EXIT.OK;
}

function cmdWsShow(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws') ?? args._[0] ?? null);
  const stats = workspaceStats(dataDir, entry);
  const summary = computeOverview(entry, workspaceDbPath(dataDir, entry));

  const data = {
    id: stats.id,
    name: stats.name,
    createdAt: stats.createdAt,
    source: sourceLabel(stats.source),
    dir: stats.dir,
    dbPath: stats.dbPath,
    dbBytes: stats.dbBytes,
    schemaVersion: stats.schemaVersion,
    integrityOk: stats.integrityOk,
    tableCounts: stats.tableCounts,
    alerts: summary.counts,
    headline: summary.headline,
    verifyMessages: stats.verify.messages,
  };

  if (out.json) {
    emitJson(data, stats.verify.messages);
    return EXIT.OK;
  }

  printKv([
    ['名称', data.name],
    ['ID', data.id],
    ['目录', data.dir],
    ['数据库', `${data.dbPath}  (${formatBytes(data.dbBytes)})`],
    ['来源', data.source],
    ['创建时间', data.createdAt.slice(0, 19).replace('T', ' ')],
    ['结构版本', `${data.schemaVersion}${data.integrityOk ? ' · 完整性 ok' : ' · 完整性异常'}`],
    ['数据量', `物品 ${data.tableCounts['items']} · 流水 ${data.tableCounts['stock_moves']}`],
    ['提醒', data.headline],
  ]);
  for (const m of data.verifyMessages) log(`  警告: ${m}`);
  return EXIT.OK;
}

function cmdWsStats(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws') ?? args._[0] ?? null);
  const stats = workspaceStats(dataDir, entry);

  const db = openDatabase(workspaceDbPath(dataDir, entry), { readOnly: true });
  let byCategory: { key: string; count: number }[] = [];
  let byRoom: { room: string; count: number }[] = [];
  let statusCounts: { key: string; count: number }[] = [];
  let spend = { totalCents: 0, priced: 0, earliest: null as string | null, latest: null as string | null };

  try {
    byCategory = (
      db
        .prepare('SELECT category AS key, COUNT(*) AS n FROM items GROUP BY category ORDER BY n DESC')
        .all() as { key: string; n: number }[]
    ).map((r) => ({ key: String(r.key), count: Number(r.n) }));

    byRoom = (
      db
        .prepare(
          `SELECT COALESCE(NULLIF(room,''),'(未填)') AS room, COUNT(*) AS n
           FROM items GROUP BY room ORDER BY n DESC`,
        )
        .all() as { room: string; n: number }[]
    ).map((r) => ({ room: String(r.room), count: Number(r.n) }));

    statusCounts = (
      db
        .prepare('SELECT status AS key, COUNT(*) AS n FROM items GROUP BY status ORDER BY n DESC')
        .all() as { key: string; n: number }[]
    ).map((r) => ({ key: String(r.key), count: Number(r.n) }));

    const agg = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS n,
                MIN(purchased_on) AS earliest, MAX(purchased_on) AS latest
         FROM items WHERE amount_cents IS NOT NULL`,
      )
      .get() as { total: number; n: number; earliest: string | null; latest: string | null };
    spend = {
      totalCents: Number(agg.total ?? 0),
      priced: Number(agg.n ?? 0),
      earliest: agg.earliest ?? null,
      latest: agg.latest ?? null,
    };
  } finally {
    db.close();
  }

  const data = {
    workspace: { id: stats.id, name: stats.name, dbPath: stats.dbPath, dbBytes: stats.dbBytes },
    tableCounts: stats.tableCounts,
    byCategory,
    byRoom,
    byStatus: statusCounts,
    spend: {
      totalYuan: centsToYuan(spend.totalCents),
      priced: spend.priced,
      earliest: spend.earliest,
      latest: spend.latest,
    },
    integrityOk: stats.integrityOk,
  };

  if (out.json) {
    emitJson(data);
    return EXIT.OK;
  }

  write(`${stats.name}  —  ${stats.dbPath}  (${formatBytes(stats.dbBytes)})`);
  printKv([
    ['物品记录', String(stats.tableCounts['items'])],
    ['出入库流水', String(stats.tableCounts['stock_moves'])],
    ['有价格的记录总额', `¥${data.spend.totalYuan}（${spend.priced} 条记录）`],
    ['购买日期范围', spend.earliest ? `${spend.earliest} ~ ${spend.latest ?? '—'}` : '—'],
  ]);

  if (byCategory.length > 0) {
    printSection('按分类');
    printTable(byCategory, [
      {
        title: '分类',
        get: (r) => `${r.key}  ${ENUMS['item_category']?.find((e) => e.key === r.key)?.label ?? ''}`,
        max: 24,
      },
      { title: '记录数', get: (r) => String(r.count), align: 'right' },
    ]);
  }

  if (statusCounts.length > 0) {
    printSection('按状态');
    printTable(statusCounts, [
      { title: '状态', get: (r) => `${r.key}  ${ENUMS['item_status']?.find((e) => e.key === r.key)?.label ?? ''}`, max: 24 },
      { title: '记录数', get: (r) => String(r.count), align: 'right' },
    ]);
  }

  if (byRoom.length > 0) {
    printSection('按房间');
    printTable(byRoom, [
      { title: '房间', get: (r) => r.room, max: 20 },
      { title: '记录数', get: (r) => String(r.count), align: 'right' },
    ]);
  }
  return EXIT.OK;
}

function cmdWsVerify(args: ParsedArgs, dataDir: string): number {
  const entries = str(args, 'ws')
    ? [resolveWorkspace(dataDir, str(args, 'ws')!, { allowUnusable: true })]
    : listWorkspaces(dataDir);

  if (entries.length === 0) {
    if (out.json) emitJson({ checked: 0, failed: 0, results: [] }, ['没有工作区']);
    else write('没有工作区可检查。');
    return EXIT.OK;
  }

  const results = entries.map((e) => {
    const s = workspaceStats(dataDir, e);
    return {
      id: s.id,
      name: s.name,
      ok: s.verify.ok,
      integrity: s.verify.integrity,
      foreignKeyViolations: s.verify.foreignKeyViolations,
      schemaVersion: s.verify.schemaVersion,
      expectedSchemaVersion: s.verify.expectedSchemaVersion,
      messages: s.verify.messages,
      tableCounts: s.tableCounts,
      statusBefore: workspaceStatus(e),
    };
  });

  const bad = results.filter((r) => !r.ok);

  /**
   * 自检不过的**自动隔离**。
   *
   * 光报个"异常"没用 —— 用户下次照样能点进去改，边改边坏。
   * 标成隔离之后读写会被闸门挡住，界面上也会出现"导出备份 → 删除重建"的指引。
   *
   * `--no-quarantine` 可以只报告不动状态（排查问题时想先看看再说）。
   */
  const autoQuarantine = !bool(args, 'noQuarantine') && !bool(args, 'dryRun');
  const quarantined: string[] = [];
  if (autoQuarantine) {
    for (const b of bad) {
      if (b.statusBefore === 'quarantined') continue;
      quarantineWorkspace(dataDir, b.id, `自检未通过：${b.messages.join('；') || b.integrity}`);
      quarantined.push(b.name);
    }
  }

  if (out.json) {
    emitJson(
      {
        checked: results.length,
        failed: bad.length,
        quarantined,
        results: results.map((r) => ({ ...r, status: workspaceStatus(requireWorkspace(dataDir, r.id)) })),
      },
      bad.map((b) => `${b.name}: ${b.messages.join('；')}`),
    );
    return bad.length > 0 ? EXIT.VALIDATION : EXIT.OK;
  }

  printTable(results, [
    { title: '工作区', get: (r) => r.name, max: 24 },
    { title: '结果', get: (r) => (r.ok ? 'ok' : '异常') },
    { title: '完整性', get: (r) => r.integrity },
    { title: '外键悬空', get: (r) => String(r.foreignKeyViolations), align: 'right' },
    { title: '结构版本', get: (r) => `${r.schemaVersion}/${r.expectedSchemaVersion}` },
  ]);
  for (const b of bad) for (const m of b.messages) log(`  [${b.name}] ${m}`);
  if (quarantined.length > 0) {
    write(`\n已隔离 ${quarantined.length} 个工作区：${quarantined.join('、')}`);
    write('它们现在禁止读写。建议：先导出备份，再删除并重新导入。');
    write(`  dsh-inv export --ws "<工作区>" -o 备份.zip`);
    write(`  dsh-inv ws rm "<工作区>" --yes`);
  } else if (bad.length > 0) {
    write('\n（--no-quarantine 或 --dry-run：只报告，未改动状态）');
  }
  return bad.length > 0 ? EXIT.VALIDATION : EXIT.OK;
}

function cmdWsUse(args: ParsedArgs, dataDir: string): number {
  const target = args._[0] ?? str(args, 'ws');
  if (!target) throw new ArgError('用法: ws use <工作区>');
  const entry = requireWorkspace(dataDir, target);
  setActiveWorkspace(dataDir, entry.id);
  if (out.json) emitJson({ activeWorkspaceId: entry.id, name: entry.name });
  else write(`默认工作区已设为「${entry.name}」(${entry.id})`);
  return EXIT.OK;
}

function cmdWsRename(args: ParsedArgs, dataDir: string): number {
  const target = args._[0] ?? str(args, 'ws');
  const newName = args._[1] ?? str(args, 'name');
  if (!target || !newName) throw new ArgError('用法: ws rename <工作区> <新名称>');
  const entry = requireWorkspace(dataDir, target);
  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, would: { rename: entry.id, from: entry.name, to: newName } });
    else write(`将把「${entry.name}」重命名为「${newName}」`);
    return EXIT.OK;
  }
  const updated = renameWorkspace(dataDir, entry.id, newName);
  if (out.json) emitJson({ id: updated.id, name: updated.name });
  else write(`已重命名为「${updated.name}」`);
  return EXIT.OK;
}

function cmdWsQuarantine(args: ParsedArgs, dataDir: string): number {
  const key = args._[0];
  if (!key) throw new ArgError('用法: ws quarantine <工作区> [--reason <原因>]');
  const entry = resolveWorkspace(dataDir, key, { allowUnusable: true });
  const reason = str(args, 'reason') ?? '用户手动标记';

  const updated = quarantineWorkspace(dataDir, entry.id, reason);

  if (out.json) {
    emitJson({ id: updated.id, name: updated.name, status: updated.status, reason: updated.statusReason });
    return EXIT.OK;
  }
  write(`已把「${updated.name}」标记为异常，读写已被禁止。`);
  write(`原因：${reason}`);
  write('\n恢复方式：先导出备份，再删除并重新导入。');
  write(`  dsh-inv export --ws "${updated.name}" -o 备份.zip`);
  write(`  dsh-inv ws rm "${updated.name}" --yes`);
  write('  dsh-inv import 备份.zip');
  return EXIT.OK;
}

function cmdWsUnquarantine(args: ParsedArgs, dataDir: string): number {
  const key = args._[0];
  if (!key) throw new ArgError('用法: ws unquarantine <工作区>');
  const entry = resolveWorkspace(dataDir, key, { allowUnusable: true });

  // 顺便跑一次自检：数据真有问题的话，解除隔离只会让它继续坏下去
  const before = entry.statusReason ?? '';
  const s = workspaceStats(dataDir, entry);
  if (!s.verify.ok) {
    write(`「${entry.name}」自检未通过，不能解除隔离：`);
    for (const m of s.verify.messages) write(`  ${m}`);
    write('\n请先导出备份，然后删除并重新导入。');
    return EXIT.VALIDATION;
  }

  const updated = unquarantineWorkspace(dataDir, entry.id);

  if (out.json) {
    emitJson({ id: updated.id, name: updated.name, status: workspaceStatus(updated), previousReason: before });
    return EXIT.OK;
  }
  write(`已解除「${updated.name}」的异常标记，现在可以正常读写。`);
  if (before) write(`（原标记原因：${before}）`);
  return EXIT.OK;
}

function cmdWsRm(args: ParsedArgs, dataDir: string): number {
  const target = args._[0] ?? str(args, 'ws');
  if (!target) throw new ArgError('用法: ws rm <工作区> --yes');
  const entry = requireWorkspace(dataDir, target);

  if (!bool(args, 'yes')) {
    throw new ArgError(
      `删除工作区「${entry.name}」(${entry.id}) 需要显式确认：加 --yes。\n` +
        `默认会先导出一份数据库快照到 backups/，用 --no-snapshot 可关闭。`,
    );
  }
  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, would: { remove: entry.id, name: entry.name } });
    else write(`将删除工作区「${entry.name}」(${entry.id})`);
    return EXIT.OK;
  }

  const result = removeWorkspace(dataDir, entry.id, { snapshot: !bool(args, 'noSnapshot') });
  if (out.json) emitJson({ removed: true, id: entry.id, name: entry.name, snapshotPath: result.snapshotPath ?? null });
  else {
    write(`已删除工作区「${entry.name}」(${entry.id})`);
    if (result.snapshotPath) write(`快照已保留: ${result.snapshotPath}`);
  }
  return EXIT.OK;
}

function cmdWsSeed(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws') ?? args._[0] ?? null);
  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, would: { seed: entry.id } });
    else write(`将向「${entry.name}」写入演示数据`);
    return EXIT.OK;
  }
  const result = seedWorkspace(dataDir, entry);
  if (out.json) emitJson({ workspaceId: entry.id, name: entry.name, ...result });
  else write(`已写入演示数据：${result.items} 条物品记录 / ${result.moves} 条流水`);
  return EXIT.OK;
}

function cmdInit(args: ParsedArgs, dataDir: string): number {
  const name = str(args, 'name') ?? '我的家';
  const withSeed = !bool(args, 'noSeed');

  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, dataDir, name, seed: withSeed });
    else write(`将初始化 ${dataDir}，并创建「${name}」${withSeed ? '（含演示数据）' : '（空）'}`);
    return EXIT.OK;
  }

  const reg = readRegistry(dataDir);
  if (reg.workspaces.length > 0) {
    if (out.json) {
      emitJson(
        { dataDir, alreadyInitialized: true, workspaces: reg.workspaces.map((w) => ({ id: w.id, name: w.name })) },
        ['数据目录已初始化过，未做任何改动'],
      );
    } else {
      write(`${dataDir} 已初始化过（${reg.workspaces.length} 个工作区），未做改动。`);
    }
    return EXIT.OK;
  }

  // init 是「第一次建立数据目录」，这时没有默认工作区，它会自动被认领
  const created = createWorkspace(dataDir, { name, source: withSeed ? 'demo' : 'blank' });
  const seeded = withSeed ? seedWorkspace(dataDir, created.entry) : null;

  if (out.json) {
    emitJson({ dataDir, workspaceId: created.entry.id, name, seed: seeded });
    return EXIT.OK;
  }
  write('初始化完成。');
  printKv([
    ['数据目录', dataDir],
    ['工作区', `${name}  (${created.entry.id})`],
    ['数据库', created.dbPath],
  ]);
  if (seeded) write(`演示数据：${seeded.items} 条物品记录 / ${seeded.moves} 条流水`);
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────
// 物品
// ─────────────────────────────────────────────────────────────

function cmdItemAdd(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));

  const jsonInputs = readJsonInputs(args).map(normalizeJsonKeys);
  const drafts: Record<string, string | null>[] = [];

  const fromArgs = itemValuesFromArgs(args, false);
  if ((fromArgs['name'] ?? '') !== '') drafts.push(fromArgs);

  for (const j of jsonInputs) {
    if (!j['name']) throw new ArgError('JSON 输入必须包含 name 字段');
    const base: Record<string, string | null> = {
      /**
       * 这里**不能**给 category 兜底成 'other'。
       *
       * `{ ...base, ...j }` 是"j 里有就覆盖"，所以 j 里**没有** category 时
       * 'other' 会留下 —— "没写分类"就此被静默当成"用户选了其他"，
       * 「未分类」组永远是空的，那条置顶提示也永远不出现。
       *
       * 缺省值只该给"缺了也无所谓"的字段（数量 1、非处方、无到期精度）。
       * 分类缺了是**有含义的**：它是未分类，后面会显式写成空串。
       */
      quantity: '1',
      remaining: '1',
      is_prescription: 'false',
      expiry_precision: 'none',
    };
    const merged = { ...base, ...j };
    // 给了数量但没给剩余 → 剩余跟随数量（JSON 来源的键可能不存在，所以用 ?? 兜底）
    if (merged['remaining'] === '1' && j['quantity'] !== undefined && j['remaining'] === undefined) {
      merged['remaining'] = merged['quantity'] ?? '1';
    }
    if (merged['expires_ym'] && !merged['expires_on'] && merged['expiry_precision'] === 'none') {
      merged['expiry_precision'] = 'month';
    }
    if (merged['expires_on'] && merged['expiry_precision'] === 'none') merged['expiry_precision'] = 'day';
    drafts.push(merged);
  }

  if (drafts.length === 0) {
    throw new ArgError(
      '没有要新增的物品。用 --name 指定一个，或用 --json-file / --stdin / --item 传入 JSON。\n' +
        '例：dsh-inv item add --name "布洛芬缓释胶囊" -c medicine --expires-ym 2027-03 --qty 2 --unit-price 19.30',
    );
  }

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  const created: Record<string, unknown>[] = [];
  try {
    /**
     * 两趟走：**先全部校验并算好值，再一个事务写进去**。
     *
     * 早先是一趟循环、每条自己开一个事务，于是"第二条分类写错"时第一条
     * 已经落库了 —— 命令报 exit 2，库里却多了一条。批量录入要么全成、
     * 要么全不成；留半截比直接失败更难收拾（得自己去比对哪几条进去了）。
     *
     * 顺带解决编码冲突：`nextCode` 读的是库里当前的最大号，
     * 同批多条都还没落库时会算出同一个号。用 `alloc` 在批内记账。
     */
    const alloc = makeCodeAllocator(db);
    const pending: { values: Record<string, string | null>; code: string; category: string }[] = [];

    for (const d of drafts) {
      /**
       * 分类不给就是**未分类**（空串），不是 `other`。
       *
       * 早先这里写的是 `?? 'other'`，于是 `--json-file` 传一批只写了名字的物品，
       * 它们全被塞进「其他」—— "还没想好放哪类"就这么被静默地伪装成了"已分类"，
       * 而「未分类」组的提示也因此永远不出现。
       *
       * `other` 是**用户主动选的**分类（"其他"），跟"没选"是两回事。
       * 空值语义在 fields.ts 里有明确说明，这里不该兜底。
       */
      const category = d['category'] ?? '';
      const allowed = (ENUMS['item_category'] ?? []).map((e) => e.key);
      // 空串是**合法**值（= 未分类），不在枚举清单里但必须放行。
      // 枚举描述的是"有哪些分类"，而"尚未分类"不是一个分类。
      if (category !== '' && !allowed.includes(category)) {
        throw new ArgError(`分类 "${category}" 不存在。可用: ${allowed.join(', ')}`);
      }
      const status = d['status'] ?? 'in_stock';
      const statusAllowed = (ENUMS['item_status'] ?? []).map((e) => e.key);
      if (!statusAllowed.includes(status)) {
        throw new ArgError(`状态 "${status}" 不存在。可用: ${statusAllowed.join(', ')}`);
      }
      const code = d['code'] || alloc(category);
      // 既要跟库里已有的比，也要跟同批已排队的比
      if (selectOne(db, 'items', 'code = ?', [code]) || pending.some((p) => p.code === code)) {
        throw new ArgError(`物品编码已存在: ${code}`);
      }

      const values: Record<string, string | null> = { ...d, code, status };
      /**
       * 分类**必须显式写进去**，哪怕它是空的。
       *
       * 不给这个键的话，`category` 会落到建表时的默认值 `'other'` ——
       * 于是"什么都没填"变成了"用户选了其他"，「未分类」组永远空着。
       * 空值在这里是有意义的信息，不能靠"键不存在"来表达。
       */
      values['category'] = category;
      if (!values['purchased_on']) values['purchased_on'] = today();

      // 只排队，先不写 —— 全部校验通过之后才在**一个**事务里落库
      pending.push({ values, code, category });
    }

    if (bool(args, 'dryRun')) {
      for (const p of pending) {
        created.push({ code: p.code, name: p.values['name'], category: p.category, dryRun: true });
      }
    } else {
      transaction(db, () => {
        for (const p of pending) {
          const item = insertRow(db, 'items', p.values) as unknown as Record<string, unknown>;
          insertRow(db, 'stock_moves', {
            item_uuid: String(item['uuid']),
            moved_on: p.values['purchased_on']!,
            qty_delta: p.values['quantity'] ?? '1',
            reason: 'purchase',
            notes: p.values['store'] ? `购自 ${p.values['store']}` : null,
          });
          created.push(item);
        }
      });
    }
  } finally {
    db.close();
  }

  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, wouldCreate: created });
    else {
      write(`将新增 ${created.length} 条物品记录：`);
      for (const c of created) write(`  ${c['code']}  ${c['name']}`);
    }
    return EXIT.OK;
  }

  if (out.json) {
    emitJson({
      workspaceId: entry.id,
      created: created.map((r) => ({
        uuid: r['uuid'],
        code: r['code'],
        name: r['name'],
        category: r['category'],
        remaining: r['remaining'],
        expiresOn: r['expires_on'] ?? null,
      })),
    });
    return EXIT.OK;
  }

  write(`已新增 ${created.length} 条物品记录：`);
  printTable(created, [
    { title: '编码', get: (r) => String(r['code']), max: 14 },
    { title: '名称', get: (r) => String(r['name']), max: 40 },
    { title: '剩余', get: (r) => String(r['remaining'] ?? ''), align: 'right' },
    { title: '到期', get: (r) => (r['expires_on'] ? String(r['expires_on']) : '长期'), max: 14 },
    { title: 'UUID', get: (r) => String(r['uuid']), max: 36 },
  ]);
  return EXIT.OK;
}

function cmdItemList(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const db = openDatabase(workspaceDbPath(dataDir, entry), { readOnly: true });

  try {
    const where: string[] = [TOP_LEVEL];
    const params: (string | number)[] = [];
    const category = str(args, 'category');
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    const room = str(args, 'room');
    if (room) {
      where.push('room = ?');
      params.push(room);
    }
    const search = str(args, 'search');
    if (search) {
      where.push('(name LIKE ? OR brand LIKE ? OR model LIKE ? OR barcode = ?)');
      const q = `%${search}%`;
      params.push(q, q, q, search);
    }
    const status = str(args, 'status');
    if (status) {
      where.push('status = ?');
      params.push(status);
    } else if (!bool(args, 'all')) {
      where.push(`status IN ('in_stock','in_use')`);
    }
    if (bool(args, 'lowStock')) {
      where.push('min_stock > 0 AND remaining < min_stock');
    }
    if (bool(args, 'longTerm')) {
      where.push(`(expires_on IS NULL OR expires_on = '')`);
    }
    if (bool(args, 'dated')) {
      where.push(`expires_on IS NOT NULL AND expires_on <> ''`);
    }

    // 显式写 ORDER BY：默认状态下的顺序就是 sort_order，
    // 不写的话返回次序由 SQLite 决定（走哪个索引都可能变），那是靠不住的
    let list = selectWhere(
      db,
      'items',
      `${where.join(' AND ')} ORDER BY sort_order ASC, rowid ASC`,
      params,
    ).map((r) => {
      const expiresOn = r['expires_on'] ? String(r['expires_on']) : null;
      const left = expiresOn ? daysUntil(expiresOn) : null;
      const minStock = Number(r['min_stock'] ?? 0);
      const remaining = Number(r['remaining'] ?? 0);
      const stocks = stocksOf(db, String(r['uuid']));
      return {
        uuid: String(r['uuid']),
        name: String(r['name'] ?? ''),
        category: r['category'] === null || r['category'] === undefined ? '' : String(r['category']),
        categoryLabel: categoryLabelOf(r['category'] === null || r['category'] === undefined ? '' : String(r['category'])),
        brand: r['brand'] === null ? '' : String(r['brand'] ?? ''),
        model: r['model'] === null ? '' : String(r['model'] ?? ''),
        spec: r['spec'] === null ? '' : String(r['spec'] ?? ''),
        unit: r['unit'] === null ? '' : String(r['unit'] ?? ''),
        barcode: r['barcode'] === null ? '' : String(r['barcode'] ?? ''),
        room: r['room'] === null ? '' : String(r['room'] ?? ''),
        container: r['container'] === null ? '' : String(r['container'] ?? ''),
        quantity: Number(r['quantity'] ?? 0),
        remaining,
        isBulk: r['is_bulk'] === 'true',
        /** 内部顺序号；默认状态下它就是列表里的位置 */
        sortOrder: Number(r['sort_order'] ?? 0),
        /** 这条批量物品用了「一组库存」：几条子行 */
        stockCount: stocks.length,
        minStock,
        purchasedOn: r['purchased_on'] === null ? '' : String(r['purchased_on'] ?? ''),
        expiresOn,
        openedOn: r['opened_on'] === null ? '' : String(r['opened_on'] ?? ''),
        store: r['store'] === null ? '' : String(r['store'] ?? ''),
        serialNo: r['serial_no'] === null ? '' : String(r['serial_no'] ?? ''),
        status: String(r['status'] ?? ''),
        isPrescription: r['is_prescription'] === 'true',
        notes: r['notes'] === null ? '' : String(r['notes'] ?? ''),
        unitPriceYuan: centsToYuan(r['unit_price_cents'] as string | null),
        amountYuan: centsToYuan(r['amount_cents'] as string | null),
        daysLeft: left,
        daysLeftText: expiresOn ? formatDaysLeft(left) : '长期',
        lowStock: minStock > 0 && remaining < minStock,
        leadDays: leadDaysFor(r),
      };
    });

    /**
     * 分组与排序是**互相独立**的两件事：
     *   --group <n>  按分类→子类→标签展开到第 n 层（默认 1，0 = 不分组）
     *   --sort <字段> 组内怎么排；默认为「手动顺序」，也就是拖动固定下来的顺序
     */
    const levels = num(args, 'group') ?? 1;
    const sortField = (str(args, 'sort') ?? 'manual') as SortField;
    const validSort = SORT_FIELDS.map((f) => f.key);
    if (!validSort.includes(sortField)) {
      throw new ArgError(`排序字段 "${sortField}" 不存在。可用: ${validSort.join(' / ')}`);
    }
    if (levels < 0 || levels > 3) throw new ArgError('--group 只能是 0~3');

    const total = list.length;
    const expiring = num(args, 'expiring');
    if (expiring !== undefined) {
      list = list.filter((x) => x.daysLeft !== null && x.daysLeft <= expiring);
    }

    // sort_order 是内部的，但命令行里给它一个可见的位置编号更有用
    const seqOf = new Map<string, number>();
    [...list]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .forEach((r, i) => seqOf.set(r.uuid, i + 1));

    const limit = num(args, 'limit');
    const truncated = limit !== undefined && limit > 0 && list.length > limit;

    if (out.json) {
      const payload = list.slice(0, truncated ? limit! : list.length).map((r) => ({ ...r, seq: seqOf.get(r.uuid) }));
      emitJson({
        workspaceId: entry.id,
        workspaceName: entry.name,
        count: payload.length,
        total,
        truncated,
        grouped: levels > 0 ? levels : 0,
        sortedBy: sortField,
        items: payload,
      });
      return EXIT.OK;
    }

    if (list.length === 0) {
      write(total === 0 ? '没有匹配的物品。' : `匹配 ${total} 条，但都被筛选条件排除了。`);
      return EXIT.OK;
    }

    const colsOf = (rows: typeof list): Col<(typeof list)[number]>[] => {
      // 默认状态（手动顺序）下把位置号显出来，方便对着它排序
      const cols: Col<(typeof list)[number]>[] = [
        { title: '序', get: (r) => String(seqOf.get(r.uuid) ?? ''), align: 'right', max: 4 },
        { title: '', get: (r) => (r.lowStock ? '○' : ' '), max: 1 },
        { title: '名称', get: (r) => r.name + (r.isPrescription ? ' Rx' : ''), max: 40 },
        { title: '品牌', get: (r) => r.brand, max: 14 },
        { title: '型号', get: (r) => r.model, max: 18 },
        { title: '位置', get: (r) => [r.room, r.container].filter(Boolean).join('/'), max: 22 },
        {
          title: '数量',
          get: (r) => (r.isBulk ? `${r.remaining}/${r.quantity}` : String(r.remaining)),
          align: 'right',
          max: 9,
        },
        { title: '库存组', get: (r) => (r.stockCount > 1 ? `${r.stockCount} 组` : ''), max: 8 },
        { title: '购买', get: (r) => r.purchasedOn, max: 12 },
        { title: '到期', get: (r) => r.expiresOn ?? '长期', max: 12 },
        { title: '剩余时间', get: (r) => r.daysLeftText, max: 14 },
        { title: 'UUID', get: (r) => r.uuid, max: 36 },
      ];
      void rows;
      return cols;
    };

    if (levels === 0) {
      // 不分组：整体按选定字段排（手动顺序时就按 sort_order）
      const flat = sortItems(list as never[], sortField) as unknown as typeof list;
      printTable(truncated ? flat.slice(0, limit!) : flat, colsOf(flat));
    } else {
      const tree = buildTree(list as never[], {
        levels,
        sort: sortField,
        // 组顺序存在工作区注册表里；命令行读它，让输出与界面一致
        order: entry.groupOrder ?? {},
      });

      const printNode = (node: (typeof tree.nodes)[number], depth: number): void => {
        const indent = 2 + depth * 2;
        const meta: string[] = [`${node.count} 项`];
        if (node.expired) meta.push(`${node.expired} 已过期`);
        if (node.soon) meta.push(`${node.soon} ${SOON_DAYS} 天内`);
        if (node.longTerm) meta.push(`${node.longTerm} 长期`);
        if (node.warranty) meta.push(`${node.warranty} 过保`);
        if (node.pinned) meta.push('置顶·不可拖动');

        printSection(
          `${'· '.repeat(depth)}${node.label}${node.pinned ? '（未分类）' : ''}`,
          meta.join(' · '),
        );
        if (node.items.length > 0) {
          const rows = node.items as unknown as typeof list;
          printTable(truncated ? rows.slice(0, limit!) : rows, colsOf(rows), { indent });
        }
        for (const c of node.children) printNode(c as never, depth + 1);
      };

      for (const node of tree.nodes) printNode(node as never, 0);
    }

    if (truncated) write(`… 共 ${total} 条，已按 --limit 截断`);
    if (!bool(args, 'quiet')) {
      const notes: string[] = [];
      notes.push(
        sortField === 'manual'
          ? '按「手动顺序」排（序 = 位置号，可用 item reorder 调整）'
          : `按「${sortFieldDef(sortField).label}」排（默认状态才可拖动，正在排序时不可拖）`,
      );
      if (list.some((r) => r.lowStock)) notes.push('○ 表示剩余低于最低库存');
      if (list.some((r) => r.category === '')) notes.push('有未分类的物品 —— 分组页会置顶提醒');
      write(`\n${notes.join('　')}`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/**
 * `item reorder` —— 把一组物品按给定顺序固定下来。
 *
 * 这就是界面上「拖动」落库的那一步。顺序只在**默认状态**（未开启排序）下生效。
 */
/**
 * `item extra` —— 补充信息的读写。
 *
 * 位置 / 规格 / 备注来自真实列，自定义字段来自 `extra_json`；
 * 这里合成一个扁平对象呈现，让用命令行的人不必关心某个键存在哪。
 * 写的时候按同一张映射表分流：属于真实列的回真实列，
 * 否则进 JSON —— 位置要参与分组、规格要参与搜索，塞进 JSON 就全废了。
 */
const EXTRA_REAL: Record<string, string> = {
  location: 'location',
  // 「位置」在库里是 room + container 两列，命令行里拆开更明确
  room: 'room',
  container: 'container',
  spec: 'spec',
  notes: 'notes',
};

function cmdItemExtra(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const key = args._[0];
  if (!key) {
    throw new ArgError(
      '用法: item extra <物品> [<字段> <值>]\n' + '  item extra 空调\n  item extra 空调 滤网型号 M8R-FLP',
    );
  }

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  try {
    const item = findItem(db, key);
    const uuid = String(item['uuid']);

    // ── 读 ──
    const readAll = (): { fields: [string, string][]; custom: Record<string, string> } => {
      const row = selectOne(db, 'items', 'uuid = ?', [uuid], { includeInternal: true }) ?? item;
      const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
      return {
        fields: [
          ['位置', [s(row['room']), s(row['container'])].filter(Boolean).join(' / ')],
          ['规格', s(row['spec'])],
          ['备注', s(row['notes'])],
        ],
        custom: parseExtra(s(row['extra_json'])),
      };
    };

    const setArg = str(args, 'set');
    const fieldName = args._[1];
    const fieldValue = args._[2];

    if (bool(args, 'dryRun') && (setArg !== undefined || fieldName !== undefined)) {
      const preview = setArg !== undefined ? parseExtra(setArg) : { [String(fieldName)]: String(fieldValue ?? '') };
      if (out.json) emitJson({ dryRun: true, workspaceId: entry.id, wouldSet: preview });
      else {
        write(`将把「${String(item['name'])}」的补充信息改为：`);
        for (const [k, v] of Object.entries(preview)) write(`  ${k} = ${v === '' ? '(删除)' : v}`);
      }
      return EXIT.OK;
    }

    // ── 整份替换 ──
    if (setArg !== undefined) {
      const patch = parseExtra(setArg);
      updateRow(db, 'items', uuid, { extra_json: serializeExtra(patch) });
      const after = readAll();
      if (out.json) emitJson({ workspaceId: entry.id, uuid, ...after });
      else writeExtra(after, String(item['name']));
      return EXIT.OK;
    }

    // ── 设一个字段 ──
    if (fieldName !== undefined) {
      const value = fieldValue ?? '';
      const real = EXTRA_REAL[fieldName];

      if (fieldName === 'location') {
        throw new ArgError('「位置」在库里分两列，请用 `item extra <物品> room <房间>` 与 `... container <柜格>`');
      }

      if (real) {
        updateRow(db, 'items', uuid, { [real]: value });
      } else {
        // 自定义字段：空值 = 删掉这个键
        const merged = mergeExtra(String(item['extra_json'] ?? ''), { [fieldName]: value });
        updateRow(db, 'items', uuid, { extra_json: merged });
      }

      const after = readAll();
      if (out.json) emitJson({ workspaceId: entry.id, uuid, ...after });
      else {
        write(value === '' ? `已删除字段「${fieldName}」` : `已设置「${fieldName}」= ${value}`);
      }
      return EXIT.OK;
    }

    // ── 查看 ──
    const data = readAll();
    if (out.json) emitJson({ workspaceId: entry.id, uuid, name: String(item['name']), ...data });
    else writeExtra(data, String(item['name']));
    return EXIT.OK;
  } finally {
    db.close();
  }
}

function writeExtra(
  data: { fields: [string, string][]; custom: Record<string, string> },
  name: string,
): void {
  write(`${name} —— 补充信息`);
  printTable(data.fields, [
    { title: '字段', get: (r) => r[0], max: 8 },
    { title: '值', get: (r) => r[1] || '—', max: 60 },
  ]);
  const keys = Object.keys(data.custom).sort((a, b) => a.localeCompare(b, 'zh'));
  if (keys.length > 0) {
    write('\n这件东西自己的字段：');
    printTable(keys, [
      { title: '字段', get: (k) => k, max: 24 },
      { title: '值', get: (k) => data.custom[k] ?? '', max: 60 },
    ]);
  } else {
    write('\n（没有自定义字段。用 `item extra <物品> <字段> <值>` 添加）');
  }
}

function cmdItemReorder(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const keys = args._;
  if (keys.length === 0) {
    throw new ArgError(
      '用法: item reorder <物品> [更多...] [--after <物品>]\n' +
        '省略 --after 时移到最前；给出 --after 时插到那一条之后。',
    );
  }

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  try {
    const afterKey = str(args, 'after');

    // 解析成 uuid，顺便验证都能找到
    const uuids = keys.map((k) => String(findItem(db, k)['uuid']));

    // 目标顺序 = 现有顺序去掉这些，再把它们按给定次序插进去
    const all = selectWhere(db, 'items', `${TOP_LEVEL} ORDER BY sort_order ASC, rowid ASC`, []);
    let ordered = all.map((r) => String(r['uuid'])).filter((u) => !uuids.includes(u));

    if (afterKey) {
      const anchor = String(findItem(db, afterKey)['uuid']);
      const at = ordered.indexOf(anchor);
      if (at < 0) throw new ArgError(`--after 指向的物品不在顶层列表里: ${afterKey}`);
      ordered = [...ordered.slice(0, at + 1), ...uuids, ...ordered.slice(at + 1)];
    } else {
      // 没给 --after 就是「移到最前」—— 这也是最常用的意图
      // （「移到末尾」用 --after 指最后一条即可，不用另开一个选项）
      ordered = [...uuids, ...ordered];
    }

    if (bool(args, 'dryRun')) {
      if (out.json) emitJson({ dryRun: true, wouldReorder: uuids.length, order: ordered });
      else write(`将固定 ${uuids.length} 条物品的位置`);
      return EXIT.OK;
    }

    const n = applyItemOrder(db, ordered);

    if (out.json) emitJson({ reordered: uuids.length, total: n, order: ordered });
    else {
      write(`已固定 ${uuids.length} 条物品的位置（共重排 ${n} 条）`);
      write('这个顺序只在默认状态下生效；开启排序后按排序字段走。');
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

function cmdItemShow(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const key = args._[0] ?? str(args, 'id');
  if (!key) throw new ArgError('用法: item show <名称|uuid|标识>');

  const db = openDatabase(workspaceDbPath(dataDir, entry), { readOnly: true });
  try {
    const item = findItem(db, key);
    const uuid = String(item['uuid']);
    const remaining = Number(item['remaining'] ?? 0);
    const minStock = Number(item['min_stock'] ?? 0);
    const isBulk = item['is_bulk'] === 'true';

    // 到期情况：只有「已过期 / 还有多久 / 长期」三种说法，不再分级
    const expiry = expiriesForItem(item);

    // 一组库存
    const stockRows = isBulk ? stocksOf(db, uuid) : [];
    const { stocks, totals } = toBulkStocks(stockRows);

    const moveRows = db
      .prepare('SELECT * FROM stock_moves WHERE item_uuid = ? ORDER BY moved_on DESC, created_at DESC')
      .all(uuid) as Record<string, unknown>[];
    const moves = moveRows.map((m) => ({
      uuid: String(m['uuid']),
      movedOn: String(m['moved_on']),
      qtyDelta: Number(m['qty_delta']),
      reason: String(m['reason']),
      reasonLabel: ENUMS['move_reason']?.find((e) => e.key === String(m['reason']))?.label ?? String(m['reason']),
      notes: m['notes'] === null ? '' : String(m['notes']),
    }));

    const data = {
      workspaceId: entry.id,
      item,
      expiry,
      expiryLabel:
        expiry.length === 0
          ? '长期'
          : expiry.some((e) => e.alertKind === 'expire' && e.expired)
            ? '已过期'
            : expiry.some((e) => e.alertKind === 'warranty' && e.expired)
              ? '已过保'
              : '在有效期内',
      lowStock: minStock > 0 && remaining < minStock,
      stocks,
      stockTotals: stocks.length > 0 ? totals : null,
      moves,
    };

    if (out.json) {
      emitJson(data);
      return EXIT.OK;
    }

    const badges = [
      isBulk ? (stocks.length > 1 ? `批量 · ${stocks.length} 组库存` : '批量') : '',
      item['is_prescription'] === 'true' ? 'Rx处方药' : '',
      data.lowStock ? '○低于最低库存' : '',
    ].filter(Boolean);

    write(`${String(item['name'])}${badges.length ? '  ' + badges.join('  ') : ''}`);
    printKv(itemFacts(item));
    if (item['notes']) write(`备注        ${String(item['notes'])}`);

    // ── 一组库存 ──
    if (stocks.length > 0) {
      printSection('一组库存', `${stocks.length} 组 · 合计 ${totals.remaining}/${totals.quantity}`);
      printTable(stocks, [
        { title: '组', get: (s) => `#${s.index}`, max: 4 },
        { title: '数量', get: (s) => `${s.remaining}/${s.quantity}`, align: 'right', max: 9 },
        { title: '购买', get: (s) => s.purchasedOn, max: 12 },
        { title: '到期', get: (s) => s.expiresOn ?? '长期', max: 12 },
        {
          title: '剩余时间',
          get: (s) => (s.expiresOn ? formatDaysLeft(s.daysLeft) : '长期'),
          max: 14,
        },
        { title: '单价', get: (s) => (s.unitPriceYuan ? `¥${s.unitPriceYuan}` : ''), max: 10 },
        { title: '渠道', get: (s) => s.store, max: 16 },
        { title: '库存UUID', get: (s) => s.uuid, max: 36 },
      ]);
      write('  消耗时按「先到期先出」从这个列表顶部扣减。');
    }

    printSection('到期情况', expiry.length === 0 ? '长期' : `${expiry.length} 项`);
    if (expiry.length === 0) {
      write('  长期 —— 没有到期日，不参与到期提示。');
    } else {
      printTable(expiry, [
        { title: '类型', get: (e) => e.kind, max: 14 },
        { title: '到期日', get: (e) => e.expiresOn, max: 12 },
        { title: '剩余', get: (e) => e.daysLeftText, max: 16 },
        { title: '状态', get: (e) => (e.expired ? (e.alertKind === 'warranty' ? '已过保' : '已过期') : '在有效期内'), max: 12 },
      ]);
    }

    if (moves.length > 0) {
      printSection('出入库流水', `${moves.length} 条`);
      printTable(moves.slice(0, 20), [
        { title: '日期', get: (m) => m.movedOn },
        { title: '变化', get: (m) => (m.qtyDelta > 0 ? `+${m.qtyDelta}` : String(m.qtyDelta)), align: 'right' },
        { title: '原因', get: (m) => m.reasonLabel },
        { title: '备注', get: (m) => m.notes, max: 40 },
      ]);
      if (moves.length > 20) write(`… 共 ${moves.length} 条`);
    }

    write(`\n提醒提前量 ${leadDaysFor(item)} 天（按分类「${categoryLabel(String(item['category'] ?? ''))}」）`);
    return EXIT.OK;
  } finally {
    db.close();
  }
}

function cmdItemUpdate(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const key = args._[0] ?? str(args, 'id');
  if (!key) throw new ArgError('用法: item update <uuid|code> [字段选项]');

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  try {
    const item = findItem(db, key);
    const values = itemValuesFromArgs(args, true);
    delete values['code'];

    for (const j of readJsonInputs(args)) Object.assign(values, normalizeJsonKeys(j));
    delete values['uuid'];

    if (Object.keys(values).length === 0) {
      throw new ArgError('没有提供任何要修改的字段。用 --help 查看可用字段。');
    }
    if (values['category']) {
      const allowed = (ENUMS['item_category'] ?? []).map((e) => e.key);
      if (!allowed.includes(values['category'])) {
        throw new ArgError(`分类 "${values['category']}" 不存在。可用: ${allowed.join(', ')}`);
      }
    }
    if (values['status']) {
      const allowed = (ENUMS['item_status'] ?? []).map((e) => e.key);
      if (!allowed.includes(values['status'])) {
        throw new ArgError(`状态 "${values['status']}" 不存在。可用: ${allowed.join(', ')}`);
      }
    }

    // 改了数量却没改剩余、且剩余大于新数量时给明确提示
    if (values['quantity'] !== undefined) {
      const newQty = Number(values['quantity']);
      const curRemaining = Number(item['remaining'] ?? 0);
      if (values['remaining'] === undefined && curRemaining > newQty) {
        values['remaining'] = String(newQty);
        log(`提示: 剩余 ${curRemaining} 大于新数量 ${newQty}，已同步调整为 ${newQty}`);
      }
    }

    if (bool(args, 'dryRun')) {
      if (out.json) emitJson({ dryRun: true, wouldUpdate: { uuid: item['uuid'], fields: values } });
      else {
        write(`将修改「${String(item['name'])}」的 ${Object.keys(values).length} 个字段：`);
        for (const [k, v] of Object.entries(values)) write(`  ${k} = ${v ?? '(清空)'}`);
      }
      return EXIT.OK;
    }

    const updated = updateRow(db, 'items', String(item['uuid']), values);
    if (out.json) {
      emitJson({ workspaceId: entry.id, item: updated });
      return EXIT.OK;
    }
    write(`已更新「${String(updated?.['name'])}」：`);
    for (const [k, v] of Object.entries(values)) write(`  ${k} = ${v ?? '(清空)'}`);
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/** 领用 / 丢弃 / 过期处理：改剩余数量并记一条流水 */
function cmdItemConsume(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const key = args._[0] ?? str(args, 'id');
  const qty = num(args, 'qty') ?? 1;
  const reason = str(args, 'reason') ?? 'consume';

  if (!key) throw new ArgError('用法: item consume <名称|uuid|标识> [--qty N] [--reason consume|discard|expired_dispose]');
  if (!Number.isInteger(qty) || qty <= 0) throw new ArgError('--qty 必须是正整数');
  const allowed = (ENUMS['move_reason'] ?? []).map((e) => e.key);
  if (!allowed.includes(reason)) throw new ArgError(`原因 "${reason}" 不存在。可用: ${allowed.join(', ')}`);

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  try {
    const item = findItem(db, key);
    const remaining = Number(item['remaining'] ?? 0);
    const isBulk = item['is_bulk'] === 'true';
    const nested = isBulk && hasStocks(db, String(item['uuid']));
    // 非批量物品是一次性的：不管传多少，一次就是「用掉这一件」
    const take = isBulk ? qty : Math.min(qty, remaining);
    if (take > remaining) throw new ArgError(`「${String(item['name'])}」剩余 ${remaining}，不足以扣减 ${take}`);

    const newRemaining = remaining - take;
    // 归零时按原因落一个终态
    const terminal =
      newRemaining === 0
        ? reason === 'discard'
          ? 'discarded'
          : reason === 'expired_dispose'
            ? 'expired_disposed'
            : 'consumed'
        : 'in_use';

    if (bool(args, 'dryRun')) {
      if (out.json) {
        emitJson({
          dryRun: true,
          would: { item: key, qty: take, reason, remainingAfter: newRemaining, status: terminal, isBulk, nested },
        });
      } else {
        write(
          `将把「${String(item['name'])}」扣减 ${take}，剩余 ${newRemaining}，状态 ${terminal}` +
            (nested ? '（按先到期先出，从各组库存依次扣）' : ''),
        );
      }
      return EXIT.OK;
    }

    const taken: { uuid: string; taken: number }[] = [];
    transaction(db, () => {
      if (nested) {
        // 有「一组库存」：按先到期先出从各组扣，父项数量由子行汇总刷新
        for (const t of consumeFromStocks(db, String(item['uuid']), take)) {
          taken.push(t);
          insertRow(db, 'stock_moves', {
            item_uuid: t.uuid,
            moved_on: today(),
            qty_delta: String(-t.taken),
            reason,
            notes: str(args, 'notes') ?? null,
          });
        }
        refreshParentTotals(db, String(item['uuid']));
      } else {
        updateRow(db, 'items', String(item['uuid']), { remaining: String(newRemaining), status: terminal });
        insertRow(db, 'stock_moves', {
          item_uuid: String(item['uuid']),
          moved_on: today(),
          qty_delta: String(-take),
          reason,
          notes: str(args, 'notes') ?? null,
        });
      }
    });

    if (out.json) {
      emitJson({
        itemUuid: item['uuid'],
        name: item['name'],
        consumed: take,
        reason,
        remaining: newRemaining,
        status: terminal,
        isBulk,
        fromStocks: taken.length > 0 ? taken : null,
      });
      return EXIT.OK;
    }
    // 普通物品只有「消耗」这一种说法，用「领用」会让人以为还有数量概念
    const reasonLabel =
      isBulk || reason !== 'consume'
        ? ENUMS['move_reason']?.find((e) => e.key === reason)?.label ?? reason
        : '消耗';
    write(`已${reasonLabel}「${String(item['name'])}」× ${take}，剩余 ${newRemaining}`);
    if (taken.length > 1) {
      write(`  从 ${taken.length} 组库存扣减：${taken.map((t, i) => `#${i + 1} 扣 ${t.taken}`).join('，')}`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/**
 * `item stock` —— 管理批量物品的「一组库存」。
 *
 * 库存条目就是挂在这件物品下的子行，每条自带数量与到期日。
 * 只有开启「批量」的物品才有意义。
 */
function cmdItemStock(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const action = args._[0] ?? 'list';
  const key = args._[1] ?? str(args, 'id');

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  try {
    if (action === 'rm') {
      if (!key) throw new ArgError('用法: item stock rm <库存UUID> --yes');
      const direct = selectOne(db, 'items', 'uuid = ? AND parent_uuid IS NOT NULL AND parent_uuid <> ?', [key, ''], {
        includeInternal: true,
      });
      if (!direct) throw new NotFoundError(`库存条目 ${key}`);
      if (!bool(args, 'yes')) {
        throw new ArgError(`删除一条库存条目需要 --yes 确认（剩余 ${String(direct['remaining'])}）。`);
      }
      if (bool(args, 'dryRun')) {
        if (out.json) emitJson({ dryRun: true, would: { removeStock: key } });
        else write(`将删除库存条目 ${key}`);
        return EXIT.OK;
      }
      removeStock(db, key);
      if (out.json) emitJson({ removed: true, uuid: key });
      else write(`已删除库存条目 ${key}`);
      return EXIT.OK;
    }

    if (!key) throw new ArgError('用法: item stock <list|add|rm> <物品> [选项]');
    const item = findItem(db, key);
    const parentUuid = String(item['uuid']);

    if (item['is_bulk'] !== 'true') {
      throw new ArgError(
        `「${String(item['name'])}」没有开启「批量」，没有「一组库存」。\n先用 item update ${key} --bulk 开启。`,
      );
    }

    if (action === 'list') {
      const { stocks, totals } = toBulkStocks(stocksOf(db, parentUuid));
      if (out.json) {
        emitJson({ itemUuid: parentUuid, name: item['name'], totals, count: stocks.length, stocks });
        return EXIT.OK;
      }
      write(`${String(item['name'])}  ——  ${stocks.length} 组库存，合计 ${totals.remaining}/${totals.quantity}`);
      if (stocks.length === 0) {
        write('还没有配置库存条目：这件批量物品直接用自己的数量与到期日。');
        write(`加一条：dsh-inv item stock add ${key} --qty 10 --expires-on 2027-03-31`);
        return EXIT.OK;
      }
      printTable(stocks, [
        { title: '组', get: (s) => `#${s.index}`, max: 4 },
        { title: '数量', get: (s) => `${s.remaining}/${s.quantity}`, align: 'right', max: 9 },
        { title: '购买', get: (s) => s.purchasedOn, max: 12 },
        { title: '到期', get: (s) => s.expiresOn ?? '长期', max: 12 },
        { title: '剩余时间', get: (s) => (s.expiresOn ? formatDaysLeft(s.daysLeft) : '长期'), max: 14 },
        { title: '渠道', get: (s) => s.store, max: 16 },
        { title: 'UUID', get: (s) => s.uuid, max: 36 },
      ]);
      return EXIT.OK;
    }

    if (action === 'add') {
      const quantity = num(args, 'qty') ?? 1;
      if (!Number.isInteger(quantity) || quantity < 0) throw new ArgError('--qty 必须是非负整数');

      const values: Record<string, string | null> = {
        quantity: String(quantity),
        remaining: String(num(args, 'remaining') ?? quantity),
      };
      if (bool(args, 'longTerm')) {
        values['expires_on'] = null;
      } else {
        const expiresOn = str(args, 'expiresOn');
        const expiresYm = str(args, 'expiresYm');
        if (expiresOn) values['expires_on'] = expiresOn;
        else if (expiresYm) values['expires_ym'] = expiresYm;
      }
      const purchasedOn = str(args, 'purchasedOn');
      if (purchasedOn) values['purchased_on'] = purchasedOn;
      const unitPrice = str(args, 'unitPrice');
      if (unitPrice !== undefined) {
        const cents = yuanToCents(unitPrice);
        if (cents === null) throw new ArgError(`--unit-price 不是合法金额: ${unitPrice}`);
        values['unit_price_cents'] = String(cents);
        values['amount_cents'] = String(cents * quantity);
      }
      const store = str(args, 'store');
      if (store) values['store'] = store;
      const notes = str(args, 'notes');
      if (notes) values['notes'] = notes;

      if (bool(args, 'dryRun')) {
        if (out.json) emitJson({ dryRun: true, would: { addStock: parentUuid, values } });
        else write(`将为「${String(item['name'])}」新增一组库存：数量 ${quantity}`);
        return EXIT.OK;
      }

      const row = addStock(db, item, values);
      const after = toBulkStocks(stocksOf(db, parentUuid));
      if (out.json) {
        emitJson({
          itemUuid: parentUuid,
          stockUuid: row['uuid'],
          totals: after.totals,
          stockCount: after.stocks.length,
        });
        return EXIT.OK;
      }
      write(
        `已新增一组库存：数量 ${quantity}，现在共 ${after.stocks.length} 组，合计 ${after.totals.remaining}/${after.totals.quantity}`,
      );
      return EXIT.OK;
    }

    throw new ArgError(`未知的 stock 子命令: ${action}。可用: list / add / rm`);
  } finally {
    db.close();
  }
}

function cmdItemRm(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const keys = args._;

  if (keys.length === 0) throw new ArgError('用法: item rm <uuid|code> [更多...] --yes');
  if (!bool(args, 'yes')) {
    throw new ArgError(`删除物品记录会一并删掉它的出入库流水，需要 --yes 确认。（共 ${keys.length} 条）`);
  }

  const db = openDatabase(workspaceDbPath(dataDir, entry));
  const done: { uuid: string; code: string; name: string }[] = [];
  try {
    for (const key of keys) {
      const item = findItem(db, key);
      const info = { uuid: String(item['uuid']), code: String(item['code']), name: String(item['name']) };
      if (!bool(args, 'dryRun')) deleteRow(db, 'items', info.uuid);
      done.push(info);
    }
  } finally {
    db.close();
  }

  if (out.json) {
    emitJson({ dryRun: bool(args, 'dryRun'), removed: done });
    return EXIT.OK;
  }
  write(bool(args, 'dryRun') ? `将删除 ${done.length} 条记录：` : `已删除 ${done.length} 条记录：`);
  for (const d of done) write(`  ${d.code}  ${d.name}`);
  return EXIT.OK;
}

/**
 * 一键清理：删掉「非批量 且 剩余为 0」的记录。
 *
 * 这些是"已经用掉的一次性物品"，留着只会让列表越来越长。
 * 批量物品即使剩余为 0 也不动 —— 它可能还需要补货或留作记录。
 */
function cmdItemPurge(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const db = openDatabase(workspaceDbPath(dataDir, entry));

  try {
    const rows = selectWhere(db, 'items', `is_bulk = 0 AND remaining <= 0`, []);

    if (rows.length === 0) {
      if (out.json) emitJson({ workspaceId: entry.id, purged: 0, items: [] });
      else write('没有可清理的记录（非批量且剩余为 0 的物品）。');
      return EXIT.OK;
    }

    const list = rows.map((r) => ({
      uuid: String(r['uuid']),
      code: String(r['code'] ?? ''),
      name: String(r['name'] ?? ''),
      category: String(r['category'] ?? ''),
      location: [r['room'], r['container']].filter(Boolean).join(' / '),
      expiresOn: r['expires_on'] ? String(r['expires_on']) : null,
    }));

    if (bool(args, 'dryRun')) {
      if (out.json) emitJson({ dryRun: true, wouldPurge: list.length, items: list });
      else {
        write(`将清理 ${list.length} 条「已消耗完」的记录：`);
        printTable(list, [
          { title: '编码', get: (r) => r.code, max: 14 },
          { title: '名称', get: (r) => r.name, max: 40 },
          { title: '位置', get: (r) => r.location, max: 24 },
        ]);
        write('\n（去掉 --dry-run 即执行。批量物品不会被清理。）');
      }
      return EXIT.OK;
    }

    if (!bool(args, 'yes')) {
      throw new ArgError(
        `将删除 ${list.length} 条「非批量且剩余为 0」的记录，需要 --yes 确认。\n` +
          `先看清单：dsh-inv item purge --dry-run`,
      );
    }

    transaction(db, () => {
      for (const it of list) deleteRow(db, 'items', it.uuid);
    });

    if (out.json) emitJson({ workspaceId: entry.id, purged: list.length, items: list });
    else {
      write(`已清理 ${list.length} 条已消耗完的记录：`);
      for (const it of list) write(`  ${it.code}  ${it.name}`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────
// 提醒
// ─────────────────────────────────────────────────────────────

/**
 * `alert list` —— 到期清单。
 *
 * v3 取消了「紧急 / 临期 / 关注」这套分级，改成**按分类分组、组内按到期日升序**。
 * 顺序本身就表达紧迫度：排在最前面的就是最该处理的。
 * 「长期」物品（没有到期日）单独归到每组末尾，可加 --hide-long-term 隐藏。
 */
function cmdAlertList(args: ParsedArgs, dataDir: string): number {
  const within = num(args, 'within');
  const categoryFilter = str(args, 'category');
  const hideLongTerm = bool(args, 'hideLongTerm');
  const onlyExpired = bool(args, 'expired');

  const entries = str(args, 'ws') ? [requireWorkspace(dataDir, str(args, 'ws')!)] : listWorkspaces(dataDir);

  if (entries.length === 0) {
    if (out.json) emitJson({ count: 0, workspaces: [], groups: [] }, ['没有工作区']);
    else write('没有工作区。');
    return EXIT.OK;
  }

  const results = entries.map((e) => ({ entry: e, overview: computeOverview(e, workspaceDbPath(dataDir, e)) }));

  const flatGroups = results.flatMap((r) =>
    r.overview.groups
      .filter((g) => !categoryFilter || g.key === categoryFilter)
      .map((g) => ({
        workspaceId: r.entry.id,
        workspaceName: r.entry.name,
        key: g.key,
        label: g.label,
        entries: g.entries
          .filter((e) => within === undefined || e.daysLeft <= within)
          .filter((e) => !onlyExpired || e.expired)
          .map((e) => ({
            expiryKind: e.kind,
            /** 这条算「过期」还是「过保」 */
            alertKind: e.alertKind,
            expiresOn: e.expiresOn,
            daysLeft: e.daysLeft,
            daysLeftText: e.daysLeftText,
            expired: e.expired,
            itemUuid: String(e.item['uuid'] ?? ''),
            itemName: String(e.item['name'] ?? ''),
            category: String(e.item['category'] ?? ''),
            location: [e.item['room'], e.item['container']].filter(Boolean).join(' / '),
            remaining: Number(e.item['remaining'] ?? 0),
            isBulk: e.item['is_bulk'] === 'true',
          })),
        longTerm: hideLongTerm
          ? []
          : g.longTerm.map((l) => ({
              itemUuid: String(l.item['uuid'] ?? ''),
              itemName: String(l.item['name'] ?? ''),
              category: String(l.item['category'] ?? ''),
              location: [l.item['room'], l.item['container']].filter(Boolean).join(' / '),
              remaining: Number(l.item['remaining'] ?? 0),
            })),
      }))
      .filter((g) => g.entries.length > 0 || g.longTerm.length > 0),
  );

  const allEntries = flatGroups.flatMap((g) => g.entries);
  const lowStock = results.flatMap((r) =>
    lowStockItems(
      (() => {
        const db = openDatabase(workspaceDbPath(dataDir, r.entry), { readOnly: true });
        try {
          return selectWhere(db, 'items', `${TOP_LEVEL} AND status IN ('in_stock','in_use')`, []);
        } finally {
          db.close();
        }
      })(),
    ).map((x) => ({
      workspaceId: r.entry.id,
      workspaceName: r.entry.name,
      itemUuid: String(x.item['uuid'] ?? ''),
      itemName: String(x.item['name'] ?? ''),
      remaining: x.remaining,
      minStock: x.minStock,
      shortfall: x.shortfall,
    })),
  );

  const counts = {
    // 只数「过期」那类（保质期 / 开封后有效期）；过保单独统计，不并进来
    expired: allEntries.filter((e) => e.alertKind === 'expire' && e.expired).length,
    soon: allEntries.filter((e) => e.alertKind === 'expire' && !e.expired && e.daysLeft <= SOON_DAYS).length,
    /** 已过保的条目数。不进 headline、不进高亮 */
    warrantyExpired: allEntries.filter((e) => e.alertKind === 'warranty' && e.expired).length,
    dated: allEntries.length,
    longTerm: flatGroups.reduce((n, g) => n + g.longTerm.length, 0),
    lowStock: lowStock.length,
  };

  if (out.json) {
    emitJson({
      generatedAt: new Date().toISOString(),
      today: today(),
      workspaceCount: entries.length,
      count: allEntries.length,
      counts,
      headline: results.map((r) => `${r.entry.name}: ${r.overview.headline}`).join(' | '),
      groups: flatGroups,
      lowStock,
    });
    return EXIT.OK;
  }

  // ── 分组输出 ──
  let printed = false;
  for (const g of flatGroups) {
    printed = true;
    const title = entries.length > 1 ? `${g.workspaceName} · ${g.label}` : g.label;
    // 过期 / 15 天内只数「过期」那类；过保单独标，用不同的说法
    const expiredN = g.entries.filter((e) => e.alertKind === 'expire' && e.expired).length;
    const soonN = g.entries.filter((e) => e.alertKind === 'expire' && !e.expired && e.daysLeft <= SOON_DAYS).length;
    const warrantyN = g.entries.filter((e) => e.alertKind === 'warranty' && e.expired).length;
    const meta = [`${g.entries.length} 项`];
    if (expiredN) meta.push(`${expiredN} 已过期`);
    if (soonN) meta.push(`${soonN} ${SOON_DAYS} 天内`);
    if (warrantyN) meta.push(`${warrantyN} 过保`);
    printSection(title, meta.join(' · '));

    if (g.entries.length > 0) {
      printTable(
        g.entries,
        [
          { title: '类型', get: (e) => e.expiryKind, max: 14 },
          { title: '名称', get: (e) => e.itemName, max: 40 },
          { title: '到期日', get: (e) => e.expiresOn, max: 12 },
          { title: '剩余时间', get: (e) => e.daysLeftText, max: 14 },
          { title: '状态', get: (e) => (e.expired ? (e.alertKind === 'warranty' ? '已过保' : '已过期') : ''), max: 8 },
          { title: '数量', get: (e) => (e.isBulk ? String(e.remaining) : '1'), align: 'right', max: 6 },
          { title: '位置', get: (e) => e.location, max: 24 },
          { title: '物品UUID', get: (e) => e.itemUuid, max: 36 },
        ],
        { indent: 2 },
      );
    }

    if (g.longTerm.length > 0) {
      const names = g.longTerm.map((l) => l.itemName).join('、');
      write(`  长期：${names}`);
    }
  }

  if (!printed) {
    write(
      categoryFilter
        ? `分类「${categoryLabel(categoryFilter)}」下没有需要关注的物品。`
        : '没有需要关注的物品 —— 一切都好。',
    );
  }

  if (lowStock.length > 0) {
    printSection('○ 待补货', `${lowStock.length} 项`);
    printTable(
      lowStock,
      [
        { title: '名称', get: (r) => r.itemName, max: 40 },
        { title: '剩余', get: (r) => String(r.remaining), align: 'right' },
        { title: '下限', get: (r) => String(r.minStock), align: 'right' },
        { title: '缺', get: (r) => String(r.shortfall), align: 'right' },
      ],
      { indent: 2 },
    );
  }

  return EXIT.OK;
}

/**
 * `group list` —— 按分类分组、组内按到期时间排序的完整清单。
 * 与 alert list 的区别：这个列出**全部**在用物品，不只是需要关注的。
 */
/**
 * `column list` —— 这张表有哪些列、现在开着哪些。
 *
 * 「物品」「到期时间」标成 required，让用命令行的人也知道关不掉。
 */
function cmdColumnList(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));
  const visible = resolveColumns(entry.columns);

  const rows = ITEM_COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    on: visible.includes(c.key),
    lock: Boolean(c.lock),
    hint: c.hint,
  }));

  if (out.json) {
    emitJson({
      workspaceId: entry.id,
      workspaceName: entry.name,
      available: ITEM_COLUMNS,
      locked: LOCKED_COLUMNS,
      visible,
      defaults: DEFAULT_COLUMNS,
      minimal: isMinimal(entry.columns),
      columns: rows,
    });
    return EXIT.OK;
  }

  write(`${entry.name} —— 物品表显示 ${visible.length}/${ITEM_COLUMNS.length} 列`);
  printTable(rows, [
    { title: '', get: (r) => (r.on ? '✓' : '·'), max: 3 },
    { title: 'key', get: (r) => r.key, max: 12 },
    { title: '名称', get: (r) => r.label, max: 12 },
    { title: '必显', get: (r) => (r.lock ? '是' : ''), max: 5 },
    { title: '说明', get: (r) => r.hint, max: 46 },
  ]);
  write('\n「物品」与「到期时间」必须显示 —— 缺了前者不知道给谁到期，');
  write('缺了后者这张表就退化成一个普通清单了。');
  write('界面里也能改：物品页工具栏的「列设置」。');
  return EXIT.OK;
}

/** `column set` —— 直接给列名，或 --default / --show-all */
function cmdColumnSet(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws'));

  let wanted: string[];
  if (bool(args, 'default')) {
    wanted = [...DEFAULT_COLUMNS];
  } else if (bool(args, 'showAll')) {
    wanted = ITEM_COLUMNS.map((c) => c.key);
  } else {
    const keys = args._;
    if (keys.length === 0) {
      throw new ArgError(
        '用法: column set <列> [更多列...]\n' +
          `可用列: ${ITEM_COLUMNS.map((c) => c.key).join(' / ')}\n` +
          '或 column set --default / --show-all',
      );
    }
    const bad = keys.filter((k) => !isColumnKey(k));
    if (bad.length > 0) {
      throw new ArgError(
        `列 "${bad.join('、')}" 不存在。可用: ${ITEM_COLUMNS.map((c) => c.key).join(' / ')}`,
      );
    }
    wanted = keys as string[];
  }

  // 交给 resolveColumns 兜底：锁定列会被补回来，认不出的会被丢掉
  const resolved = resolveColumns(wanted);
  const dropped = wanted.filter((k) => !(resolved as string[]).includes(k));

  if (bool(args, 'dryRun')) {
    if (out.json) emitJson({ dryRun: true, workspaceId: entry.id, wouldShow: resolved });
    else {
      write(`将把「${entry.name}」的物品表设为显示 ${resolved.length} 列：`);
      write(`  ${resolved.join(', ')}`);
    }
    return EXIT.OK;
  }

  updateWorkspacePrefs(dataDir, entry.id, { columns: resolved });

  if (out.json) {
    emitJson({ workspaceId: entry.id, visible: resolved, minimal: isMinimal(resolved) });
    return EXIT.OK;
  }

  write(`「${entry.name}」的物品表现在显示 ${resolved.length} 列：${resolved.join('、')}`);
  const lockedAdded = LOCKED_COLUMNS.filter((k) => !wanted.includes(k));
  if (lockedAdded.length > 0) {
    write(`（${lockedAdded.join('、')} 是必显列，自动补上了）`);
  }
  if (dropped.length > 0) write(`（${dropped.join('、')} 认不出来，已忽略）`);
  return EXIT.OK;
}

function cmdGroupList(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws') ?? args._[0] ?? null);
  const db = openDatabase(workspaceDbPath(dataDir, entry), { readOnly: true });

  try {
    const rows = selectWhere(
      db,
      'items',
      `${TOP_LEVEL} AND status IN ('in_stock','in_use') ORDER BY sort_order ASC, rowid ASC`,
      [],
    );

    const levels = Math.max(1, Math.min(3, num(args, 'levels') ?? entry.groupLevels ?? 1));
    const sortField = (str(args, 'sort') ?? entry.sortField ?? 'manual') as SortField;
    if (!SORT_FIELDS.some((f) => f.key === sortField)) {
      throw new ArgError(`排序字段 "${sortField}" 不存在。可用: ${SORT_FIELDS.map((f) => f.key).join(' / ')}`);
    }

    // 组顺序：命令行传的优先，其次用工作区里存下来的（与界面一致）
    const order: Record<string, string[]> = { ...(entry.groupOrder ?? {}) };
    let orderChanged = false;
    for (const spec of arr(args, 'order')) {
      const eq = spec.indexOf('=');
      if (eq < 0) throw new ArgError(`--order 需要写成 <父路径>=<key,key>，收到: ${spec}`);
      const path = spec.slice(0, eq);
      const keys = spec
        .slice(eq + 1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      order[path] = keys;
      orderChanged = true;
    }

    const tree = buildTree(rows, { levels, sort: sortField, order });

    // --order 顺手存进工作区偏好，下次不带参数也是这个顺序
    if (orderChanged && !bool(args, 'dryRun')) {
      updateWorkspacePrefs(dataDir, entry.id, { groupOrder: order, groupLevels: levels });
    }

    const counts = stockCounts(db);
    const decorate = (r: Row) => {
      const e = expiriesForItem(r);
      const expiresOn = r['expires_on'] ? String(r['expires_on']) : null;
      const remaining = Number(r['remaining'] ?? 0);
      const minStock = Number(r['min_stock'] ?? 0);
      return {
        uuid: String(r['uuid']),
        name: String(r['name'] ?? ''),
        category: r['category'] === null || r['category'] === undefined ? '' : String(r['category']),
        subcategory: r['subcategory'] ?? null,
        brand: r['brand'] ?? null,
        model: r['model'] ?? null,
        tags: r['tags'] ?? null,
        room: r['room'] ?? null,
        container: r['container'] ?? null,
        unit: r['unit'] === null || r['unit'] === undefined ? '' : String(r['unit']),
        sortOrder: Number(r['sort_order'] ?? 0),
        remaining,
        quantity: Number(r['quantity'] ?? 0),
        isBulk: r['is_bulk'] === 'true',
        stockCount: counts.get(String(r['uuid'])) ?? 0,
        lowStock: minStock > 0 && remaining < minStock,
        expiresOn,
        warrantyUntil: r['warranty_until'] ? String(r['warranty_until']) : null,
        spec: r['spec'] ?? null,
        notes: r['notes'] ?? null,
        daysLeft: expiresOn ? (daysUntil(expiresOn) ?? 0) : null,
        daysLeftText: expiresOn ? formatDaysLeft(daysUntil(expiresOn)) : '长期',
        isLongTerm: e.length === 0,
        // `expired` 指的是「过期」那类（保质期 / 开封后有效期）。
        // 别用 e.some(x => x.expired)：那会把过保也算进来，
        // 跟告警计数（只数过期）就对不上了。
        expired: e.some((x) => x.alertKind === 'expire' && x.expired),
        /** 只过保 */
        warrantyExpired: e.some((x) => x.alertKind === 'warranty' && x.expired),
        location: [r['room'], r['container']].filter(Boolean).join(' / '),
      };
    };

    const toJson = (n: (typeof tree.nodes)[number]): unknown => ({
      key: n.key,
      label: n.label,
      path: n.path,
      level: n.level,
      pinned: n.pinned,
      count: n.count,
      expired: n.expired,
      soon: n.soon,
      longTerm: n.longTerm,
      warranty: n.warranty,
      items: n.items.map(decorate),
      children: n.children.map(toJson),
    });

    const data = {
      workspaceId: entry.id,
      workspaceName: entry.name,
      levels: tree.maxLevel,
      requestedLevels: levels,
      sortedBy: sortField,
      dragEnabled: sortField === 'manual',
      total: tree.total,
      uncategorized: uncategorizedCount(rows),
      order,
      groups: tree.nodes.map(toJson),
    };

    if (out.json) {
      emitJson(data);
      return EXIT.OK;
    }

    if (tree.nodes.length === 0) {
      write('没有在用的物品。');
      return EXIT.OK;
    }

    write(
      `${entry.name} —— ${tree.maxLevel} 级分组，组内按${
        sortField === 'manual' ? '手动顺序（可用 item reorder 调整）' : sortFieldDef(sortField).label
      }排`,
    );

    const printNode = (n: (typeof tree.nodes)[number], depth: number): void => {
      const meta: string[] = [`${n.count} 项`];
      if (n.expired) meta.push(`${n.expired} 已过期`);
      if (n.soon) meta.push(`${n.soon} ${SOON_DAYS} 天内`);
      if (n.longTerm) meta.push(`${n.longTerm} 长期`);
      if (n.warranty) meta.push(`${n.warranty} 过保`);
      if (n.pinned) meta.push('置顶·不可拖动');

      printSection(`${'· '.repeat(depth)}${n.label}`, meta.join(' · '));
      if (n.items.length > 0) {
        printTable(
          n.items,
          [
            { title: '序', get: (r) => String(n.items.indexOf(r) + 1), align: 'right', max: 4 },
            { title: '名称', get: (r) => String(r['name'] ?? ''), max: 40 },
            { title: '数量', get: (r) => (r['is_bulk'] === 'true' ? `${String(r['remaining'])}/${String(r['quantity'])}` : String(r['remaining'])), align: 'right', max: 9 },
            { title: '到期', get: (r) => (r['expires_on'] ? String(r['expires_on']) : '长期'), max: 12 },
            {
              title: '剩余时间',
              get: (r) => (r['expires_on'] ? formatDaysLeft(daysUntil(String(r['expires_on']))) : '长期'),
              max: 14,
            },
            { title: '位置', get: (r) => [r['room'], r['container']].filter(Boolean).join('/'), max: 22 },
          ],
          { indent: 2 + depth * 2 },
        );
      }
      for (const c of n.children) printNode(c, depth + 1);
    };

    for (const n of tree.nodes) printNode(n, 0);
    if (data.uncategorized > 0) {
      write(`\n「未分类」组里有 ${data.uncategorized} 件物品 —— 它永远置顶且不可拖动。`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/**
 * `timeline` —— 时间轴视图的数据。
 *
 * 把每条到期记录定位到它所属的时间格（按选定的粒度），
 * 界面直接按返回的顺序画出横向可拉动的时间轴。
 */
function cmdTimeline(args: ParsedArgs, dataDir: string): number {
  const entry = resolveWorkspace(dataDir, str(args, 'ws') ?? args._[0] ?? null);
  const granularity = str(args, 'granularity') ?? 'month';
  const allowed = ['day', 'week', 'month', 'year'];
  if (!allowed.includes(granularity)) {
    throw new ArgError(`粒度 "${granularity}" 不存在。可用: ${allowed.join(' / ')}`);
  }

  const monthsBack = num(args, 'past') ?? 6;
  const monthsAhead = num(args, 'future') ?? 24;

  const db = openDatabase(workspaceDbPath(dataDir, entry), { readOnly: true });
  try {
    const rows = selectWhere(db, 'items', `${TOP_LEVEL} AND status IN ('in_stock','in_use')`, []);
    const categoryFilter = str(args, 'category');
    const filtered = categoryFilter ? rows.filter((r) => String(r['category'] ?? '') === categoryFilter) : rows;

    const now = new Date();
    const slots = buildSlots(now, granularity, monthsBack, monthsAhead);

    // 分类分组（时间轴也按分类组织，界面可以过滤）
    const groups = groupByCategory(filtered, now);
    const dated = groups.map((g) => ({
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
      })),
      longTerm: g.longTerm.map((l) => ({
        itemUuid: String(l.item['uuid'] ?? ''),
        itemName: String(l.item['name'] ?? ''),
      })),
    }));

    const data = {
      workspaceId: entry.id,
      workspaceName: entry.name,
      granularity,
      today: today(now),
      slots,
      categories: dated.map((g) => ({ key: g.key, label: g.label, count: g.entries.length + g.longTerm.length })),
      groups: dated,
      counts: {
        dated: dated.reduce((n, g) => n + g.entries.length, 0),
        longTerm: dated.reduce((n, g) => n + g.longTerm.length, 0),
      },
    };

    if (out.json) {
      emitJson(data);
      return EXIT.OK;
    }

    write(`${entry.name} —— 时间轴（粒度：${granularityLabel(granularity)}，共 ${slots.length} 格）`);
    write(`今天 ${data.today}`);
    for (const g of dated) {
      if (g.entries.length === 0) continue;
      printSection(g.label, `${g.entries.length} 项`);
      printTable(
        g.entries,
        [
          { title: '名称', get: (e) => e.itemName, max: 40 },
          { title: '类型', get: (e) => e.kind, max: 14 },
          { title: '到期日', get: (e) => e.expiresOn, max: 12 },
          { title: '位置', get: (e) => e.location, max: 26 },
          { title: '落在', get: (e) => slots[e.slot]?.label ?? '范围外', max: 16 },
        ],
        { indent: 2 },
      );
      if (g.longTerm.length > 0) write(`  长期：${g.longTerm.map((l) => l.itemName).join('、')}`);
    }
    write('\n桌面端的「时间轴」页可以横向拉动并悬停高亮，这里只是同一份数据的文本形态。');
    return EXIT.OK;
  } finally {
    db.close();
  }
}

interface Slot {
  /** 起点（含），YYYY-MM-DD */
  start: string;
  /** 终点（含） */
  end: string;
  label: string;
  /** 是不是当前所在的这一格 */
  current: boolean;
}

function granularityLabel(g: string): string {
  return { day: '日', week: '周', month: '月', year: '年' }[g] ?? g;
}

/** 生成时间格，覆盖 [今天 - past, 今天 + future] */
function buildSlots(now: Date, granularity: string, monthsBack: number, monthsAhead: number): Slot[] {
  const todayStr = today(now);
  const slots: Slot[] = [];

  if (granularity === 'year') {
    const y0 = now.getFullYear() - Math.ceil(monthsBack / 12);
    const y1 = now.getFullYear() + Math.ceil(monthsAhead / 12);
    for (let y = y0; y <= y1; y += 1) {
      slots.push({
        start: `${y}-01-01`,
        end: `${y}-12-31`,
        label: `${y}`,
        current: y === now.getFullYear(),
      });
    }
    return slots;
  }

  if (granularity === 'month') {
    for (let i = -monthsBack; i <= monthsAhead; i += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const mm = String(m).padStart(2, '0');
      slots.push({
        start: `${y}-${mm}-01`,
        end: monthEnd(`${y}-${mm}`),
        label: `${y}-${mm}`,
        current: y === now.getFullYear() && m === now.getMonth() + 1,
      });
    }
    return slots;
  }

  if (granularity === 'week') {
    // 以本周一为基准，前后各展开
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = (base.getDay() + 6) % 7; // 周一 = 0
    base.setDate(base.getDate() - dow);
    const weeks = Math.ceil((monthsAhead * 30) / 7);
    const back = Math.ceil((monthsBack * 30) / 7);
    for (let i = -back; i <= weeks; i += 1) {
      const s = new Date(base);
      s.setDate(s.getDate() + i * 7);
      const e = new Date(s);
      e.setDate(e.getDate() + 6);
      const ss = isoOf(s);
      const ee = isoOf(e);
      slots.push({
        start: ss,
        end: ee,
        label: `${ss.slice(5)} ~ ${ee.slice(5)}`,
        current: todayStr >= ss && todayStr <= ee,
      });
    }
    return slots;
  }

  // day
  const totalDays = (monthsBack + monthsAhead) * 30;
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = -totalDays / 2; i <= totalDays / 2; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const s = isoOf(d);
    slots.push({ start: s, end: s, label: s.slice(5), current: s === todayStr });
  }
  return slots;
}

function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 某个日期落在第几格；不在范围内返回 -1 */
function slotIndexOf(date: string, slots: Slot[]): number {
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]!;
    if (date >= s.start && date <= s.end) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────
// schema / enums
// ─────────────────────────────────────────────────────────────

function cmdSchemaShow(_args: ParsedArgs, _dataDir: string): number {
  const manifest = buildManifest({
    workspace: { id: 'schema-preview', name: 'schema', createdAt: new Date().toISOString(), source: 'none' },
    rowCounts: {},
    exportedAt: new Date().toISOString(),
  });

  if (out.json) {
    emitJson(manifest);
    return EXIT.OK;
  }

  write(`${APP_NAME} 归档格式 ${APP_FORMAT} v${APP_FORMAT_VERSION}，数据结构版本 ${SCHEMA_VERSION}`);
  write('导出包结构: manifest.json / README.md / checksums.txt / tables/*.csv');

  for (const t of manifest.tables) {
    printSection(`表 ${t.name}`, t.label);
    printTable(t.columns, [
      { title: '列名', get: (c) => c.name, max: 24 },
      { title: '类型', get: (c) => c.type, max: 14 },
      { title: '中文名', get: (c) => c.label, max: 20 },
      { title: '必填', get: (c) => (c.required ? '是' : ''), max: 4 },
      {
        title: '取值 / 约束',
        get: (c) => (c.enumValues ? c.enumValues.map((e) => e.key).join('|') : (c.format ?? '')),
        max: 56,
      },
      { title: '说明', get: (c) => c.description ?? '', max: 46 },
    ]);
  }
  return EXIT.OK;
}

function cmdEnums(_args: ParsedArgs, dataDir: string): number {
  const data = { enums: ENUMS, categoryLeadDays: CATEGORY_LEAD_DAYS };

  if (out.json) {
    emitJson(data, [], { dataDir });
    return EXIT.OK;
  }

  for (const [name, values] of Object.entries(ENUMS)) {
    printSection(name);
    printTable(values, [
      { title: 'key', get: (v) => v.key, max: 20 },
      { title: '中文', get: (v) => v.label, max: 20 },
      { title: '语义', get: (v) => v.semantics ?? '', max: 40 },
    ], { indent: 2 });
  }

  printSection('分类预警提前量');
  printTable(
    Object.entries(CATEGORY_LEAD_DAYS).map(([k, v]) => ({
      key: k,
      label: ENUMS['item_category']?.find((e) => e.key === k)?.label ?? '',
      days: v,
    })),
    [
      { title: 'key', get: (r) => r.key, max: 20 },
      { title: '分类', get: (r) => r.label, max: 16 },
      { title: '提前量', get: (r) => `${r.days} 天`, align: 'right' },
    ],
    { indent: 2 },
  );
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────
// 导入导出
// ─────────────────────────────────────────────────────────────

function summarizePreview(p: ImportPreview): Record<string, unknown> {
  return {
    workspaceName: p.workspaceName,
    format: p.manifest.format,
    formatVersion: p.manifest.formatVersion,
    schemaVersion: p.manifest.schemaVersion,
    exportedAt: p.manifest.exportedAt,
    sourceWorkspaceId: p.manifest.workspace?.id ?? null,
    checksumVerified: p.checksumVerified,
    totalRows: p.totalRows,
    errorCount: p.errorCount,
    warningCount: p.warningCount,
    tables: p.tables,
    issues: p.issues.slice(0, 200),
    issuesTruncated: p.issues.length > 200,
  };
}

function cmdImport(args: ParsedArgs, dataDir: string): number {
  const archive = args._[0];
  if (!archive) throw new ArgError('用法: import <归档.zip> [--name <名称>] [--dry-run]');

  if (!existsSync(resolve(archive))) throw new NotFoundError(`归档不存在: ${resolve(archive)}`);

  const name = str(args, 'name');

  // 先看是不是多工作区包 —— 它的结构与单工作区不同，预览方式也不一样
  const detected = detectMultiArchive(archive);

  if (bool(args, 'dryRun')) {
    if (detected.multi) {
      const data = {
        dryRun: true,
        multi: true,
        archive: resolve(archive),
        workspaceCount: detected.workspaces.length,
        workspaces: detected.workspaces,
      };
      if (out.json) emitJson(data);
      else {
        write('归档预演（未写入任何数据）');
        printKv([
          ['归档', resolve(archive)],
          ['类型', `多工作区包（${detected.workspaces.length} 个）`],
        ]);
        printSection('将分别新建这些工作区');
        printTable(detected.workspaces, [
          { title: '目录', get: (w) => w.dir, max: 30 },
          { title: '名称', get: (w) => w.name, max: 30 },
        ], { indent: 2 });
        write('\n去掉 --dry-run 即执行：每个子目录会分别建成一个独立工作区。');
      }
      return EXIT.OK;
    }

    const preview = previewArchive(archive, name ? { name } : {});
    if (out.json) {
      emitJson(
        { dryRun: true, ...summarizePreview(preview) },
        preview.issues.filter((i) => i.level === 'warning').map((i) => i.message),
      );
    } else {
      write('归档预演（未写入任何数据）');
      printKv([
        ['归档', resolve(archive)],
        ['将创建的工作区', preview.workspaceName],
        ['导出于', preview.manifest.exportedAt.slice(0, 19).replace('T', ' ')],
        ['归档格式版本', String(preview.manifest.formatVersion)],
        ['数据结构版本', String(preview.manifest.schemaVersion)],
        ['完整性校验', preview.checksumVerified ? '通过' : '未通过'],
        ['总行数', String(preview.totalRows)],
      ]);
      printSection('各表行数');
      printTable(preview.tables, [
        { title: '表', get: (t) => t.table, max: 20 },
        { title: '行数', get: (t) => String(t.rows), align: 'right' },
        { title: '错误', get: (t) => String(t.errors), align: 'right' },
        { title: '警告', get: (t) => String(t.warnings), align: 'right' },
      ], { indent: 2 });
      if (preview.issues.length > 0) {
        printSection('校验问题', `${preview.errorCount} 错误 / ${preview.warningCount} 警告`);
        for (const i of preview.issues.slice(0, 40)) {
          write(`  [${i.level}] ${i.table}${i.line ? ':' + i.line : ''} ${i.message}`);
        }
      }
      write(
        preview.errorCount === 0
          ? '\n可以导入。去掉 --dry-run 即执行（会新建一个工作区）。'
          : `\n有 ${preview.errorCount} 个错误，无法导入。`,
      );
    }
    return preview.errorCount > 0 ? EXIT.VALIDATION : EXIT.OK;
  }

  const opts: Parameters<typeof importArchive>[1] = { dataDir };
  if (name) opts.name = name;
  const result = importAnything(archive, opts);

  // ── 多工作区：逐个报，失败的不影响成功的 ──
  if (result.multi) {
    if (out.json) {
      emitJson({
        multi: true,
        total: result.total,
        succeeded: result.succeeded,
        failed: result.failed,
        items: result.items,
        tookMs: result.tookMs,
      });
      return result.failed > 0 ? EXIT.VALIDATION : EXIT.OK;
    }

    write(`已从多工作区包新建 ${result.succeeded}/${result.total} 个工作区`);
    printTable(result.items, [
      { title: '结果', get: (i) => (i.ok ? 'ok' : '失败'), max: 6 },
      { title: '名称', get: (i) => i.name, max: 24 },
      { title: 'ID', get: (i) => i.workspaceId ?? '—', max: 22 },
      {
        title: '数据量',
        get: (i) => Object.entries(i.rowCounts).map(([k, v]) => `${k} ${v}`).join(' · ') || '—',
        max: 32,
      },
      { title: '说明', get: (i) => i.error ?? '', max: 40 },
    ]);
    if (result.failed > 0) {
      write(`\n有 ${result.failed} 个工作区导入失败，已被标记为异常（禁止读写）。`);
      write('它们会出现在 `ws list` 里，可以导出后删除重建。');
    }
    write('\n注意：每个子目录都是「新建工作区」，任何已有工作区都没有被修改。');
    return result.failed > 0 ? EXIT.VALIDATION : EXIT.OK;
  }

  // ── 单工作区 ──
  const one = result.items[0];
  if (!one || !one.ok) {
    emitError(EXIT.VALIDATION, 'ValidationFailed', one?.error ?? '导入失败', { item: one ?? null });
    return EXIT.VALIDATION;
  }

  if (out.json) {
    emitJson(
      {
        multi: false,
        workspaceId: one.workspaceId,
        workspaceName: one.name,
        rowCounts: one.rowCounts,
        tookMs: result.tookMs,
      },
      [],
    );
    return EXIT.OK;
  }

  write(`已导入为新工作区「${one.name}」`);
  printKv([
    ['ID', String(one.workspaceId)],
    ['数据量', Object.entries(one.rowCounts).map(([k, v]) => `${k} ${v}`).join(' · ')],
  ]);
  write('\n注意：这是一次「新建工作区」，任何已有工作区都没有被修改。');
  return EXIT.OK;
}

/**
 * `export` —— 支持多选工作区。
 *
 * 选 1 个：根目录就是数据（老格式，老版本也读得回来）。
 * 选多个：多一层 `workspaces/<名字>/`，根目录放 `kind: 'multi'` 的总 manifest。
 *
 * 取工作区的方式：`--ws` 可以给多次，也可以逗号分隔；位置参数也算。
 * 都不给就是当前工作区。
 */
function cmdExport(args: ParsedArgs, dataDir: string): number {
  const raw: string[] = [];
  for (const w of arr(args, 'ws')) for (const part of String(w).split(',')) if (part.trim()) raw.push(part.trim());
  for (const a of args._) if (String(a).trim()) raw.push(String(a).trim());

  const entries =
    raw.length > 0
      ? raw.map((id) => resolveWorkspace(dataDir, id, { allowUnusable: true }))
      : [resolveWorkspace(dataDir, null, { allowUnusable: true })];

  // 去重（同一个工作区写两遍没意义，还会生成两个同名目录）
  const seen = new Set<string>();
  const uniq = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  const outPath = str(args, 'out') ?? str(args, 'o');
  const multi = uniq.length > 1;

  if (bool(args, 'dryRun')) {
    const data = {
      dryRun: true,
      multi,
      workspaces: uniq.map((e) => ({ id: e.id, name: e.name })),
      to: outPath ? resolve(outPath) : '(默认 exports/ 目录)',
      structure: multi ? '多工作区（workspaces/<名字>/…）' : '单工作区（根目录即数据）',
    };
    if (out.json) emitJson(data);
    else {
      write(`将导出 ${uniq.length} 个工作区到 ${data.to}`);
      write(`结构：${data.structure}`);
      for (const e of uniq) write(`  · ${e.name}`);
    }
    return EXIT.OK;
  }

  if (!multi) {
    const opts: Parameters<typeof exportWorkspace>[2] = {};
    if (outPath) opts.outPath = outPath;
    const result = exportWorkspace(dataDir, uniq[0]!, opts);

    if (out.json) {
      emitJson({
        multi: false,
        archivePath: result.archivePath,
        bytes: result.bytes,
        workspaceId: result.workspace.id,
        workspaceName: result.workspace.name,
        rowCounts: result.rowCounts,
        fileCount: result.fileCount,
        exportedAt: result.exportedAt,
      });
      return EXIT.OK;
    }

    write(`已导出工作区「${result.workspace.name}」`);
    printKv([
      ['归档', result.archivePath],
      ['大小', `${formatBytes(result.bytes)}  （${result.fileCount} 个文件）`],
      ['数据量', Object.entries(result.rowCounts).map(([k, v]) => `${k} ${v}`).join(' · ')],
    ]);
    return EXIT.OK;
  }

  const opts: Parameters<typeof exportWorkspaces>[2] = {};
  if (outPath) opts.outPath = outPath;
  const result = exportWorkspaces(dataDir, uniq, opts);

  if (out.json) {
    emitJson({
      multi: true,
      archivePath: result.archivePath,
      bytes: result.bytes,
      workspaceCount: result.workspaces.length,
      workspaces: result.workspaces,
      fileCount: result.fileCount,
      exportedAt: result.exportedAt,
    });
    return EXIT.OK;
  }

  write(`已导出 ${result.workspaces.length} 个工作区`);
  printKv([
    ['归档', result.archivePath],
    ['大小', `${formatBytes(result.bytes)}  （${result.fileCount} 个文件）`],
    ['结构', '根目录 = 总目录；workspaces/<名字>/ = 各工作区的数据'],
  ]);
  printSection('包含的工作区');
  printTable(result.workspaces, [
    { title: '名称', get: (w) => w.name, max: 24 },
    { title: '目录', get: (w) => `workspaces/${w.dir}`, max: 40 },
    {
      title: '数据量',
      get: (w) => Object.entries(w.rowCounts).map(([k, v]) => `${k} ${v}`).join(' · '),
      max: 32,
    },
  ], { indent: 2 });
  write('\n导入时会把每个子目录分别建成一个独立工作区。');
  return EXIT.OK;
}

// ─────────────────────────────────────────────────────────────
// 命令表
// ─────────────────────────────────────────────────────────────

interface Command {
  path: string[];
  summary: string;
  usage: string;
  options: OptionSpec[];
  run: (args: ParsedArgs, dataDir: string) => number;
}

const COMMANDS: Command[] = [
  { path: ['info'], summary: '显示应用、数据目录与工作区概况', usage: 'info', options: [], run: cmdInfo },
  {
    path: ['init'],
    summary: '初始化数据目录与第一个工作区',
    usage: 'init [--name <名称>] [--no-seed]',
    options: [
      { name: 'name', short: 'n', type: 'string', desc: '工作区名称', valueName: '名称' },
      { name: 'noSeed', type: 'boolean', desc: '不写入演示数据' },
      DRY_RUN,
    ],
    run: cmdInit,
  },

  // ── 工作区 ──
  { path: ['ws', 'list'], summary: '列出所有工作区', usage: 'ws list', options: [], run: cmdWsList },
  {
    path: ['ws', 'create'],
    summary: '新建一个工作区',
    usage: 'ws create --name <名称> [--seed]',
    options: [
      { name: 'name', short: 'n', type: 'string', desc: '工作区名称', valueName: '名称' },
      { name: 'seed', type: 'boolean', desc: '写入演示数据' },
      { name: 'use', type: 'boolean', desc: '顺便把它设为默认工作区（默认不抢默认）' },
      DRY_RUN,
    ],
    run: cmdWsCreate,
  },
  { path: ['ws', 'show'], summary: '查看工作区详情与提醒摘要', usage: 'ws show [<工作区>]', options: [], run: cmdWsShow },
  { path: ['ws', 'stats'], summary: '统计：按分类 / 状态 / 房间分布、金额合计', usage: 'ws stats [<工作区>]', options: [], run: cmdWsStats },
  {
    path: ['ws', 'verify'],
    summary: '一致性自检；不通过的工作区会被自动隔离（禁止读写）',
    usage: 'ws verify [<工作区>] [--no-quarantine]',
    options: [
      { name: 'noQuarantine', type: 'boolean', desc: '只报告，不改工作区状态' },
      DRY_RUN,
    ],
    run: cmdWsVerify,
  },
  {
    path: ['ws', 'quarantine'],
    summary: '手动把一个工作区标记为异常（禁止读写）',
    usage: 'ws quarantine <工作区> [--reason <原因>]',
    options: [{ name: 'reason', type: 'string', desc: '标记原因', valueName: '文本' }],
    run: cmdWsQuarantine,
  },
  {
    path: ['ws', 'unquarantine'],
    summary: '解除异常标记（确认数据没问题时才用；正常恢复方式是重建）',
    usage: 'ws unquarantine <工作区>',
    options: [],
    run: cmdWsUnquarantine,
  },
  { path: ['ws', 'use'], summary: '设置默认工作区', usage: 'ws use <工作区>', options: [], run: cmdWsUse },
  {
    path: ['ws', 'rename'],
    summary: '重命名工作区',
    usage: 'ws rename <工作区> <新名称>',
    options: [{ name: 'name', short: 'n', type: 'string', desc: '新名称', valueName: '名称' }, DRY_RUN],
    run: cmdWsRename,
  },
  {
    path: ['ws', 'rm'],
    summary: '删除工作区（默认先留数据库快照）',
    usage: 'ws rm <工作区> --yes',
    options: [{ name: 'noSnapshot', type: 'boolean', desc: '不生成快照' }, DRY_RUN],
    run: cmdWsRm,
  },
  { path: ['ws', 'seed'], summary: '写入演示数据（要求该工作区是空的）', usage: 'ws seed [<工作区>]', options: [DRY_RUN], run: cmdWsSeed },

  // ── 物品 ──
  {
    path: ['item', 'add'],
    summary: '新增物品记录（单个用选项，批量用 --json-file / --stdin / --item）',
    usage: 'item add --name <名称> [--category <分类>] [--expires-ym <年月>] ...',
    options: [...itemOptionSpecs(), DRY_RUN],
    run: cmdItemAdd,
  },
  {
    path: ['item', 'list'],
    summary: '列出物品',
    usage: 'item list [--category][--room][--search][--expiring N][--low-stock][--all][--limit N]',
    options: [
      { name: 'category', short: 'c', type: 'string', desc: '按分类过滤', valueName: 'key' },
      { name: 'room', type: 'string', desc: '按房间过滤', valueName: '房间' },
      { name: 'search', short: 's', type: 'string', desc: '按名称/品牌/型号/条码搜索', valueName: '关键词' },
      { name: 'status', type: 'string', desc: '按状态过滤（in_stock/consumed/…）', valueName: 'key' },
      { name: 'expiring', type: 'number', desc: '只看 N 天内到期的', valueName: 'N' },
      { name: 'lowStock', type: 'boolean', desc: '只看剩余低于最低库存的' },
      { name: 'longTerm', type: 'boolean', desc: '只看「长期」（没有到期日）的物品' },
      { name: 'dated', type: 'boolean', desc: '只看有到期日的物品' },
      { name: 'all', type: 'boolean', desc: '包含已用完 / 已丢弃的' },
      {
        name: 'group',
        type: 'number',
        desc: '分组到第几层：1=分类 2=+子类 3=+标签；0=不分组，缺省 1',
        valueName: '1-3',
      },
      {
        name: 'sort',
        type: 'string',
        desc: '组内排序字段，缺省 manual（手动顺序）；可用见 enums',
        valueName: 'key',
      },
      { name: 'limit', type: 'number', desc: '最多返回多少条', valueName: 'N' },
    ],
    run: cmdItemList,
  },
  {
    path: ['item', 'show'],
    summary: '查看单条物品的完整信息 + 出入库流水',
    usage: 'item show <uuid|code>',
    options: [{ name: 'id', type: 'string', desc: '物品 uuid 或 code', valueName: 'key' }],
    run: cmdItemShow,
  },
  {
    path: ['item', 'update'],
    summary: '修改物品字段（含数量、到期日、价格）',
    usage: 'item update <uuid|code> [字段选项]',
    options: [...itemOptionSpecs(), DRY_RUN],
    run: cmdItemUpdate,
  },
  {
    path: ['item', 'consume'],
    summary: '领用 / 丢弃 / 过期处理：扣减剩余数量并记流水',
    usage: 'item consume <uuid|code> [--qty N] [--reason consume|discard|expired_dispose|gift_out|loss]',
    options: [
      { name: 'id', type: 'string', desc: '物品 uuid 或 code', valueName: 'key' },
      { name: 'qty', type: 'number', desc: '扣减数量，缺省 1', valueName: 'N' },
      { name: 'reason', type: 'string', desc: '原因 key', valueName: 'key' },
      { name: 'notes', type: 'string', desc: '备注', valueName: '文本' },
      DRY_RUN,
    ],
    run: cmdItemConsume,
  },
  {
    path: ['item', 'rm'],
    summary: '删除物品记录（支持多个；连带删除流水）',
    usage: 'item rm <uuid|code> [更多...] --yes',
    options: [DRY_RUN],
    run: cmdItemRm,
  },
  {
    path: ['item', 'stock'],
    summary: '管理批量物品的「一组库存」（多条数量 + 到期日）',
    usage: 'item stock <list|add|rm> <物品> [--qty N] [--expires-on 日期] [--long-term]',
    options: [
      { name: 'id', type: 'string', desc: '物品（名称 / uuid / 内部标识）', valueName: 'key' },
      { name: 'qty', type: 'number', desc: '这一组的数量', valueName: 'N' },
      { name: 'remaining', type: 'number', desc: '这一组剩余，缺省等于数量', valueName: 'N' },
      { name: 'expiresOn', type: 'string', desc: '这一组的到期日', valueName: '日期' },
      { name: 'expiresYm', type: 'string', desc: '只到月份时填 YYYY-MM', valueName: '年月' },
      { name: 'longTerm', type: 'boolean', desc: '这一组长期有效' },
      { name: 'purchasedOn', type: 'string', desc: '这一组的购买日期', valueName: '日期' },
      { name: 'unitPrice', type: 'string', desc: '这一组的单价（元）', valueName: '元' },
      { name: 'store', type: 'string', desc: '购买渠道', valueName: '名称' },
      { name: 'notes', type: 'string', desc: '备注', valueName: '文本' },
      DRY_RUN,
    ],
    run: cmdItemStock,
  },
  {
    path: ['item', 'extra'],
    summary: '查看或修改补充信息（位置 / 规格 / 备注 + 这件东西自己的字段）',
    usage:
      'item extra <物品>                       查看\n' +
      '       item extra <物品> <字段> <值>          设置一个字段（空值 = 删除）\n' +
      '       item extra <物品> --set \'{"滤网型号":"M8R-FLP"}\'  整份替换\n' +
      '       item extra <物品> --json             以 JSON 输出',
    options: [
      { name: 'set', type: 'string', desc: '整份替换为这个扁平 JSON 对象', valueName: 'JSON' },
      { name: 'ws', type: 'string', desc: '工作区（默认当前）', valueName: '工作区' },
      DRY_RUN,
    ],
    run: cmdItemExtra,
  },
  {
    path: ['item', 'reorder'],
    summary: '把物品移到最前或某个位置（等价于界面上的拖动）',
    usage: 'item reorder <物品> [更多...] [--after <物品>]',
    options: [
      { name: 'after', type: 'string', desc: '插到这条之后；省略则移到最前', valueName: '物品' },
      DRY_RUN,
    ],
    run: cmdItemReorder,
  },
  {
    path: ['item', 'purge'],
    summary: '一键清理：删掉所有「非批量且剩余为 0」的记录',
    usage: 'item purge [--dry-run] [--yes]',
    options: [DRY_RUN],
    run: cmdItemPurge,
  },

  // ── 提醒 ──
  {
    path: ['alert', 'list'],
    summary: '临期 / 过期 / 待补货清单',
    usage: 'alert list [--within N] [--all]',
    options: [
      { name: 'within', short: 'w', type: 'number', desc: '只显示 N 天内到期的', valueName: 'N' },
      { name: 'all', type: 'boolean', desc: '包含「关注」级别' },
    ],
    run: cmdAlertList,
  },

  // ── 导入导出 ──
  {
    path: ['import'],
    summary: '导入归档为新工作区（不改动任何已有工作区）',
    usage: 'import <归档.zip> [--name <名称>] [--dry-run]',
    options: [{ name: 'name', short: 'n', type: 'string', desc: '新建工作区的名称', valueName: '名称' }, DRY_RUN],
    run: cmdImport,
  },
  {
    path: ['export'],
    summary: '导出工作区为归档；给多个工作区时导出成一个多工作区包',
    usage:
      'export [<工作区>...] [-o <输出.zip>]\n' +
      '       export --ws A --ws B -o 多个.zip      （--ws 可重复，也可逗号分隔）',
    options: [
      { name: 'ws', type: 'string', multiple: true, desc: '要导出的工作区，可给多次', valueName: '工作区' },
      { name: 'out', short: 'o', type: 'string', desc: '输出路径', valueName: 'path' },
      DRY_RUN,
    ],
    run: cmdExport,
  },

  // ── 元信息 ──
  { path: ['schema', 'show'], summary: '打印归档格式的完整字段说明（即 manifest.json 内容）', usage: 'schema show', options: [], run: cmdSchemaShow },
  {
    path: ['group', 'list'],
    summary: '三级分组 + 组内排序的完整清单',
    usage: 'group list [--levels 1|2|3] [--sort <字段>] [--order <父路径>=<key,key>]',
    options: [
      { name: 'levels', short: 'l', type: 'number', desc: '分组到第几层：1=分类 2=+子类 3=+标签，缺省 1', valueName: '1-3' },
      { name: 'sort', type: 'string', desc: '组内排序字段，缺省 manual（手动顺序）', valueName: 'key' },
      {
        name: 'order',
        type: 'string',
        multiple: true,
        desc: '固定某层的组顺序，如 --order ""=daily,medicine（父路径为空串表示第一层）',
        valueName: 'path=keys',
      },
      DRY_RUN,
    ],
    run: cmdGroupList,
  },
  {
    path: ['sort', 'fields'],
    summary: '列出可用的排序字段',
    usage: 'sort fields',
    options: [],
    run: (): number => {
      if (out.json) emitJson({ fields: SORT_FIELDS });
      else {
        printTable(SORT_FIELDS, [
          { title: 'key', get: (f) => f.key, max: 12 },
          { title: '名称', get: (f) => f.label, max: 12 },
          { title: '方向', get: (f) => (f.desc ? '降序' : '升序'), max: 6 },
          { title: '说明', get: (f) => f.hint, max: 40 },
        ]);
        write('\n排序默认关闭。关闭时按「手动顺序」排，可以拖动固定；');
        write('开启后按字段排，且不可拖动 —— 拖了也会立刻被排序覆盖。');
      }
      return EXIT.OK;
    },
  },
  {
    path: ['column', 'list'],
    summary: '列出物品表的列，以及当前工作区开了哪些',
    usage: 'column list',
    options: [],
    run: cmdColumnList,
  },
  {
    path: ['column', 'set'],
    summary: '设置物品表显示哪些列（「物品」「到期时间」不可关）',
    usage: 'column set <列> [更多列...] | column set --default | column set --show-all',
    options: [
      { name: 'default', type: 'boolean', desc: '恢复默认列' },
      { name: 'showAll', type: 'boolean', desc: '全部打开' },
      { name: 'ws', type: 'string', desc: '工作区（默认当前）', valueName: '工作区' },
      DRY_RUN,
    ],
    run: cmdColumnSet,
  },
  {
    path: ['timeline'],
    summary: '时间轴视图的数据：按粒度把到期时间分格',
    usage: 'timeline [--granularity day|week|month|year] [--category <分类>] [--past N] [--future N]',
    options: [
      { name: 'granularity', short: 'g', type: 'string', desc: '粒度，缺省 month', valueName: 'key' },
      { name: 'category', short: 'c', type: 'string', desc: '只看某个分类', valueName: 'key' },
      { name: 'past', type: 'number', desc: '往前覆盖几个月，缺省 6', valueName: 'N' },
      { name: 'future', type: 'number', desc: '往后覆盖几个月，缺省 24', valueName: 'N' },
    ],
    run: cmdTimeline,
  },

  { path: ['enums'], summary: '列出所有枚举取值与分类提前量', usage: 'enums', options: [], run: cmdEnums },
];

function findCommand(tokens: string[]): { cmd: Command; consumed: number } | null {
  let best: { cmd: Command; consumed: number } | null = null;
  for (const cmd of COMMANDS) {
    if (cmd.path.length > tokens.length) continue;
    if (!cmd.path.every((p, i) => tokens[i] === p)) continue;
    if (!best || cmd.path.length > best.cmd.path.length) best = { cmd, consumed: cmd.path.length };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// 帮助
// ─────────────────────────────────────────────────────────────

function printHelp(): void {
  write(`${APP_NAME} ${APP_VERSION} —— 家庭物品管理命令行工具`);
  write('');
  write('一行记录 = 一件实际存在的东西。同一件东西买两次就是两条记录，各自管自己的到期日。');
  write('默认一件就是一件（数量恒为 1，操作是「消耗」）；需要按个数管理的物品加 --bulk 开启「批量」。');
  write('桌面端能做的事，这里全都能做。工作区之间完全隔离，互相不感知。');
  write('');
  write('用法: dsh-inv <命令> [选项]');
  write('');
  write('命令:');

  const groups = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    const g = c.path.length > 1 ? c.path[0]! : '(顶层)';
    const list = groups.get(g) ?? [];
    list.push(c);
    groups.set(g, list);
  }
  for (const [g, list] of groups) {
    write(`\n  ${g}`);
    for (const c of list) write(`    ${padEnd(c.usage, 64)} ${c.summary}`);
  }

  write('\n全局选项:');
  for (const o of GLOBAL_OPTIONS) {
    const names = [o.short ? `-${o.short}` : null, `--${o.name}`].filter(Boolean).join(', ');
    write(`  ${padEnd(names + (o.valueName ? ` <${o.valueName}>` : ''), 30)} ${o.desc}`);
  }

  write('\n退出码: 0 成功 · 1 运行错误 · 2 参数错误 · 3 数据校验失败 · 4 未找到');
  write('输出: 默认人读表格；加 --json 输出机器可解析的单个 JSON 对象。');
  write('\n示例:');
  write('  dsh-inv init --name "我的家"');
  write('  # 普通物品：一件就是一件，数量恒为 1');
  write('  dsh-inv item add --name "布洛芬缓释胶囊" -c medicine --brand "芬必得" --unit 盒 \\');
  write('                   --expires-ym 2027-03 --unit-price 19.30 --store 京东健康');
  write('  # 批量物品：需要按个数管理时加 --bulk');
  write('  dsh-inv item add --name "抽纸巾" -c daily --bulk --qty 24 --remaining 24 --min-stock 6');
  write('  dsh-inv item consume MED-0001            # 消耗掉（数量归 0）');
  write('  dsh-inv item consume DEV-0001 --qty 3    # 批量物品领用 3 个');
  write('  dsh-inv item purge --dry-run            # 看哪些「已消耗完」的能清掉');
  write(`  dsh-inv alert list --within ${SOON_DAYS}`);
  write('  dsh-inv export -o D:\\备份\\家当.zip');
  write('  dsh-inv import D:\\备份\\家当.zip --name "父母家"');
  write('  dsh-inv item add --json-file 购物清单.json');
  write('  dsh-inv alert list --json | jq .counts');
}

function printCommandHelp(cmd: Command): void {
  write(`${cmd.summary}`);
  write('');
  write(`用法: dsh-inv ${cmd.usage}`);
  if (cmd.options.length > 0) {
    write('\n选项:');
    for (const o of cmd.options) {
      const names = [o.short ? `-${o.short}` : null, `--${o.name}`].filter(Boolean).join(', ');
      write(`  ${padEnd(names + (o.valueName ? ` <${o.valueName}>` : ''), 34)} ${o.desc}`);
    }
  }
  if (cmd.path[0] === 'item' && cmd.path[1] === 'add') {
    write('\n默认一件物品就是一件（数量恒为 1，用 item consume 消耗掉）。');
    write('需要按个数管理时加 --bulk，之后 --qty / --remaining / --min-stock 才生效。');
    write('\nJSON 批量录入的键名同时接受列名与驼峰写法，例如：');
    write('  [{ "name": "创可贴", "category": "medical_device", "qty": 1,');
    write('     "expiresYm": "2028-06", "unitPrice": "29.90", "room": "客厅" }]');
  }
  write('\n全局选项同样可用（--json / --ws / --data-dir / --quiet / --yes / --dry-run）。');
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

export function main(argv: string[]): number {
  const tokens = argv.slice(2);

  out.json = tokens.includes('--json');
  out.quiet = tokens.includes('--quiet') || tokens.includes('-q');

  if (tokens.length === 0 || tokens[0] === '--help' || tokens[0] === '-h' || tokens[0] === 'help') {
    printHelp();
    return EXIT.OK;
  }
  if (tokens[0] === '--version' || tokens[0] === '-v' || tokens[0] === 'version') {
    write(`${APP_NAME} ${APP_VERSION}`);
    return EXIT.OK;
  }

  const found = findCommand(tokens);
  if (!found) {
    emitError(EXIT.USAGE, 'UnknownCommand', `未知命令: ${tokens.join(' ')}`);
    if (!out.json) {
      write('');
      printHelp();
    }
    return EXIT.USAGE;
  }

  const { cmd, consumed } = found;
  const rest = tokens.slice(consumed);

  if (rest.includes('--help') || rest.includes('-h')) {
    printCommandHelp(cmd);
    return EXIT.OK;
  }

  let args: ParsedArgs;
  try {
    args = parseArgv(rest, [...cmd.options, ...GLOBAL_OPTIONS]);
  } catch (err) {
    emitError(EXIT.USAGE, 'BadArguments', (err as Error).message);
    return EXIT.USAGE;
  }

  if (bool(args, 'json')) out.json = true;
  const dataDir = dataDirOf(args);

  if (!existsSync(dataDir) && cmd.path[0] !== 'init' && cmd.path[0] !== 'info') {
    emitError(EXIT.NOT_FOUND, 'NoDataDir', `数据目录不存在: ${dataDir}。先运行 \`dsh-inv init\`。`, { dataDir });
    return EXIT.NOT_FOUND;
  }

  try {
    return cmd.run(args, dataDir);
  } catch (err) {
    const e = err as Error;
    if (e instanceof WorkspaceNotFoundError) {
      emitError(EXIT.NOT_FOUND, 'WorkspaceNotFound', e.message, { dataDir });
      return EXIT.NOT_FOUND;
    }
    /**
     * 工作区被隔离 → 退出码 3（数据状态不合法），不是"运行出错"。
     *
     * agent 拿到 3 就知道"这个工作区现在不能碰"，而不是"命令写错了，
     * 换个参数再试试" —— 后者会白试很多次。
     */
    if (e instanceof WorkspaceUnusableError) {
      emitError(EXIT.VALIDATION, 'WorkspaceUnusable', e.message, {
        workspaceId: e.workspaceId,
        workspaceName: e.workspaceName,
        status: e.status,
        reason: e.reason,
        recovery: [
          `dsh-inv export --ws "${e.workspaceName}" -o 备份.zip`,
          `dsh-inv ws rm "${e.workspaceName}" --yes`,
          'dsh-inv import 备份.zip',
        ],
      });
      return EXIT.VALIDATION;
    }
    if (e instanceof NotFoundError) {
      emitError(EXIT.NOT_FOUND, 'NotFound', e.message, { dataDir });
      return EXIT.NOT_FOUND;
    }
    if (e instanceof ArgError) {
      emitError(EXIT.USAGE, 'BadArguments', e.message);
      return EXIT.USAGE;
    }
    // 字段校验失败是「数据不合法」，不是运行错误 —— 退出码 3 让脚本能区分
    if (e instanceof FieldError || e.name === 'FieldError') {
      emitError(EXIT.VALIDATION, 'ValidationFailed', e.message);
      return EXIT.VALIDATION;
    }
    emitError(EXIT.RUNTIME, e.name || 'Error', e.message);
    if (!out.json && e.stack) log(e.stack);
    return EXIT.RUNTIME;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

export { EXIT };
