/**
 * 渲染层。刻意用「零依赖原版 TS」：
 *   - module: None → 编译成单个全局脚本，不需要打包器
 *   - 不引框架：这个应用只有一个表格、几个表单和一个横幅，框架带来的复杂度大于收益
 *   - 所有数据都从 window.api（preload 白名单）取，渲染层不碰文件系统
 *
 * 顶部横幅是核心：打开就看到「有 3 件东西快过期了」。
 */

// ─── 由 preload 注入的 API 类型（手写最小子集，避免 import 破坏单文件编译）───

interface ApiError extends Error {
  notFound?: boolean;
}

interface AppInfo {
  name: string;
  version: string;
  schemaVersion: number;
  dataDir: string;
  isDefaultDataDir: boolean;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

interface ColumnInfo {
  name: string;
  label: string;
  kind: string;
  required: boolean;
  description: string | null;
  enumName: string | null;
  default: string | number | boolean | null;
}

interface SchemaInfo {
  sortFields?: SortFieldDef[];
  tables: { name: string; label: string; columns: ColumnInfo[] }[];
  enums: Record<string, { key: string; label: string }[]>;
  categoryLeadDays: Record<string, number>;
  criticalMultiplier: number;
}

/** 一列的定义，由 core 下发（见 src/core/columns.ts） */
interface ColumnDef {
  key: string;
  label: string;
  hint: string;
  /** 锁定：永远显示，勾选框禁用 */
  lock?: boolean;
  defaultOn: boolean;
  align?: 'right';
}

interface WsRow {
  id: string;
  name: string;
  createdAt: string;
  source: string;
  /** 中文显示名：新建 / 示例 / 导入 */
  sourceLabel: string;
  notes: string | null;
  active: boolean;
  items: number | null;
  moves: number | null;
  /** 可一键清理的条数：非批量且剩余为 0 */
  purgeable: number;
  dbBytes: number | null;
  integrityOk: boolean | null;
}

interface WsList {
  dataDir: string;
  activeWorkspaceId: string | null;
  workspaces: WsRow[];
}

/**
 * 分组树的一个节点。
 *
 * 分组最多三层：1 = 分类，2 = 子类，3 = 标签。
 * `path` 是完整路径（如 ['medicine','感冒药','常备']），
 * 拖动固定组顺序时按它存档 —— 光靠组名会在不同父级下撞车。
 */
interface GroupNode {
  key: string;
  label: string;
  path: string[];
  level: number;
  items: ItemRow[];
  children: GroupNode[];
  count: number;
  /** 未分类：永远置顶、不可拖动 */
  pinned: boolean;
  expired: number;
  soon: number;
  longTerm: number;
}

interface GroupTreeResult {
  levels: number;
  requestedLevels: number;
  sortedBy: string;
  /** 排序关闭时才允许拖动 */
  dragEnabled: boolean;
  total: number;
  uncategorized: number;
  groups: GroupNode[];
  collapsed: string[];
  /** 顺带带回的列配置，省一次往返 */
  columns?: string[];
}

/** 排序字段 */
interface SortFieldDef {
  key: string;
  label: string;
  desc: boolean;
  hint: string;
}

interface RestockRow {
  itemUuid: string;
  itemName: string;
  category: string;
  remaining: number;
  minStock: number;
  shortfall: number;
  unit: string;
}

/**
 * 到期概览。
 *
 * v3 取消「紧急 / 临期 / 关注」分级，改成按分类分组；组内 entries 已经
 * 按到期日升序排好，界面直接照着画，顺序本身就表达紧迫度。
 */
interface AlertSummary {
  workspaceId: string;
  workspaceName: string;
  generatedAt: string;
  today: string;
  headline: string;
  counts: { items: number; dated: number; expired: number; soon: number; longTerm: number; lowStock: number };
  lowStock: RestockRow[];
}

interface ExpiryInfo {
  kind: string;
  expiresOn: string;
  daysLeft: number;
  daysLeftText: string;
  expired: boolean;
}

/** 「一组库存」里的一条：自己的数量 + 到期日 */
interface BulkStock {
  uuid: string;
  index: number;
  quantity: number;
  remaining: number;
  purchasedOn: string;
  expiresOn: string | null;
  unitPriceYuan: string;
  amountYuan: string;
  store: string;
  notes: string;
  expired: boolean;
  daysLeft: number | null;
}

interface ItemRow {
  uuid: string;
  name: string;
  category: string;
  subcategory: string | null;
  brand: string | null;
  /** 型号：哪一款（MX Master 3S）。与规格（这一份有多大）是不同的东西 */
  model: string | null;
  spec: string | null;
  unit: string | null;
  barcode: string | null;
  room: string | null;
  container: string | null;
  /** 是否开启「批量」：只有开启后数量才可设、可多次领用 */
  is_bulk: string;
  quantity: number;
  remaining: number;
  minStock: number;
  lowStock: boolean;
  /** 配了「一组库存」时是子行条数，0 表示直接用自己那条数量 */
  stockCount: number;
  /**
   * 手动顺序号。
   *
   * 界面不直接显示这个数 —— 显示的是它在当前列表里的**位次**（第几条），
   * 这样开启排序后位次会跟着排序变，而手动顺序原封不动地留着，
   * 关掉排序就能回到原样。
   */
  sortOrder: number;
  purchased_on: string | null;
  unit_price_cents: string | null;
  amount_cents: string | null;
  store: string | null;
  expiresOn: string | null;
  opened_on: string | null;
  warranty_months: string | null;
  warranty_until: string | null;
  status: string;
  is_prescription: string;
  open_shelf_life_days: string | null;
  serial_no: string | null;
  notes: string | null;
  tags: string | null;
  photo_path: string | null;
  daysLeft: number | null;
  daysLeftText: string;
  /** 没有到期日 → 长期 */
  isLongTerm: boolean;
  leadDays: number;
  unitPriceYuan: string;
  amountYuan: string;
  expiry: ExpiryInfo[];
}

interface MoveRow {
  uuid: string;
  movedOn: string;
  qtyDelta: number;
  reason: string;
  reasonLabel: string;
  notes: string | null;
}

/** 单条物品的全部信息：字段 + 到期来源 + 一组库存 + 流水 */
interface ItemDetail {
  item: ItemRow;
  expiry: ExpiryInfo[];
  isLongTerm: boolean;
  remaining: number;
  minStock: number;
  lowStock: boolean;
  isBulk: boolean;
  stocks: BulkStock[];
  stockTotals: { quantity: number; remaining: number; expiresOn: string | null } | null;
  leadDays: number;
  unitPriceYuan: string;
  amountYuan: string;
  moves: MoveRow[];
}

/** 时间轴上的一格 */
interface TimeSlot {
  start: string;
  end: string;
  label: string;
  current: boolean;
}

interface TimelineEntry {
  itemUuid: string;
  itemName: string;
  kind: string;
  expiresOn: string;
  daysLeft: number;
  daysLeftText: string;
  expired: boolean;
  slot: number;
  location: string;
  remaining: number;
  isBulk: boolean;
  unit: string;
}

interface TimelineData {
  granularity: 'day' | 'week' | 'month' | 'year';
  today: string;
  slots: TimeSlot[];
  categories: { key: string; label: string; count: number }[];
  groups: { key: string; label: string; entries: TimelineEntry[]; longTerm: { itemUuid: string; itemName: string; remaining: number; unit: string }[] }[];
  counts: { dated: number; longTerm: number };
}

interface WsStats {
  id: string;
  name: string;
  createdAt: string;
  source: string;
  dir: string;
  dbPath: string;
  dbBytes: number;
  dbBytesText: string;
  schemaVersion: number;
  integrityOk: boolean;
  tableCounts: Record<string, number>;
  verifyMessages: string[];
}

interface ImportPreview {
  canceled: boolean;
  archivePath?: string;
  workspaceName?: string;
  exportedAt?: string;
  formatVersion?: number;
  schemaVersion?: number;
  checksumVerified?: boolean;
  totalRows?: number;
  errorCount?: number;
  warningCount?: number;
  tables?: { table: string; rows: number; errors: number; warnings: number }[];
  issues?: { table: string; line: number; level: string; message: string }[];
}

interface DshApi {
  app: { info(): Promise<AppInfo>; schema(): Promise<SchemaInfo>; manifest(): Promise<unknown> };
  ws: {
    list(): Promise<WsList>;
    create(name: string, seed: boolean): Promise<{ id: string; name: string; seeded: unknown }>;
    use(id: string): Promise<{ id: string; name: string }>;
    rename(id: string, name: string): Promise<{ id: string; name: string }>;
    /** 改名称与备注 */
    update(
      id: string,
      patch: { name?: string; notes?: string },
    ): Promise<{ id: string; name: string; notes: string; source: string; sourceLabel: string }>;
    remove(id: string): Promise<{ id: string; name: string; snapshotPath: string | null }>;
    seed(id: string): Promise<unknown>;
    stats(id?: string): Promise<WsStats>;
    verify(id?: string): Promise<unknown>;
  };
  item: {
    list(wsId: string | null, filter?: Record<string, unknown>): Promise<ItemRow[]>;
    get(wsId: string | null, uuid: string): Promise<ItemDetail>;
    save(wsId: string | null, input: Record<string, unknown>): Promise<{ created: boolean; item: ItemRow }>;
    /** 领用 / 消耗 / 丢弃 / 过期处理 */
    consume(wsId: string | null, uuid: string, qty: number, reason?: string): Promise<unknown>;
    /** 一键清理「非批量且剩余为 0」的记录；dryRun 只取清单 */
    purgeSpent(
      wsId: string | null,
      dryRun?: boolean,
    ): Promise<{ purged: number; items: { uuid: string; name: string; location: string }[]; dryRun: boolean }>;
    delete(wsId: string | null, uuid: string): Promise<{ deleted: boolean }>;
  };
  /** 批量物品的「一组库存」 */
  stock: {
    add(
      wsId: string | null,
      itemUuid: string,
      input: Record<string, unknown>,
    ): Promise<{ created: boolean; stocks: BulkStock[]; totals: { quantity: number; remaining: number } }>;
    update(
      wsId: string | null,
      stockUuid: string,
      input: Record<string, unknown>,
    ): Promise<{ stocks: BulkStock[]; totals: { quantity: number; remaining: number } }>;
    remove(
      wsId: string | null,
      stockUuid: string,
    ): Promise<{ removed: boolean; stocks: BulkStock[]; totals: { quantity: number; remaining: number } }>;
  };
  alert: { summary(wsId?: string | null): Promise<AlertSummary>; multi(): Promise<unknown> };
  /** 分组树（分类 → 子类 → 标签） */
  group: {
    list(
      wsId: string | null,
      opts?: { category?: string; levels?: number; sort?: string },
    ): Promise<GroupTreeResult>;
    /** 存拖动固定下来的组顺序、展开层级、排序字段、收起的分组 */
    prefs(
      wsId: string | null,
      patch: {
        order?: Record<string, string[]>;
        levels?: number;
        sort?: string;
        collapsed?: string[];
        columns?: string[];
      },
    ): Promise<{ groupOrder: Record<string, string[]>; groupLevels: number; sortField: string; collapsed: string[] }>;
  };
  /** 拖动固定物品顺序（传这一组的新顺序，整份覆盖） */
  reorder: {
    items(wsId: string | null, uuids: string[]): Promise<{ reordered: number }>;
  };
  /**
   * 表格列配置。
   *
   * `visible` 是 core 用 `resolveColumns()` 解析后的结果 ——
   * 「物品」「到期时间」无条件在里面，界面不需要自己保证。
   */
  column: {
    get(wsId?: string | null): Promise<{
      available: ColumnDef[];
      locked: string[];
      visible: string[];
      defaults: string[];
      minimal: boolean;
    }>;
    set(wsId: string | null, visible: string[]): Promise<{ visible: string[]; minimal: boolean }>;
  };
  /**
   * 订阅「跨天了」。
   *
   * 剩余时间是算出来的，过了零点要重画。返回退订函数。
   */
  onDateChanged(fn: () => void): () => void;
  /** 时间轴 */
  timeline: {
    data(
      wsId: string | null,
      opts?: { granularity?: string; past?: number; future?: number },
    ): Promise<TimelineData>;
  };
  io: {
    exportWs(wsId?: string | null): Promise<{
      canceled: boolean;
      archivePath?: string;
      bytesText?: string;
      fileCount?: number;
      rowCounts?: Record<string, number>;
    }>;
    previewImport(): Promise<ImportPreview>;
    import(archivePath: string, name?: string): Promise<{
      ok: boolean;
      workspaceId: string | null;
      workspaceName: string;
      rowCounts: Record<string, number>;
      errorCount: number;
      issues: { table: string; line: number; level: string; message: string }[];
    }>;
    openPath(p: string): Promise<unknown>;
    revealPath(p: string): Promise<unknown>;
  };
}

declare global {
  interface Window {
    api: DshApi;
  }
}

// ─── 状态 ───

const state: {
  info: AppInfo | null;
  schema: SchemaInfo | null;
  wsList: WsList | null;
  wsId: string | null;
  alert: AlertSummary | null;
  timeline: TimelineData | null;
  timelineGranularity: 'day' | 'week' | 'month' | 'year';
  timelineCategory: string;
  items: ItemRow[];
  detail: ItemDetail | null;
  tab: 'dashboard' | 'groups' | 'timeline' | 'items' | 'workspaces' | 'schema';
  filter: { search: string; category: string; room: string };
  /** 分组页：服务端算好的树 + 本地筛选 */
  groupTree: GroupTreeResult | null;
  /** 排序字段；'manual' = 排序关闭，按拖动固定下来的顺序 */
  sortField: string;
  sortFields: SortFieldDef[];
  /** 展开到第几级（1~3，一级不可关） */
  groupLevels: number;
  /** 收起的分组路径 */
  collapsed: Set<string>;
  groupOnlyExpired: boolean;
  categoryFilter: string;
  /** 物品页里展开了「一组库存」的行 */
  expanded: Set<string>;
  /** 物品表当前显示哪些列。锁定列一定在里面（由 core 保证） */
  columnVisible: string[];
  /** 可配置的列清单，来自 core */
  columnAvailable: ColumnDef[];
  /** 不可关闭的列 */
  columnLocked: string[];
} = {
  info: null,
  schema: null,
  wsList: null,
  wsId: null,
  alert: null,
  timeline: null,
  timelineGranularity: 'month',
  timelineCategory: '',
  items: [],
  detail: null,
  tab: 'dashboard',
  filter: { search: '', category: '', room: '' },
  groupTree: null,
  sortField: 'manual',
  sortFields: [],
  groupLevels: 1,
  collapsed: new Set<string>(),
  groupOnlyExpired: false,
  categoryFilter: '',
  expanded: new Set<string>(),
  columnVisible: [],
  columnAvailable: [],
  columnLocked: [],
};

/** 把分组树拍平成一份物品清单（概览页、各处统计用） */
function flattenTree(nodes: GroupNode[]): ItemRow[] {
  const out: ItemRow[] = [];
  const walk = (ns: GroupNode[]): void => {
    for (const n of ns) {
      out.push(...n.items);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 分组路径的字符串键：拖动顺序与收起状态都按它存 */
const pathKey = (path: string[]): string => path.join('\u0001');

// ─── 小工具 ───

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`元素不存在: ${sel}`);
  return el as T;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined | (Node | string | null | undefined)[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** 一律走 textContent，绝不拼 HTML —— 物品名里出现 < 也不该出问题 */
function td(text: string | number | null | undefined, cls = ''): HTMLTableCellElement {
  const cell = el('td', cls ? { class: cls } : {});
  cell.textContent = text === null || text === undefined ? '' : String(text);
  return cell;
}

function toast(message: string, kind: 'ok' | 'err' | 'warn' = 'ok'): void {
  const node = el('div', { class: `toast ${kind}`, text: message });
  $('#toast-root').append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 400);
  }, kind === 'err' ? 6000 : 3000);
}

function fail(err: unknown): void {
  const e = err as ApiError;
  toast(e.message || String(err), 'err');
  console.error(err);
}

function enumLabel(name: string | null, key: string | null | undefined): string {
  if (!name || !key) return key ?? '';
  const found = state.schema?.enums[name]?.find((e) => e.key === key);
  return found ? `${found.label}` : key;
}

/** 库存小条：一眼看出「还剩多少 / 低于下限」 */
function stockBar(current: number, limit: number, low: boolean): HTMLElement {
  const wrap = el('div', { class: 'stock-bar' });
  const track = el('div', { class: 'track' });
  const fill = el('div', { class: `fill${low ? ' low' : ''}` });
  const denom = Math.max(limit, current, 1);
  fill.style.width = `${Math.min(100, Math.round((current / denom) * 100))}%`;
  if (current === 0) fill.className = 'fill empty';
  track.append(fill);
  wrap.append(track, el('b', { text: String(current) }));
  return wrap;
}

/** 分区标题：`标题 ──────── 右侧说明`，靠间距和字重表达层级，不用边框 */
function sectionTitle(title: string, right?: string): HTMLElement {
  const h = el('h3');
  h.append(el('span', { text: title }));
  h.append(el('span', { class: 'rule' }));
  if (right) h.append(el('span', { class: 'right muted small', text: right }));
  return h;
}

function viewHead(title: string, ...right: (Node | string)[]): HTMLElement {
  const head = el('div', { class: 'view-head' });
  head.append(el('h2', { class: 'view-title', text: title }));
  for (const r of right) head.append(r);
  return head;
}

/** 所有表格都套一层，才能有粘性表头与独立滚动 */
function tableWrap(t: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'table-wrap' });
  wrap.append(t);
  return wrap;
}

/** 严重度分布条 —— v3 已取消分级，这里保留一个「时间分布」条：过期 / 30 天内 / 之后 / 长期 */
function severityDist(counts: AlertSummary['counts']): HTMLElement | null {
  const later = Math.max(0, counts.dated - counts.expired - counts.soon);
  const segs: { key: string; label: string; value: number; color: string }[] = [
    { key: 'expired', label: '已过期', value: counts.expired, color: 'var(--danger)' },
    { key: 'soon', label: '30 天内', value: counts.soon, color: 'var(--warn)' },
    { key: 'later', label: '之后', value: later, color: 'var(--info)' },
    { key: 'longTerm', label: '长期', value: counts.longTerm, color: 'var(--fg-faint)' },
  ].filter((s) => s.value > 0);
  if (segs.length === 0) return null;

  const total = segs.reduce((n, s) => n + s.value, 0);
  const box = el('div', { class: 'dist' });

  const bar = el('div', { class: 'dist-bar' });
  for (const s of segs) {
    const seg = el('div', { class: 'dist-seg' });
    seg.style.width = `${(s.value / total) * 100}%`;
    seg.style.background = s.color;
    seg.title = `${s.label} ${s.value}`;
    bar.append(seg);
  }
  box.append(bar);

  const legend = el('div', { class: 'dist-legend' });
  for (const s of segs) {
    const item = el('span');
    const swatch = el('i');
    swatch.style.background = s.color;
    item.append(swatch, el('b', { text: String(s.value) }), document.createTextNode(` ${s.label}`));
    legend.append(item);
  }
  box.append(legend);
  return box;
}


function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 19).replace('T', ' ');
}

// ─── 模态框 ───

interface ModalSpec {
  title: string;
  body: HTMLElement;
  actions: { label: string; kind?: 'primary' | 'danger' | 'ghost'; onClick: () => unknown }[];
  wide?: boolean;
}

function openModal(spec: ModalSpec): void {
  const root = $('#modal-root');
  root.innerHTML = '';
  root.classList.remove('hidden');

  const close = (): void => {
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  const box = el('div', { class: spec.wide ? 'modal wide' : 'modal' });
  box.append(el('h2', { text: spec.title }));
  const body = el('div', { class: 'modal-body' });
  body.append(spec.body);
  box.append(body);

  const actions = el('div', { class: 'modal-actions' });
  for (const a of spec.actions) {
    const btn = el('button', { class: a.kind ?? 'ghost', text: a.label });
    btn.addEventListener('click', async () => {
      try {
        await a.onClick();
      } catch (err) {
        fail(err);
      }
    });
    actions.append(btn);
  }
  const cancel = el('button', { class: 'ghost', text: '取消' });
  cancel.addEventListener('click', close);
  actions.append(cancel);
  box.append(actions);

  root.append(box);
  root.addEventListener('click', (ev) => {
    if (ev.target === root) close();
  });

  const first = box.querySelector('input,select,textarea') as HTMLElement | null;
  first?.focus();
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('label', { class: 'field' });
  wrap.append(el('span', { class: 'field-label', text: label }));
  wrap.append(control);
  if (hint) wrap.append(el('span', { class: 'field-hint', text: hint }));
  return wrap;
}

function input(name: string, value = '', type = 'text', placeholder = ''): HTMLInputElement {
  const i = el('input', { type, name });
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function select(name: string, options: { value: string; label: string }[], value = ''): HTMLSelectElement {
  const s = el('select', { name });
  for (const o of options) {
    const opt = el('option', { value: o.value, text: o.label });
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

/** 从模态框里收集 <input name=...> 的值 */
function collect(box: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  box.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((n) => {
    out[n.getAttribute('name')!] = n.value;
  });
  return out;
}

// ─── 数据加载 ───

async function refreshWorkspaces(): Promise<void> {
  state.wsList = await window.api.ws.list();
  if (!state.wsId || !state.wsList.workspaces.some((w) => w.id === state.wsId)) {
    state.wsId = state.wsList.activeWorkspaceId ?? state.wsList.workspaces[0]?.id ?? null;
  }
  renderWsPicker();
}

/** 自绘的工作区选择器。原生 <select> 没法在深色主题下好看，也没法放计数与来源。 */
function renderWsPicker(): void {
  const host = $('#ws-picker');
  host.innerHTML = '';

  const list = state.wsList?.workspaces ?? [];
  const current = list.find((w) => w.id === state.wsId) ?? null;

  const trigger = el('button', { class: 'wsp-trigger', type: 'button' });
  trigger.append(el('span', { class: 'wsp-dot' }));
  trigger.append(el('span', { class: 'wsp-name', text: current?.name ?? '（还没有工作区）' }));
  if (current && current.items !== null) {
    trigger.append(el('span', { class: 'wsp-count', text: `${current.items} 件` }));
  }
  trigger.append(el('span', { class: 'wsp-caret', text: '▾' }));
  host.append(trigger);

  const panel = el('div', { class: 'wsp-panel hidden' });

  if (list.length === 0) {
    panel.append(el('div', { class: 'wsp-empty', text: '还没有工作区' }));
  } else {
    for (const w of list) {
      const item = el('button', { class: `wsp-item${w.id === state.wsId ? ' active' : ''}`, type: 'button' });

      const main = el('div', { class: 'wsp-item-main' });
      main.append(el('span', { class: 'wsp-item-name', text: w.name }));
      const meta = el('span', { class: 'wsp-item-meta' });
      meta.append(el('span', { class: `chip-src src-${w.source}`, text: w.sourceLabel }));
      meta.append(document.createTextNode(` ${w.items ?? 0} 件`));
      main.append(meta);
      item.append(main);

      if (w.notes) item.append(el('div', { class: 'wsp-item-notes', text: w.notes }));
      if (w.id === state.wsId) item.append(el('span', { class: 'wsp-check', text: '✓' }));

      item.addEventListener('click', () => {
        closePanel();
        if (w.id !== state.wsId) void switchWorkspace(w.id);
      });
      panel.append(item);
    }
  }

  const footer = el('div', { class: 'wsp-footer' });
  const newBtn = el('button', { class: 'ghost small', text: '＋ 新建工作区' });
  newBtn.addEventListener('click', () => {
    closePanel();
    openNewWorkspace();
  });
  const manageBtn = el('button', { class: 'ghost small', text: '管理工作区' });
  manageBtn.addEventListener('click', () => {
    closePanel();
    setTab('workspaces');
  });
  footer.append(newBtn, manageBtn);
  panel.append(footer);

  host.append(panel);

  /** 面板浮层：点外部或按 Esc 关闭 */
  const closePanel = (): void => {
    panel.classList.add('hidden');
    trigger.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  };
  const onOutside = (ev: MouseEvent): void => {
    if (!host.contains(ev.target as Node)) closePanel();
  };
  const onEsc = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') closePanel();
  };

  trigger.addEventListener('click', () => {
    const open = panel.classList.contains('hidden');
    if (open) {
      panel.classList.remove('hidden');
      trigger.classList.add('open');
      // 捕获阶段监听，才能抢在其它点击处理之前判断「点的是不是面板外」
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    } else {
      closePanel();
    }
  });
}

async function refreshAlerts(): Promise<void> {
  if (!state.wsId) {
    state.alert = null;
    return;
  }
  state.alert = await window.api.alert.summary(state.wsId);
}

/** 时间轴数据（粒度或工作区变了才需要重新算） */
async function loadTimeline(): Promise<void> {
  if (!state.wsId) {
    state.timeline = null;
    return;
  }
  state.timeline = await window.api.timeline.data(state.wsId, {
    granularity: state.timelineGranularity,
  });
}

/** 拉分组树（层级、排序字段、组顺序都由工作区偏好决定） */
async function loadGroupTree(): Promise<void> {
  if (!state.wsId) {
    state.groupTree = null;
    return;
  }
  state.groupTree = await window.api.group.list(state.wsId, {
    levels: state.groupLevels,
    sort: state.sortField,
  });
  state.groupLevels = state.groupTree.requestedLevels;
  state.sortField = state.groupTree.sortedBy;
  state.collapsed = new Set(state.groupTree.collapsed);
  // 分组接口顺带把列配置带回来了，省一次往返
  if (Array.isArray(state.groupTree.columns)) state.columnVisible = state.groupTree.columns;
}

/**
 * 加载列配置。
 *
 * 界面**不自己算**"哪些列必须有" —— `visible` 是 core 用 `resolveColumns()`
 * 解析出来的，锁定列无条件在里面。界面只负责把 `available` 画成勾选框。
 */
async function loadColumns(): Promise<void> {
  try {
    const r = await window.api.column.get(state.wsId);
    state.columnAvailable = r.available;
    state.columnLocked = r.locked;
    state.columnVisible = r.visible;
  } catch (err) {
    fail(err);
  }
}

/**
 * 列设置。
 *
 * 勾选框按列定义生成，「物品」「到期时间」标成**必显且禁用**并给出理由 ——
 * 不是灰掉一个框就完事，要让用户明白为什么不能关。
 *
 * 即时生效：每勾一下立刻存并重画，不搞"确定/取消"——
 * 用户能马上看到表变成什么样，改动也是可逆的。
 */
function openColumnSettings(): void {
  const body = el('div', { class: 'col-config' });

  body.append(
    el('p', {
      class: 'muted small',
      text: '选择物品表显示哪些列。物品页、分组页、概览的「最先到期」共用这一份设置，按工作区各自保存。',
    }),
  );

  const list = el('div', { class: 'col-list' });

  const redraw = (): void => {
    list.innerHTML = '';
    for (const c of state.columnAvailable) {
      const on = state.columnVisible.includes(c.key);
      const locked = state.columnLocked.includes(c.key);

      const row = el('label', { class: `col-row${locked ? ' locked' : ''}` });
      const box = el('input', { type: 'checkbox', name: `col_${c.key}` }) as HTMLInputElement;
      box.checked = on || locked;
      box.disabled = locked;

      const text = el('span', { class: 'col-text' });
      text.append(el('b', { text: c.label }));
      if (locked) text.append(el('span', { class: 'col-lock', text: '必显' }));
      text.append(el('span', { class: 'col-hint', text: c.hint }));
      row.append(box, text);

      if (!locked) {
        box.addEventListener('change', () => {
          void applyColumnChange(c.key, box.checked);
        });
      }
      list.append(row);
    }
  };

  /** 勾一下：本地先算出新清单，交给 core 存，再按 core 的结果回填 */
  async function applyColumnChange(key: string, on: boolean): Promise<void> {
    const next = new Set(state.columnVisible);
    if (on) next.add(key);
    else next.delete(key);
    try {
      const r = await window.api.column.set(state.wsId, [...next]);
      // 用 core 返回的结果，而不是本地那份 —— 锁定列可能被补回来
      state.columnVisible = r.visible;
      redraw();
      render();
    } catch (err) {
      fail(err);
      redraw();
    }
  }

  const reset = el('button', { class: 'ghost small', text: '恢复默认列' });
  reset.addEventListener('click', () => {
    void (async () => {
      try {
        const defaults = state.columnAvailable.filter((c) => c.defaultOn).map((c) => c.key);
        const r = await window.api.column.set(state.wsId, defaults);
        state.columnVisible = r.visible;
        redraw();
        render();
      } catch (err) {
        fail(err);
      }
    })();
  });

  redraw();
  body.append(list, el('div', { class: 'col-actions' }, reset));

  openModal({
    title: '列设置',
    body,
    actions: [{ label: '完成', kind: 'primary', onClick: () => $('#modal-root').classList.add('hidden') }],
  });
}

/** 存界面偏好（组顺序 / 层级 / 排序字段 / 收起状态 / 列） */
async function savePrefs(patch: {
  order?: Record<string, string[]>;
  levels?: number;
  sort?: string;
  collapsed?: string[];
  columns?: string[];
}): Promise<void> {
  if (!state.wsId) return;
  try {
    await window.api.group.prefs(state.wsId, patch);
  } catch (err) {
    fail(err);
  }
}

/** 排序字段清单来自 core，界面不自己维护一份 */async function loadSortFields(): Promise<void> {
  const schema = state.schema as unknown as { sortFields?: SortFieldDef[] } | null;
  if (schema?.sortFields) {
    state.sortFields = schema.sortFields;
    return;
  }
  // 兜底：清单没拿到时至少保证「手动顺序」在
  state.sortFields = [{ key: 'manual', label: '手动顺序', desc: false, hint: '按你拖动固定下来的顺序' }];
}

async function refreshItems(): Promise<void> {
  if (!state.wsId) {
    state.items = [];
    return;
  }
  const filter: Record<string, unknown> = {};
  if (state.filter.search) filter['search'] = state.filter.search;
  if (state.filter.category) filter['category'] = state.filter.category;
  if (state.filter.room) filter['room'] = state.filter.room;
  state.items = await window.api.item.list(state.wsId, filter);
}

async function reloadAll(): Promise<void> {
  await refreshWorkspaces();
  await Promise.all([refreshAlerts(), refreshItems(), loadTimeline(), loadGroupTree(), loadColumns()]);
  renderBanner();
  render();
}

// ─── 顶部横幅（核心）───

/**
 * 顶部横幅。
 *
 * v3 不再按严重度分四档报数，只报三件用户真正会行动的事：
 * 已过期、30 天内到期、待补货。
 */
function renderBanner(): void {
  const banner = $('#banner');
  const text = $('#banner-text');
  const chips = $('#banner-chips');
  const a = state.alert;

  text.innerHTML = '';
  chips.innerHTML = '';
  updateTabCounts();

  if (!a) {
    banner.className = 'ok';
    text.append(document.createTextNode('还没有工作区 —— 到「工作区」页新建一个，或直接导入一个归档。'));
    return;
  }

  const { expired, soon, lowStock, items } = a.counts;
  const actionable = expired + soon + lowStock;

  if (actionable === 0) {
    banner.className = 'ok';
    text.append(el('strong', { text: a.workspaceName }));
    text.append(document.createTextNode(`：${items} 项在用，没有需要马上处理的`));
    return;
  }

  banner.className = expired > 0 ? 'danger' : 'info';

  text.append(el('strong', { text: a.workspaceName }));
  text.append(document.createTextNode('：'));
  text.append(el('b', { text: String(actionable) }));
  text.append(document.createTextNode(' 项需要留意'));

  const add = (label: string, cls: string, onClick: () => void): void => {
    const chip = el('button', { class: `chip ${cls}`, text: label });
    chip.addEventListener('click', onClick);
    chips.append(chip);
  };

  if (expired > 0) add(`${expired} 项已过期`, 'danger', () => setTab('groups'));
  if (soon > 0) add(`${soon} 项 30 天内到期`, 'info', () => setTab('timeline'));
  if (lowStock > 0) add(`${lowStock} 项待补货`, 'info', () => setTab('items'));
  if (a.counts.longTerm > 0) add(`${a.counts.longTerm} 项长期`, 'ghost', () => setTab('groups'));
}

/** 把数量显示在导航上，不用切页就知道有多少事 */
function updateTabCounts(): void {
  const a = state.alert;
  const counts: Record<string, number> = {
    items: state.items.length,
    workspaces: state.wsList?.workspaces.length ?? 0,
    groups: a?.counts.items ?? 0,
  };
  document.querySelectorAll('.tab').forEach((btn) => {
    const tab = (btn as HTMLElement).dataset['tab']!;
    btn.querySelector('.count')?.remove();
    const n = counts[tab];
    if (n === undefined || n === 0) return;
    const badge = el('span', { class: 'count', text: String(n) });
    if (tab === 'groups' && (a?.counts.expired ?? 0) > 0) badge.classList.add('hot');
    btn.append(badge);
  });
}

// ─── 视图 ───

function setTab(tab: typeof state.tab): void {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset['tab'] === tab);
  });
  render();
}

function render(): void {
  const view = $('#view');
  view.innerHTML = '';
  // 只有工作区页需要固定底栏；切走时清掉，避免影响别的页面的滚动
  view.classList.remove('has-footer');
  view.classList.remove('no-pad');
  if (!state.wsId && state.tab !== 'workspaces' && state.tab !== 'schema') {
    view.append(emptyState());
    return;
  }
  switch (state.tab) {
    case 'dashboard':
      renderDashboard(view);
      break;
    case 'groups':
      renderGroups(view);
      break;
    case 'timeline':
      renderTimeline(view);
      break;
    case 'items':
      renderItems(view);
      break;
    case 'workspaces':
      renderWorkspaces(view);
      break;
    case 'schema':
      renderSchema(view);
      break;
  }
}

function emptyState(): HTMLElement {
  const wrap = el('div', { class: 'empty' });
  wrap.append(el('h2', { text: '还没有工作区' }));
  wrap.append(
    el('p', {
      text: '工作区是完全隔离的存储空间：一个工作区一个 SQLite 文件，互不感知、互不影响。可以是「自己家」「父母家」，也可以是不同用途。',
    }),
  );
  const actions = el('div', { class: 'row' });
  const b1 = el('button', { class: 'primary', text: '新建工作区' });
  b1.addEventListener('click', () => setTab('workspaces'));
  const b2 = el('button', { class: 'ghost', text: '导入归档' });
  b2.addEventListener('click', () => void doImport());
  actions.append(b1, b2);
  wrap.append(actions);
  return wrap;
}

function card(title: string, value: string, sub?: string, cls = ''): HTMLElement {
  const c = el('div', { class: `card ${cls}` });
  c.append(el('div', { class: 'card-title', text: title }));
  c.append(el('div', { class: 'card-value', text: value }));
  if (sub) c.append(el('div', { class: 'card-sub', text: sub }));
  return c;
}

function renderDashboard(view: HTMLElement): void {
  const a = state.alert;
  const grid = el('div', { class: 'grid' });

  grid.append(card('物品', String(state.items.length), '当前工作区', 'muted'));
  grid.append(
    card(
      '已过期',
      String(a?.counts.expired ?? 0),
      a && a.counts.expired > 0 ? '建议尽快处理' : '没有过期物品',
      a && a.counts.expired > 0 ? 'danger' : 'ok',
    ),
  );
  grid.append(
    card(
      '30 天内到期',
      String(a?.counts.soon ?? 0),
      a && a.counts.soon > 0 ? '该留意了' : '近期没有到期的',
      a && a.counts.soon > 0 ? 'warn' : 'muted',
    ),
  );
  grid.append(
    card(
      '长期',
      String(a?.counts.longTerm ?? 0),
      '没有到期日，不用盯',
      'muted',
    ),
  );
  grid.append(
    card(
      '待补货',
      String(a?.counts.lowStock ?? 0),
      a && a.counts.lowStock > 0 ? '低于最低库存' : '库存充足',
      a && a.counts.lowStock > 0 ? 'info' : 'ok',
    ),
  );

  view.append(grid);

  if (a) {
    const dist = severityDist(a.counts);
    if (dist) view.append(dist);
  }

  // 把分组树里的物品拍平，挑出有到期日的按到期日升序 —— 顺序就是优先级
  const flat = state.groupTree ? flattenTree(state.groupTree.groups) : [];
  const allDated = flat
    .filter((it) => !it.isLongTerm)
    .sort((x, y) => String(x.expiresOn).localeCompare(String(y.expiresOn)));
  if (allDated.length > 0) {
    view.append(
      sectionTitle('最先到期的', allDated.length > 8 ? `共 ${allDated.length} 项，显示前 8 项` : `共 ${allDated.length} 项`),
    );
    view.append(tableWrap(itemsTable(allDated.slice(0, 8))));
  }

  if (a && a.lowStock.length > 0) {
    view.append(sectionTitle('待补货', `${a.lowStock.length} 项`));
    view.append(tableWrap(restockTable(a.lowStock)));
  }
}

/** 待补货表：概览页与分组页共用 */
function restockTable(rows: RestockRow[]): HTMLElement {
  const t = el('table');
  const head = el('tr');
  for (const h of ['名称', '分类', '剩余', '最低库存']) head.append(el('th', { text: h }));
  head.append(el('th', { class: 'right', text: '缺口' }));
  t.append(el('thead', {}, head));

  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    const nameCell = el('td');
    const link = el('a', { class: 'link', text: r.itemName });
    link.addEventListener('click', () => void openItem(r.itemUuid));
    nameCell.append(link);
    tr.append(nameCell);
    tr.append(td(enumLabel('item_category', r.category), 'muted'));
    const stock = el('td');
    stock.append(stockBar(r.remaining, r.minStock, true));
    tr.append(stock);
    tr.append(td(r.minStock, 'right'), td(r.shortfall, 'right danger-text'));
    body.append(tr);
  }
  t.append(body);
  return t;
}

/**
 * 「最先到期」表。
 *
 * 用的是与物品页、分组页**同一份列配置** —— 三处是同一份物品清单，
 * 列不一致会让人以为看到的是不同的数据。
 */
function itemsTable(items: ItemRow[]): HTMLElement {
  const cols = visibleItemCols(state.columnVisible);
  const t = el('table');
  const head = el('tr');
  for (const c of cols) {
    head.append(el('th', { class: c.align === 'right' ? 'right' : '', text: c.head }));
  }
  t.append(el('thead', {}, head));

  const body = el('tbody');
  for (const it of items) {
    const expired = it.expiry.some((e) => e.expired);
    const tr = el('tr', { class: expired ? 'row-expired' : '' });

    const bulk = it.is_bulk === 'true';
    const worst = it.expiry.find((e) => e.expired) ?? (it.isLongTerm ? undefined : it.expiry[0]);
    const ctx: ColCtx = { worst, bulk };
    for (const c of cols) {
      const cell = c.cell(it, ctx);
      // 概览页要在名称旁多标一个「已过期」——这一页就是给你扫过期的
      if (c.key === 'name' && expired) cell.append(el('span', { class: 'tag danger', text: '已过期' }));
      tr.append(cell);
    }
    body.append(tr);
  }
  t.append(body);
  return t;
}

/**
 * 分组页。
 *
 * ── 三条互相独立的规则，界面上必须让人一眼看出哪条在生效 ──
 *
 * 1. **分组**：分类 → 子类 → 标签，最多三层。一级默认开着，且关不掉。
 * 2. **排序**：默认关闭。关着时物品按拖动固定下来的顺序排，**可以拖**；
 *    开启后按字段排，**拖动被禁用**（拖了也会被排序覆盖，看着像坏了）。
 * 3. **组顺序**：每一级都能拖动固定。「未分类」永远置顶且不可拖。
 *
 * 排序只影响组内物品的顺序，不影响分组本身，也不影响组之间的顺序。
 */
function renderGroups(view: HTMLElement): void {
  const tree = state.groupTree;
  if (!tree) {
    view.append(el('div', { class: 'empty', text: '正在整理分组…' }));
    return;
  }
  const a = state.alert;

  view.append(
    viewHead(
      '分组',
      el('span', {
        class: 'muted small',
        text: state.sortField === 'manual'
          ? '排序已关闭：物品按你拖动固定下来的顺序排列，可以继续拖'
          : '排序已开启：物品按字段排列，拖动已禁用；关掉排序就回到你手工摆的顺序',
      }),
    ),
  );

  // ── 未分类提示：置顶且醒目，推动用户去分类 ──
  if (tree.uncategorized > 0) {
    const warn = el('div', { class: 'uncat-banner' });
    warn.append(el('span', { class: 'uncat-dot' }));
    warn.append(
      el('span', {
        text: `有 ${tree.uncategorized} 件物品还没分类，它们在「未分类」组里 —— 这一组永远在最上面，不会被排序或拖动移走。`,
      }),
    );
    view.append(warn);
  }

  // ── 工具栏 ──
  const bar = el('div', { class: 'toolbar' });

  // 分组层级：一级不可关
  const lvWrap = el('div', { class: 'seg' });
  for (const n of [1, 2, 3] as const) {
    const btn = el('button', {
      class: `seg-btn${state.groupLevels === n ? ' active' : ''}`,
      text: `${n} 级`,
      type: 'button',
    });
    btn.title =
      n === 1
        ? '一级分组（分类）默认开启，不可关闭'
        : n === 2
          ? '二级：再按子类拆开'
          : '三级：再按标签拆开（一个物品可以有多个标签，会出现在多组里）';
    btn.addEventListener('click', () => {
      state.groupLevels = n;
      void savePrefs({ levels: n });
      void loadGroupTree().then(render);
    });
    lvWrap.append(btn);
  }
  bar.append(el('span', { class: 'tl-label', text: '分组' }), lvWrap);

  // 排序开关 + 字段
  const sortBox = el('label', { class: 'check mini sort-switch' });
  const sortOn = el('input', { type: 'checkbox' }) as HTMLInputElement;
  sortOn.checked = state.sortField !== 'manual';
  sortBox.append(sortOn, el('span', { text: '开启排序' }));
  sortBox.title = '开启后按字段排序，物品不可拖动；关闭则回到你拖动固定的顺序';
  bar.append(sortBox);

  const sortSel = select(
    'sortField',
    state.sortFields.map((f) => ({ value: f.key, label: f.label })),
    state.sortField,
  );
  sortSel.disabled = state.sortField === 'manual';
  const applySort = (field: string): void => {
    state.sortField = field;
    void savePrefs({ sort: field });
    void loadGroupTree().then(render);
  };
  sortOn.addEventListener('change', () => applySort(sortOn.checked ? 'expiry' : 'manual'));
  sortSel.addEventListener('change', () => applySort(sortSel.value));
  bar.append(sortSel);

  if (state.sortField !== 'manual') {
    const def = state.sortFields.find((f) => f.key === state.sortField);
    if (def) bar.append(el('span', { class: 'muted small', text: def.hint }));
  } else {
    bar.append(el('span', { class: 'muted small', text: '拖动行首的手柄可以固定顺序' }));
  }

  // 分类筛选（只看某一级分组）
  if (tree.groups.length > 1) {
    const catSel = select(
      'groupCat',
      [{ value: '', label: '全部分类' }, ...tree.groups.map((g) => ({ value: g.key, label: `${g.label}（${g.count}）` }))],
      state.categoryFilter,
    );
    catSel.addEventListener('change', () => {
      state.categoryFilter = catSel.value;
      render();
    });
    bar.append(catSel);
  }

  const onlyExpired = el('label', { class: 'check mini' });
  const oeBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  oeBox.checked = state.groupOnlyExpired;
  oeBox.addEventListener('change', () => {
    state.groupOnlyExpired = oeBox.checked;
    render();
  });
  onlyExpired.append(oeBox, el('span', { text: '只看已过期' }));
  bar.append(onlyExpired);

  const collapseAll = el('button', { class: 'ghost small', text: '全部收起' });
  collapseAll.addEventListener('click', () => {
    const all: string[] = [];
    const walk = (ns: GroupNode[]): void => {
      for (const n of ns) {
        if (n.children.length > 0) all.push(pathKey(n.path));
        walk(n.children);
      }
    };
    walk(tree.groups);
    state.collapsed = new Set(all);
    void savePrefs({ collapsed: [...state.collapsed] });
    render();
  });
  const expandAll = el('button', { class: 'ghost small', text: '全部展开' });
  expandAll.addEventListener('click', () => {
    state.collapsed = new Set();
    void savePrefs({ collapsed: [] });
    render();
  });
  bar.append(collapseAll, expandAll);

  view.append(bar);

  // ── 树 ──
  const roots = state.categoryFilter
    ? tree.groups.filter((g) => g.key === state.categoryFilter)
    : tree.groups;

  let shown = 0;
  for (const node of roots) {
    const sec = buildGroupNode(node, 0);
    if (sec) {
      view.append(sec);
      shown += 1;
    }
  }

  if (shown === 0) {
    const empty = el('div', { class: 'empty' });
    empty.append(el('h2', { text: tree.total === 0 ? '这个工作区还是空的' : '没有匹配的物品' }));
    empty.append(
      el('p', {
        text:
          tree.total === 0
            ? '新增物品时填上到期日与分类，这里就会分组列出来。'
            : '换个分类，或把「只看已过期」取消掉。',
      }),
    );
    view.append(empty);
  }

  // ── 待补货 ──
  if (a && a.lowStock.length > 0) {
    view.append(sectionTitle('待补货', `${a.lowStock.length} 项`));
    view.append(tableWrap(restockTable(a.lowStock)));
  }

  /** 渲染一个分组节点；没有可显示内容时返回 null */
  function buildGroupNode(node: GroupNode, depth: number): HTMLElement | null {
    let items = node.items;
    if (state.groupOnlyExpired) items = items.filter((it) => it.expiry.some((e) => e.expired));
    const kids = node.children.map((c) => buildGroupNode(c, depth + 1)).filter((x): x is HTMLElement => x !== null);
    if (items.length === 0 && kids.length === 0) return null;

    const key = pathKey(node.path);
    const isCollapsed = state.collapsed.has(key);

    const sec = el('section', {
      class: `group-section lv-${node.level}${node.pinned ? ' pinned' : ''}`,
    });
    sec.dataset['path'] = key;
    sec.dataset['level'] = String(node.level);

    // ── 组标题：可拖动（未分类除外）、可点开收起 ──
    const head = el('div', { class: 'group-head' });
    head.dataset['path'] = key;
    head.dataset['level'] = String(node.level);
    // 缩进用左内边距表达层级，不用嵌套盒子
    head.style.paddingLeft = `${12 + depth * 18}px`;

    const caret = el('button', {
      class: `caret${isCollapsed ? ' collapsed' : ''}`,
      type: 'button',
      text: '▾',
    });
    caret.title = isCollapsed ? '展开' : '收起';
    caret.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleCollapse(key);
    });
    head.append(caret);

    if (node.pinned) {
      head.append(el('span', { class: 'pin', text: '📌' }));
      head.title = '未分类：永远置顶，不可拖动';
    } else {
      const grip = el('span', { class: 'grip', text: '⋮⋮' });
      grip.title = '拖动可以固定这一组的顺序';
      head.append(grip);
      makeGroupDraggable(head, node, sec);
    }

    head.append(el('span', { class: 'group-label', text: node.label }));

    const meta = el('span', { class: 'group-meta' });
    meta.append(el('span', { class: 'muted', text: `${node.count} 项` }));
    if (node.expired) meta.append(el('span', { class: 'badge danger', text: `${node.expired} 已过期` }));
    if (node.soon) meta.append(el('span', { class: 'badge info', text: `${node.soon} 30 天内` }));
    if (node.longTerm) meta.append(el('span', { class: 'muted', text: `${node.longTerm} 长期` }));
    if (node.pinned) meta.append(el('span', { class: 'muted small', text: '置顶 · 不可拖动' }));
    head.append(meta);

    head.addEventListener('click', () => toggleCollapse(key));
    sec.append(head);

    // ── 组内容 ──
    if (!isCollapsed) {
      const body = el('div', { class: 'group-body' });
      if (items.length > 0) body.append(groupItemsTable(items, node));
      for (const k of kids) body.append(k);
      sec.append(body);
    }

    return sec;
  }
}

function toggleCollapse(key: string): void {
  if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  void savePrefs({ collapsed: [...state.collapsed] });
  render();
}

/**
 * 组内物品表。
 *
 * 排序关闭时每行前面有拖动手柄；开启排序时手柄消失 ——
 * 让「现在能不能拖」这件事从界面上直接看得出来，而不是拖了没反应。
 */
function groupItemsTable(items: ItemRow[], node: GroupNode): HTMLElement {
  const draggable = state.sortField === 'manual';
  const cols = visibleItemCols(state.columnVisible);

  const t = el('table', { class: 'items group-items' });
  const head = el('tr');
  if (draggable) head.append(el('th', { class: 'seq', text: '' }));
  head.append(el('th', { class: 'seq', text: '#' }));
  for (const c of cols) {
    head.append(el('th', { class: c.align === 'right' ? 'right' : '', text: c.head }));
  }
  head.append(el('th', { text: '' }));
  t.append(el('thead', {}, head));

  const body = el('tbody');
  body.dataset['path'] = pathKey(node.path);
  if (draggable) body.dataset['droppable'] = '1';

  items.forEach((it, i) => {
    const tr = el('tr', { class: 'item-row' });
    tr.dataset['uuid'] = it.uuid;
    if (draggable) {
      tr.draggable = true;
      const grip = el('td', { class: 'drag-handle', text: '⋮⋮' });
      grip.title = '拖动改变顺序';
      tr.append(grip);
      makeItemDraggable(tr, body);
    }

    // 位次：排序开着时是排序后的位置，关着时就是手动顺序的位置
    tr.append(td(String(i + 1), 'seq muted'));

    const bulk = it.is_bulk === 'true';
    const worst = it.expiry.find((e) => e.expired) ?? (it.isLongTerm ? undefined : it.expiry[0]);
    const ctx: ColCtx = { worst, bulk };
    for (const c of cols) tr.append(c.cell(it, ctx));

    const ops = el('td', { class: 'ops' });
    const use = el('button', { class: 'ghost small', text: bulk ? '领用' : '消耗' });
    use.addEventListener('click', () => void doConsume(it, bulk ? 1 : it.remaining, 'consume'));
    const edit = el('button', { class: 'ghost small', text: '编辑' });
    edit.addEventListener('click', () => openItemForm(it.uuid));
    ops.append(use, edit);
    tr.append(ops);

    body.append(tr);
  });

  t.append(body);
  if (draggable) wireItemDrop(body, node);
  return tableWrap(t);
}

// ─────────────────────────────────────────────────────────────
// 拖动：物品顺序
// ─────────────────────────────────────────────────────────────

function makeItemDraggable(tr: HTMLElement, body: HTMLElement): void {
  tr.addEventListener('dragstart', (ev) => {
    draggingUuid = tr.dataset['uuid'] ?? null;
    tr.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', draggingUuid ?? '');
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  tr.addEventListener('dragend', () => {
    tr.classList.remove('dragging');
    draggingUuid = null;
    body.querySelectorAll('.drop-before, .drop-after').forEach((n) =>
      n.classList.remove('drop-before', 'drop-after'),
    );
  });

  // 拖动经过时给出「会插到哪」的视觉提示
  tr.addEventListener('dragover', (ev) => {
    if (!draggingUuid || draggingUuid === tr.dataset['uuid']) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const rect = tr.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    tr.classList.toggle('drop-before', !after);
    tr.classList.toggle('drop-after', after);
  });
  tr.addEventListener('dragleave', () => {
    tr.classList.remove('drop-before', 'drop-after');
  });
}

/** 同一组内的拖放：算出新顺序，整份交给后端 */
function wireItemDrop(body: HTMLElement, node: GroupNode): void {
  const finish = (ev: DragEvent, target: HTMLElement | null): void => {
    ev.preventDefault();
    if (!draggingUuid) return;

    const rows = [...body.querySelectorAll<HTMLElement>('tr.item-row')];
    const uuids = rows.map((r) => r.dataset['uuid']!).filter(Boolean);
    const from = uuids.indexOf(draggingUuid);
    if (from < 0) return;

    uuids.splice(from, 1);
    let to = uuids.length;
    if (target) {
      const targetUuid = target.dataset['uuid']!;
      const rect = target.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      const idx = uuids.indexOf(targetUuid);
      to = idx < 0 ? uuids.length : after ? idx + 1 : idx;
    }
    uuids.splice(to, 0, draggingUuid);

    // 顺序没变就别打扰后端
    const before = rows.map((r) => r.dataset['uuid']!);
    if (before.join() === uuids.join()) {
      body.querySelectorAll('.drop-before, .drop-after').forEach((n) =>
        n.classList.remove('drop-before', 'drop-after'),
      );
      return;
    }

    draggingUuid = null;
    void window.api.reorder
      .items(state.wsId, uuids)
      .then(() => {
        toast(`已固定「${node.label}」的顺序`);
        return loadGroupTree();
      })
      .then(render)
      .catch(fail);
  };

  body.addEventListener('dragover', (ev) => {
    if (!draggingUuid) return;
    ev.preventDefault();
  });
  body.addEventListener('drop', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('tr.item-row');
    finish(ev, target);
  });
}

// ─────────────────────────────────────────────────────────────
// 拖动：分组顺序
// ─────────────────────────────────────────────────────────────

function makeGroupDraggable(head: HTMLElement, node: GroupNode, sec: HTMLElement): void {
  head.draggable = true;
  head.addEventListener('dragstart', (ev) => {
    draggingGroup = pathKey(node.path);
    sec.classList.add('dragging');
    ev.dataTransfer?.setData('text/plain', draggingGroup);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
  });
  head.addEventListener('dragend', () => {
    sec.classList.remove('dragging');
    draggingGroup = null;
    document.querySelectorAll('.group-head.drop-before, .group-head.drop-after').forEach((n) =>
      n.classList.remove('drop-before', 'drop-after'),
    );
  });

  head.addEventListener('dragover', (ev) => {
    if (!draggingGroup || draggingGroup === pathKey(node.path)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const rect = head.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    head.classList.toggle('drop-before', !after);
    head.classList.toggle('drop-after', after);
  });
  head.addEventListener('dragleave', () => {
    head.classList.remove('drop-before', 'drop-after');
  });
  head.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!draggingGroup) return;
    const rect = head.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    void dropGroup(node, after);
  });
}

/**
 * 把拖动的组落到目标位置。
 *
 * 只重排**同一个父级下**的组 —— 把一组从「药品」拖进「日用品」是没有意义的，
 * 那样只会让人困惑（它到底还是不是药品？）。
 */
async function dropGroup(target: GroupNode, after: boolean): Promise<void> {
  const dragged = draggingGroup;
  draggingGroup = null;
  if (!dragged) return;

  const tree = state.groupTree;
  if (!tree) return;

  // 找到目标所在的那一层
  const parentPathKey = pathKey(target.path.slice(0, -1));
  const siblings = collectSiblings(tree.groups, parentPathKey);
  if (!siblings) return;

  const targetKey = target.path[target.path.length - 1]!;
  const draggedKey = dragged.split('\u0001')[target.path.length - 1] ?? '';
  if (draggedKey === targetKey) return;

  // 只能和同一父级下的兄弟换位置
  if (!siblings.includes(draggedKey)) return;

  const next = siblings.filter((k) => k !== draggedKey);
  const at = next.indexOf(targetKey);
  next.splice(after ? at + 1 : at, 0, draggedKey);

  try {
    await window.api.group.prefs(state.wsId, { order: { [parentPathKey]: next } });
    await loadGroupTree();
    render();
  } catch (err) {
    fail(err);
  }
}

/** 取某个父路径下的兄弟组 key（按当前显示顺序） */
function collectSiblings(nodes: GroupNode[], parentPathKey: string): string[] | null {
  if (parentPathKey === '') {
    // 顶级：未分类不可拖动，排除掉
    return nodes.filter((n) => !n.pinned).map((n) => n.key);
  }
  for (const n of nodes) {
    if (pathKey(n.path) === parentPathKey) {
      return n.children.filter((c) => !c.pinned).map((c) => c.key);
    }
    const found = collectSiblings(n.children, parentPathKey);
    if (found) return found;
  }
  return null;
}

/** 当前正在拖的物品 / 组 */
let draggingUuid: string | null = null;
let draggingGroup: string | null = null;

// ─────────────────────────────────────────────────────────────
// 时间轴
// ─────────────────────────────────────────────────────────────

/**
 * 时间轴视图。
 *
 * 横轴是按粒度切好的时间格，每一行是一件物品；
 * 到期日落在哪一格，条就画到哪一格。可以横向拉动，鼠标悬停会整列高亮，
 * 这样「同一段时间里有多少东西要到期」一眼就能看出来。
 *
 * 数据完全来自 `timeline:data`，粒度切换与横向滚动都只是重画，不查库。
 */
function renderTimeline(view: HTMLElement): void {
  const data = state.timeline;
  if (!data) {
    view.append(el('div', { class: 'empty', text: '正在计算时间轴…' }));
    return;
  }

  view.classList.add('no-pad');

  // ── 工具栏 ──
  const bar = el('div', { class: 'toolbar tl-toolbar' });

  const gran = el('div', { class: 'seg' });
  for (const g of [
    { key: 'day', label: '日' },
    { key: 'week', label: '周' },
    { key: 'month', label: '月' },
    { key: 'year', label: '年' },
  ] as const) {
    const btn = el('button', {
      class: `seg-btn${data.granularity === g.key ? ' active' : ''}`,
      text: g.label,
      type: 'button',
    });
    btn.title = `按${g.label}显示`;
    btn.addEventListener('click', () => {
      state.timelineGranularity = g.key;
      void loadTimeline().then(render);
    });
    gran.append(btn);
  }
  bar.append(el('span', { class: 'tl-label', text: '粒度' }), gran);

  // 悬停时在这里显示「哪一格、那一格有几项到期」
  const hint = el('span', { class: 'tl-hint', id: 'tl-hint' });
  bar.append(hint);

  // 分类筛选（第 6 条）
  const catSel = select(
    'tlCat',
    [{ value: '', label: '全部分类' }, ...data.categories.map((c) => ({ value: c.key, label: `${c.label}（${c.count}）` }))],
    state.timelineCategory,
  );
  catSel.addEventListener('change', () => {
    state.timelineCategory = catSel.value;
    render();
  });
  bar.append(el('span', { class: 'tl-label', text: '分类' }), catSel);

  const todayBtn = el('button', { class: 'ghost small', text: '回到今天' });
  todayBtn.addEventListener('click', () => {
    $('#tl-scroll')?.querySelector('.tl-today')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
  bar.append(todayBtn);

  bar.append(
    el('span', {
      class: 'muted small',
      text: `${data.counts.dated} 项有到期日 · ${data.counts.longTerm} 项长期`,
    }),
  );

  view.append(bar);

  // ── 时间轴本体 ──
  const scroll = el('div', { class: 'tl-scroll', id: 'tl-scroll' });
  const inner = el('div', { class: 'tl-inner' });

  const SLOT_W = data.granularity === 'day' ? 34 : data.granularity === 'week' ? 92 : data.granularity === 'month' ? 104 : 76;
  inner.style.setProperty('--slot-w', `${SLOT_W}px`);

  const groups = state.timelineCategory
    ? data.groups.filter((g) => g.key === state.timelineCategory)
    : data.groups;

  // 表头：时间格
  const headRow = el('div', { class: 'tl-head' });
  headRow.append(el('div', { class: 'tl-row-label tl-corner', text: '物品' }));
  const headSlots = el('div', { class: 'tl-slots' });
  data.slots.forEach((s, i) => {
    const cell = el('div', {
      class: `tl-slot-head${s.current ? ' tl-today' : ''}`,
      text: s.label,
    });
    cell.dataset['slot'] = String(i);
    if (s.current) cell.title = `当前：${s.label}`;
    headSlots.append(cell);
  });
  headRow.append(headSlots);
  inner.append(headRow);

  // 每个分类一段
  let drawn = 0;
  for (const g of groups) {
    if (g.entries.length === 0 && g.longTerm.length === 0) continue;
    drawn += 1;

    const sec = el('div', { class: 'tl-group' });
    sec.append(el('div', { class: 'tl-group-title', text: `${g.label}　${g.entries.length} 项` }));

    // 有到期日的：每行一条，条画在所属的时间格上
    for (const e of g.entries) {
      const row = el('div', { class: 'tl-row' });

      const label = el('div', { class: 'tl-row-label' });
      const link = el('a', { class: 'link', text: e.itemName });
      link.addEventListener('click', () => void openItem(e.itemUuid));
      label.append(link);
      label.title = `${e.location || '—'} · ${e.kind} · ${e.expiresOn}`;
      row.append(label);

      const track = el('div', { class: 'tl-slots tl-track' });
      data.slots.forEach((s, i) => {
        const cell = el('div', { class: `tl-slot${s.current ? ' tl-today' : ''}` });
        cell.dataset['slot'] = String(i);
        if (i === e.slot) {
          // 这条物品的到期日就落在这一格
          const bar = el('div', {
            class: `tl-bar${e.expired ? ' expired' : ''}`,
            text: e.expiresOn.slice(5),
          });
          bar.dataset['slot'] = String(i);
          bar.title = `${e.itemName}　${e.kind}　${e.expiresOn}　${e.daysLeftText}`;
          bar.addEventListener('click', () => void openItem(e.itemUuid));
          cell.append(bar);
        }
        track.append(cell);
      });
      // 落在范围外的：贴边显示，免得用户以为它消失了
      if (e.slot < 0) {
        track.append(el('div', { class: 'tl-outside', text: `${e.expiresOn}（超出范围）` }));
      }
      row.append(track);
      sec.append(row);
    }

    // 长期：不占时间格，单独一行灰字
    if (g.longTerm.length > 0) {
      const row = el('div', { class: 'tl-row tl-row-longterm' });
      row.append(el('div', { class: 'tl-row-label', text: '长期' }));
      const names = el('div', { class: 'tl-slots tl-longterm' });
      for (const l of g.longTerm) {
        const link = el('a', { class: 'link', text: l.itemName });
        link.addEventListener('click', () => void openItem(l.itemUuid));
        names.append(link);
      }
      row.append(names);
      sec.append(row);
    }

    inner.append(sec);
  }

  if (drawn === 0) {
    inner.append(el('div', { class: 'empty', text: '这个筛选下没有物品。' }));
  }

  scroll.append(inner);
  view.append(scroll);

  wireTimelineHover(scroll, data);

  // 首次渲染后自动滚到今天那一格，省得用户自己找
  const todayCell = scroll.querySelector('.tl-today');
  if (todayCell) {
    requestAnimationFrame(() => {
      const el2 = todayCell as HTMLElement;
      scroll.scrollLeft = Math.max(0, el2.offsetLeft - scroll.clientWidth / 2);
    });
  }
}

/**
 * 悬停高亮：鼠标落在哪一格，整列都亮起来。
 *
 * 用事件委托而不是给每个格子挂监听 —— 日粒度下格子有几百个，
 * 逐个挂监听会明显拖慢首次渲染。
 */
function wireTimelineHover(root: HTMLElement, data: TimelineData): void {
  const highlight = (slot: string | null): void => {
    root.querySelectorAll('.tl-hover').forEach((n) => n.classList.remove('tl-hover'));
    if (slot === null) return;
    root.querySelectorAll(`[data-slot="${slot}"]`).forEach((n) => n.classList.add('tl-hover'));
  };

  root.addEventListener('mouseover', (ev) => {
    const target = (ev.target as HTMLElement).closest('[data-slot]') as HTMLElement | null;
    highlight(target?.dataset['slot'] ?? null);
  });
  root.addEventListener('mouseleave', () => highlight(null));

  // 悬停时在工具栏显示这一格的信息
  const hint = $('#tl-hint');
  if (!hint) return;
  root.addEventListener('mousemove', (ev) => {
    const target = (ev.target as HTMLElement).closest('[data-slot]') as HTMLElement | null;
    if (!target) {
      hint.textContent = '';
      return;
    }
    const i = Number(target.dataset['slot']);
    const s = data.slots[i];
    if (!s) {
      hint.textContent = '';
      return;
    }
    const n = groups_count(data, i);
    hint.textContent = `${s.start}${s.end !== s.start ? ` ~ ${s.end}` : ''}　${n} 项到期`;
  });
}

function groups_count(data: TimelineData, slot: number): number {
  let n = 0;
  for (const g of data.groups) for (const e of g.entries) if (e.slot === slot) n += 1;
  return n;
}

/**
 * 可配置的物品列。
 *
 * 列定义（哪些列存在、哪些不可关）由 core 通过 `column:get` 下发，
 * 这里只负责**怎么画**。分成两半的理由：
 *   - 约束要在数据层（core 的 `resolveColumns` 无条件补回锁定列），
 *     界面被绕过也改不坏
 *   - 画法是纯 DOM 的事，塞进 core 会让 core 沾上浏览器概念
 *
 * 「剩余时间」不是独立一列：它是算出来的，跟着「到期时间」一起出现。
 * 这样就不存在「开着剩余时间却关掉了到期日」这种说不通的状态。
 */
interface ItemCol {
  key: string;
  /** 表头文案 */
  head: string;
  /** 单元格内容 */
  cell: (it: ItemRow, ctx: ColCtx) => HTMLElement;
  /** 单元格的 class */
  cls?: string;
  align?: 'right';
}

interface ColCtx {
  /** 这一行的到期严重度，供「剩余时间」上色 */
  worst: ExpiryInfo | undefined;
  bulk: boolean;
}

function itemCols(): ItemCol[] {
  return [
    {
      key: 'name',
      head: '物品',
      cell: (it, ctx) => {
        const cell = el('td');
        const link = el('a', { class: 'link', text: it.name });
        link.addEventListener('click', () => void openItem(it.uuid));
        cell.append(link);
        if (it.is_prescription === 'true') cell.append(el('span', { class: 'tag rx', text: '处方' }));
        if (ctx.bulk) cell.append(el('span', { class: 'tag bulk', text: '批量' }));
        if (it.isLongTerm) cell.append(el('span', { class: 'tag lt', text: '长期' }));
        return cell;
      },
    },
    {
      key: 'expiry',
      head: '到期时间',
      cell: (it, ctx) => {
        // 到期日 + 剩余时间放同一格：两者是同一件事的两种说法，
        // 拆成两列会让「可配置」多出一个没有意义的中间状态
        const cell = el('td', { class: 'expiry-cell' });
        const inner = el('div');
        if (it.isLongTerm) {
          inner.append(el('span', { class: 'muted', text: '长期' }));
          cell.append(inner);
          return cell;
        }
        inner.append(el('span', { class: 'mono', text: it.expiresOn ?? '' }));
        inner.append(
          el('span', {
            class: `expiry-left ${ctx.worst?.expired ? 'lvl-expired-text' : ctx.worst ? 'lvl-warn-text' : 'muted'}`,
            text: it.daysLeftText,
          }),
        );
        cell.append(inner);
        return cell;
      },
    },
    {
      key: 'category',
      head: '分类',
      cls: 'muted',
      cell: (it) => td(enumLabel('item_category', it.category) || '未分类', 'muted'),
    },
    { key: 'brand', head: '品牌', cell: (it) => td(it.brand ?? '', 'muted') },
    { key: 'model', head: '型号', cell: (it) => td(it.model ?? '', 'muted mono') },
    {
      key: 'location',
      head: '位置',
      cell: (it) => td([it.room, it.container].filter(Boolean).join(' / '), 'muted'),
    },
    {
      key: 'quantity',
      head: '数量',
      align: 'right',
      cell: (it, ctx) => {
        const cell = el('td', { class: 'right' });
        if (ctx.bulk) {
          cell.append(stockBar(it.remaining, Math.max(it.quantity, it.minStock, 1), it.lowStock));
          if (it.stockCount > 0) {
            const chip = el('button', {
              class: 'stock-chip',
              type: 'button',
              text: `${it.stockCount} 组`,
            });
            chip.title = '这组库存拆成了几条，点开看各自的数量与到期日';
            chip.addEventListener('click', (ev) => {
              ev.stopPropagation();
              void openItem(it.uuid);
            });
            cell.append(chip);
          }
        } else {
          const box = el('span', { class: `qty-plain${it.remaining <= 0 ? ' spent' : ''}` });
          box.textContent = String(it.remaining);
          box.title = it.remaining <= 0 ? '已消耗完，可一键清理' : '普通物品，数量恒为 1';
          cell.append(box);
        }
        return cell;
      },
    },
    { key: 'purchased', head: '购买', cell: (it) => td(it.purchased_on ?? '', 'muted mono') },
  ];
}

/** 按配置取列定义。`keys` 来自 core，已经保证锁定列在里面 */
function visibleItemCols(keys: string[] | undefined): ItemCol[] {
  const all = itemCols();
  if (!keys || keys.length === 0) return all;
  const wanted = new Set(keys);
  const picked = all.filter((c) => wanted.has(c.key));
  // 兜底：core 已经保证「物品」「到期时间」在，这里再防一次空表
  return picked.length > 0 ? picked : all;
}

function renderItems(view: HTMLElement): void {
  const bar = el('div', { class: 'toolbar' });

  const search = input('search', state.filter.search, 'search', '搜索名称 / 品牌 / 型号 / 条码');
  search.addEventListener('input', () => {
    state.filter.search = search.value;
    window.clearTimeout((search as unknown as { _t?: number })._t);
    (search as unknown as { _t?: number })._t = window.setTimeout(() => {
      void refreshItems().then(render);
    }, 200);
  });
  bar.append(search);

  const cats = state.schema?.enums['item_category'] ?? [];
  const catSel = select(
    'category',
    [{ value: '', label: '全部分类' }, ...cats.map((c) => ({ value: c.key, label: c.label }))],
    state.filter.category,
  );
  catSel.addEventListener('change', () => {
    state.filter.category = catSel.value;
    void refreshItems().then(render);
  });
  bar.append(catSel);

  const rooms = [...new Set(state.items.map((i) => i.room).filter((r): r is string => Boolean(r)))].sort();
  const roomSel = select(
    'room',
    [{ value: '', label: '全部房间' }, ...rooms.map((r) => ({ value: r, label: r }))],
    state.filter.room,
  );
  roomSel.addEventListener('change', () => {
    state.filter.room = roomSel.value;
    void refreshItems().then(render);
  });
  bar.append(roomSel);

  const colBtn = el('button', { class: 'ghost', text: '列设置' });
  colBtn.title = '选择这张表显示哪些列。「物品」与「到期时间」必须显示。';
  colBtn.addEventListener('click', () => openColumnSettings());
  bar.append(colBtn);

  const addBtn = el('button', { class: 'primary', text: '＋ 新增物品' });
  addBtn.addEventListener('click', () => openItemForm(null));
  bar.append(addBtn);

  view.append(bar);

  if (state.items.length === 0) {
    view.append(el('div', { class: 'empty', text: '没有匹配的物品。' }));
    return;
  }

  const cols = visibleItemCols(state.columnVisible);

  const t = el('table', { class: 'items' });
  const head = el('tr');
  head.append(el('th', { class: 'col-dot', text: '' })); // 到期状态色点，固定列
  for (const c of cols) {
    head.append(el('th', { class: c.align === 'right' ? 'right' : '', text: c.head }));
  }
  head.append(el('th', { text: '' })); // 操作列，固定
  t.append(el('thead', {}, head));

  const body = el('tbody');
  for (const it of state.items) {
    const tr = el('tr');
    if (it.lowStock) tr.classList.add('low-stock');
    const bulk = it.is_bulk === 'true';
    if (!bulk && it.remaining <= 0) tr.classList.add('spent');

    // 第一列：到期状态色点，一眼扫出哪些要处理
    const worst = it.expiry.find((e) => e.expired) ?? (it.isLongTerm ? undefined : it.expiry[0]);
    tr.append(
      worst
        ? td('●', `dot ${worst.expired ? 'lvl-expired' : 'lvl-warn'}`)
        : td('·', 'dot muted'),
    );

    const ctx: ColCtx = { worst, bulk };
    for (const c of cols) tr.append(c.cell(it, ctx));

    const ops = el('td', { class: 'ops' });
    const use = el('button', { class: 'ghost small', text: bulk ? '领用' : '消耗' });
    use.addEventListener('click', () => void doConsume(it, bulk ? 1 : it.remaining, 'consume'));
    if (!bulk && it.remaining <= 0) use.disabled = true;
    const edit = el('button', { class: 'ghost small', text: '编辑' });
    edit.addEventListener('click', () => openItemForm(it.uuid));
    const del = el('button', { class: 'ghost small danger-text', text: '删除' });
    del.addEventListener('click', () => confirmDeleteItem(it));
    ops.append(use, edit, del);
    tr.append(ops);

    body.append(tr);

    // ── 嵌套行：批量物品配了「一组库存」时，紧跟着列出每一条 ──
    // 列数随配置变，所以用 colspan 撑一格而不是硬凑空 td
    if (bulk && it.stockCount > 1 && state.expanded.has(it.uuid)) {
      const sub = el('tr', { class: 'stock-sub' });
      sub.append(el('td', { class: 'dot muted', text: '└' }));
      const info = el('td', { class: 'muted small' });
      info.colSpan = cols.length;
      info.append(
        el('span', { text: '分为 ' }),
        el('span', { class: 'mono', text: String(it.stockCount) }),
        el('span', { text: ' 组库存，合计 ' }),
        el('span', { class: 'mono', text: `${it.remaining} / ${it.quantity}` }),
        el('span', { text: '，点「领用」时按先到期先出依次扣' }),
      );
      sub.append(info);
      sub.append(el('td', { text: '' }));
      body.append(sub);
    }
  }
  t.append(body);
  view.append(tableWrap(t));
}

function renderWorkspaces(view: HTMLElement): void {
  const info = state.info;

  // 这一页有固定在底部的「数据位置」条，内容要包在可滚动容器里
  view.classList.add('has-footer');
  const scroll = el('div', { class: 'view-scroll' });

  const add = el('button', { class: 'primary', text: '＋ 新建工作区' });
  add.addEventListener('click', openNewWorkspace);
  const imp = el('button', { text: '导入归档为工作区' });
  imp.addEventListener('click', () => void doImport());

  scroll.append(
    viewHead(
      '工作区',
      el('span', {
        class: 'muted small',
        text: '每个工作区是一个独立的 SQLite 文件，互相隔离',
      }),
    ),
  );

  const head = el('div', { class: 'toolbar' });
  head.append(add, imp);
  scroll.append(head);

  const t = el('table');
  const hrow = el('tr');
  for (const h of ['', '名称', '说明', '物品', '流水', '来源', '创建时间', '大小', '完整性', '']) {
    hrow.append(el('th', { text: h }));
  }
  t.append(el('thead', {}, hrow));

  const body = el('tbody');
  for (const w of state.wsList?.workspaces ?? []) {
    const tr = el('tr');
    if (w.active) tr.classList.add('selected');

    // 当前工作区用一个明显的圆点，其余留白
    tr.append(td(w.active ? '●' : '', w.active ? 'active-dot' : ''));

    // 名称整格可点：点一下即切换过去
    const nameCell = el('td', { class: 'clickable' });
    const nameWrap = el('div', { class: 'ws-name' });
    nameWrap.append(el('span', { class: 'link', text: w.name }));
    if (w.active) nameWrap.append(el('span', { class: 'tag ok-tag', text: '当前' }));
    nameCell.append(nameWrap);
    nameCell.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      void switchWorkspace(w.id);
    });
    nameCell.title = '点击切换到这个工作区';
    tr.append(nameCell);

    tr.append(td(w.notes ?? '', 'muted'));

    tr.append(td(w.items ?? '—', 'right'), td(w.moves ?? '—', 'right'));

    // 来源用中文标签
    const srcCell = el('td');
    srcCell.append(el('span', { class: `chip-src src-${w.source}`, text: w.sourceLabel }));
    tr.append(srcCell);

    tr.append(td(fmtDate(w.createdAt), 'muted mono'));
    tr.append(td(w.dbBytes !== null ? `${(w.dbBytes / 1024).toFixed(0)} KB` : '—', 'right muted'));
    tr.append(
      td(
        w.integrityOk === null ? '—' : w.integrityOk ? '✓ ok' : '✖ 异常',
        w.integrityOk === false ? 'danger-text' : w.integrityOk ? 'ok-text' : 'muted',
      ),
    );

    const ops = el('td', { class: 'ops' });
    const editBtn = el('button', { class: 'ghost small', text: '编辑' });
    editBtn.title = '修改名称与说明';
    editBtn.addEventListener('click', () => openEditWorkspace(w));

    // 有「已消耗完」的普通物品时才出现，避免常驻一个永远点不动的按钮
    if (w.purgeable > 0) {
      const purgeBtn = el('button', { class: 'ghost small purge', text: `清理已用完 (${w.purgeable})` });
      purgeBtn.title = '删除这个工作区里所有「非批量且数量为 0」的记录';
      purgeBtn.addEventListener('click', () => void confirmPurge(w));
      ops.append(purgeBtn);
    }

    const exp = el('button', { class: 'ghost small', text: '导出' });
    exp.addEventListener('click', () => void doExport(w.id));
    const del = el('button', { class: 'ghost small danger-text', text: '删除' });
    del.addEventListener('click', () => confirmDeleteWs(w));
    ops.append(editBtn, exp, del);
    tr.append(ops);

    body.append(tr);
  }
  t.append(body);
  scroll.append(tableWrap(t));
  view.append(scroll);

  // ── 数据位置：钉在页面底部，不随列表滚动 ──
  view.append(buildDataFooter(info));
}

/**
 * 数据位置条：**固定在内容区底部**。
 * 之前它是页面里一个普通卡片，工作区一多就被挤到屏幕外 ——
 * 而「我的数据到底存在哪」是随时可能要看的信息。
 */
function buildDataFooter(info: AppInfo | null): HTMLElement {
  const bar = el('div', { class: 'data-footer' });

  const left = el('div', { class: 'df-left' });
  left.append(el('span', { class: 'df-label', text: '数据目录' }));
  const path = el('code', { class: 'df-path', text: info?.dataDir ?? state.wsList?.dataDir ?? '—' });
  path.title = info?.dataDir ?? '';
  left.append(path);
  bar.append(left);

  const right = el('div', { class: 'df-right' });
  if (info) {
    right.append(
      el('span', {
        class: 'muted small',
        text: `v${info.version} · 数据结构 v${info.schemaVersion} · Electron ${info.electron}`,
      }),
    );
    const open = el('button', { class: 'ghost small', text: '在资源管理器中打开' });
    open.addEventListener('click', () => void window.api.io.openPath(info.dataDir).catch(fail));
    right.append(open);
  }
  bar.append(right);

  return bar;
}

/** 编辑工作区：名称 + 说明 */
function openEditWorkspace(w: WsRow): void {
  const body = el('div', { class: 'form' });
  const name = input('name', w.name);
  body.append(field('名称 *', name));

  const notes = el('textarea', { name: 'notes', rows: '3' });
  notes.value = w.notes ?? '';
  notes.placeholder = '例如：父母的常用药与证件，每季度回去看一次';
  body.append(field('说明', notes, '只存在注册表里，不进入这个工作区的数据文件'));

  const facts = el('div', { class: 'kv' });
  const add = (k: string, v: string): void => {
    facts.append(el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
  };
  add('来源', w.sourceLabel);
  add('创建时间', fmtDate(w.createdAt));
  add('物品记录', String(w.items ?? '—'));
  add('数据库大小', w.dbBytes !== null ? `${(w.dbBytes / 1024).toFixed(0)} KB` : '—');
  add('工作区 ID', w.id);
  body.append(el('div', { class: 'panel' }, sectionTitle('这个工作区'), facts));

  openModal({
    title: `编辑「${w.name}」`,
    body,
    actions: [
      {
        label: '保存',
        kind: 'primary',
        onClick: async () => {
          const next = name.value.trim();
          if (!next) {
            toast('名称不能为空', 'warn');
            return;
          }
          await window.api.ws.update(w.id, { name: next, notes: notes.value });
          toast('已保存');
          $('#modal-root').classList.add('hidden');
          await reloadAll();
        },
      },
    ],
  });
}

function renderSchema(view: HTMLElement): void {
  if (!state.schema) return;

  view.append(
    viewHead(
      '字段与格式',
      el('span', {
        class: 'muted small',
        text: '导出包的 manifest.json 与 README.md 都由这份定义生成',
      }),
    ),
  );

  view.append(sectionTitle('分类预警提前量', `关键物品 ×${state.schema.criticalMultiplier}`));
  const lt = el('table');
  const lh = el('tr');
  for (const h of ['分类', '提前量（天）']) lh.append(el('th', { text: h }));
  lt.append(el('thead', {}, lh));
  const lb = el('tbody');
  for (const [k, v] of Object.entries(state.schema.categoryLeadDays)) {
    const tr = el('tr');
    tr.append(td(enumLabel('item_category', k)), td(String(v), 'right mono'));
    lb.append(tr);
  }
  lt.append(lb);
  view.append(tableWrap(lt));

  for (const t of state.schema.tables) {
    view.append(sectionTitle(`表 ${t.name}`, t.label));
    const table = el('table');
    const head = el('tr');
    for (const h of ['列名', '类型', '中文名', '必填', '取值 / 说明']) head.append(el('th', { text: h }));
    table.append(el('thead', {}, head));
    const body = el('tbody');
    for (const c of t.columns) {
      const tr = el('tr');
      tr.append(td(c.name, 'mono'), td(c.kind, 'muted'));
      tr.append(td(c.label), td(c.required ? '是' : '', 'muted'));
      const desc = el('td');
      if (c.enumName) {
        const vals = state.schema?.enums[c.enumName] ?? [];
        desc.append(el('div', { class: 'mono small', text: vals.map((v) => v.key).join(' | ') }));
      }
      if (c.description) desc.append(el('div', { class: 'muted small', text: c.description }));
      tr.append(desc);
      body.append(tr);
    }
    table.append(body);
    view.append(table);
  }
}

// ─── 物品详情与表单 ───

async function openItem(uuid: string): Promise<void> {
  try {
    state.detail = await window.api.item.get(state.wsId, uuid);
    renderItemDetail();
  } catch (err) {
    fail(err);
  }
}

function renderItemDetail(): void {
  const d = state.detail;
  if (!d) return;
  const it = d.item;
  const bulk = it.is_bulk === 'true';

  const body = el('div');

  // ── 到期情况：只有「已过期 / 还有多久 / 长期」三种说法 ──
  if (d.expiry.length === 0) {
    const box = el('div', { class: 'alert-strip' });
    const row = el('div', { class: 'alert-line lvl-longterm' });
    row.append(el('span', { class: 'badge lt', text: '长期' }));
    row.append(el('span', { text: '没有到期日，不需要关注时间' }));
    box.append(row);
    body.append(box);
  } else {
    const box = el('div', { class: 'alert-strip' });
    for (const e of d.expiry) {
      const row = el('div', { class: `alert-line ${e.expired ? 'lvl-expired' : 'lvl-ok'}` });
      row.append(el('span', { class: `badge ${e.expired ? 'danger' : 'ok-tag'}`, text: e.expired ? '已过期' : '在有效期内' }));
      row.append(el('span', { text: `${e.kind} · ${e.expiresOn} · ${e.daysLeftText}` }));
      box.append(row);
    }
    body.append(box);
  }

  // ── 字段 ──
  const kv = el('div', { class: 'kv' });
  const add = (k: string, v: string): void => {
    kv.append(el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v || '—' }));
  };
  add('分类', enumLabel('item_category', it.category));
  add('品牌', it.brand ?? '');
  add('型号', it.model ?? '');
  add('规格', it.spec ?? '');
  add('单位', it.unit ?? '');
  add('存放位置', [it.room, it.container].filter(Boolean).join(' / '));
  add('状态', enumLabel('item_status', it.status));
  add('批量物品', bulk ? '是' : '否');
  add('到期', d.expiry.length === 0 ? '长期' : d.expiry.map((e) => e.expiresOn).join(' / '));
  add('购买日期', it.purchased_on ?? '');
  add('购买渠道', it.store ?? '');
  add('单价', d.unitPriceYuan ? `¥${d.unitPriceYuan}` : '');
  add('总价', d.amountYuan ? `¥${d.amountYuan}` : '');
  add('条码', it.barcode ?? '');
  add('开封日期', it.opened_on ?? '');
  add('开封后可用', it.open_shelf_life_days ? `${it.open_shelf_life_days} 天` : '');
  add('质保', it.warranty_months ? `${it.warranty_months} 个月` : (it.warranty_until ?? ''));
  add('序列号', it.serial_no ?? '');
  add('备注', it.notes ?? '');
  body.append(kv);

  const tags = el('div', { class: 'row' });
  if (bulk) tags.append(el('span', { class: 'tag bulk', text: '批量物品' }));
  if (it.is_prescription === 'true') tags.append(el('span', { class: 'tag rx', text: '处方药' }));
  if (d.expiry.length === 0) tags.append(el('span', { class: 'tag lt', text: '长期' }));
  if (tags.childElementCount) body.append(tags);

  // ── 一组库存（只在批量物品配了子行时出现）──
  if (d.stocks.length > 0) {
    const totals = d.stockTotals!;
    body.append(
      sectionTitle('一组库存', `${d.stocks.length} 组 · 合计 ${totals.remaining} / ${totals.quantity}${it.unit ? ' ' + it.unit : ''}`),
    );
    const st = el('table', { class: 'stock-table' });
    const sh = el('tr');
    for (const h of ['组', '数量', '到期', '剩余时间', '购买', '渠道', '']) sh.append(el('th', { text: h }));
    st.append(el('thead', {}, sh));
    const sb = el('tbody');
    for (const s of d.stocks) {
      const tr = el('tr', { class: s.expired ? 'row-expired' : '' });
      tr.append(td(`#${s.index}`, 'muted mono'));
      tr.append(td(`${s.remaining} / ${s.quantity}`, 'right mono'));
      tr.append(td(s.expiresOn ?? '长期', s.expiresOn ? 'mono' : 'muted'));
      tr.append(td(s.expiresOn ? (s.expired ? `已过期 ${Math.abs(s.daysLeft ?? 0)} 天` : `还剩 ${s.daysLeft} 天`) : '—', s.expired ? 'danger-text' : 'muted'));
      tr.append(td(s.purchasedOn, 'muted mono'));
      tr.append(td(s.store, 'muted'));
      const ops = el('td', { class: 'ops' });
      const editS = el('button', { class: 'ghost small', text: '改' });
      editS.addEventListener('click', () => openStockForm(it.uuid, s));
      const delS = el('button', { class: 'ghost small danger-text', text: '删' });
      delS.addEventListener('click', () => void removeStockRow(it.uuid, s));
      ops.append(editS, delS);
      tr.append(ops);
      sb.append(tr);
    }
    st.append(sb);
    body.append(tableWrap(st));
    body.append(
      el('p', {
        class: 'muted small',
        text: '领用时按先到期先出：从上往下依次扣，先到期的那组先扣光。',
      }),
    );

    const addStockBtn = el('button', { class: 'small', text: '＋ 再加一组库存' });
    addStockBtn.addEventListener('click', () => openStockForm(it.uuid, null));
    body.append(addStockBtn);
  }

  // ── 数量与动作 ──
  body.append(
    sectionTitle(
      bulk ? '数量' : '状态',
      bulk ? `${d.remaining} / ${it.quantity}${it.unit ? ' ' + it.unit : ''}` : d.remaining > 0 ? '在用' : '已消耗完',
    ),
  );
  const qtyRow = el('div', { class: 'qty-actions' });

  if (bulk) {
    if (d.stocks.length === 0) {
      qtyRow.append(stockBar(d.remaining, Math.max(it.quantity, d.minStock, 1), d.lowStock));
    }
    const useBtn = el('button', { class: 'primary small', text: '领用 1' });
    useBtn.addEventListener('click', () => void doConsume(it, 1, 'consume'));
    const useAll = el('button', { class: 'small', text: `全部用完（${d.remaining}）` });
    useAll.addEventListener('click', () => void doConsume(it, d.remaining, 'consume'));
    const discardBtn = el('button', { class: 'small danger-text', text: '丢弃' });
    discardBtn.addEventListener('click', () => void doConsume(it, d.remaining, 'discard'));
    const disposeBtn = el('button', { class: 'small danger-text', text: '过期处理' });
    disposeBtn.addEventListener('click', () => void doConsume(it, d.remaining, 'expired_dispose'));

    if (d.remaining > 0) qtyRow.append(useBtn, useAll, discardBtn, disposeBtn);
    else {
      const addStockBtn = el('button', { class: 'small', text: '补货：加一组库存' });
      addStockBtn.addEventListener('click', () => openStockForm(it.uuid, null));
      qtyRow.append(el('span', { class: 'muted', text: '这件东西已经处理完了' }), addStockBtn);
    }

    if (d.stocks.length === 0) {
      const splitBtn = el('button', { class: 'small', text: '拆成一组库存' });
      splitBtn.title = '把这一个数量拆成多条，每条可以有各自的到期日';
      splitBtn.addEventListener('click', () => openStockForm(it.uuid, null));
      qtyRow.append(splitBtn);
    }
  } else {
    // 普通物品：一件就是一件，操作是「消耗」，点一下数量归 0
    qtyRow.append(
      el('span', {
        class: `qty-plain big${d.remaining <= 0 ? ' spent' : ''}`,
        text: d.remaining > 0 ? '1' : '0',
      }),
    );
    if (d.remaining > 0) {
      qtyRow.append(el('span', { class: 'muted small', text: '普通物品，数量恒为 1' }));
      const consumeBtn = el('button', { class: 'primary small', text: '消耗' });
      consumeBtn.title = '用掉这一件，数量归 0';
      consumeBtn.addEventListener('click', () => void doConsume(it, 1, 'consume'));
      const discardBtn = el('button', { class: 'small danger-text', text: '丢弃' });
      discardBtn.addEventListener('click', () => void doConsume(it, 1, 'discard'));
      const disposeBtn = el('button', { class: 'small danger-text', text: '过期处理' });
      disposeBtn.addEventListener('click', () => void doConsume(it, 1, 'expired_dispose'));
      qtyRow.append(consumeBtn, discardBtn, disposeBtn);
    } else {
      qtyRow.append(
        el('span', { class: 'muted small', text: '已消耗完 —— 可以在工作区页一键清理' }),
      );
      const restore = el('button', { class: 'small', text: '恢复为在用' });
      restore.addEventListener('click', async () => {
        await window.api.item.save(state.wsId, { uuid: it.uuid, remaining: '1', status: 'in_stock' });
        toast('已恢复');
        await reloadAll();
        await openItem(it.uuid);
      });
      qtyRow.append(restore);
    }
  }
  body.append(qtyRow);

  // ── 出入库流水 ──
  if (d.moves.length > 0) {
    body.append(sectionTitle('出入库流水', `${d.moves.length} 条`));
    const mt = el('table');
    const mh = el('tr');
    for (const h of ['日期', '变化', '原因', '备注']) mh.append(el('th', { text: h }));
    mt.append(el('thead', {}, mh));
    const mb = el('tbody');
    for (const m of d.moves) {
      const tr = el('tr');
      tr.append(td(m.movedOn, 'mono'));
      tr.append(td(m.qtyDelta > 0 ? `+${m.qtyDelta}` : String(m.qtyDelta), m.qtyDelta > 0 ? 'right ok-text' : 'right warn-text'));
      tr.append(td(m.reasonLabel));
      tr.append(td(m.notes ?? '', 'muted'));
      mb.append(tr);
    }
    mt.append(mb);
    body.append(mt);
  }

  openModal({
    title: it.name,
    wide: true,
    body,
    actions: [
      { label: '编辑', kind: 'primary', onClick: () => openItemForm(it.uuid) },
      {
        label: '删除',
        kind: 'danger',
        onClick: () => {
          $('#modal-root').classList.add('hidden');
          confirmDeleteItem(it);
        },
      },
    ],
  });
}

/** 领用 / 消耗 / 丢弃 / 过期处理：扣数量并记一条流水 */
async function doConsume(it: ItemRow, qty: number, reason: string): Promise<void> {
  // 普通物品是一次性的：不管调用方传什么，一次就是「用掉这一件」
  const bulk = it.is_bulk === 'true';
  const take = bulk ? qty : 1;
  if (take <= 0) {
    toast('数量必须大于 0', 'warn');
    return;
  }
  try {
    await window.api.item.consume(state.wsId, it.uuid, take, reason);
    // 普通物品只有「消耗」，用「领用」会让人以为还有数量概念
    const label = bulk ? enumLabel('move_reason', reason) : reason === 'consume' ? '消耗' : enumLabel('move_reason', reason);
    toast(bulk ? `已${label} ${take}` : `已${label}`);
    await reloadAll();
    await openItem(it.uuid);
  } catch (err) {
    fail(err);
  }
}

// ─────────────────────────────────────────────────────────────
// 「一组库存」的增改删
// ─────────────────────────────────────────────────────────────

/**
 * 新增 / 修改一条库存条目。
 *
 * 每条自带数量与到期日 —— 这就是「为这组库存配置多个数量与到期时间」的落点。
 */
function openStockForm(itemUuid: string, stock: BulkStock | null): void {
  const body = el('div', { class: 'form' });

  body.append(field('数量 *', input('quantity', String(stock?.quantity ?? 1), 'number'), '这一组有多少个'));

  const expiresOn = input('expires_on', stock?.expiresOn ?? '', 'date');
  const lt = el('input', { type: 'checkbox' }) as HTMLInputElement;
  lt.checked = stock ? stock.expiresOn === null : false;
  const ltWrap = el('label', { class: 'check mini' });
  ltWrap.append(lt, el('span', { text: '这一组长期有效（不填到期日）' }));

  const expiryField = field('到期日', expiresOn, '只印到月份就填那个月的最后一天');
  const applyLt = (): void => {
    expiresOn.disabled = lt.checked;
    expiryField.classList.toggle('locked', lt.checked);
    if (lt.checked) expiresOn.value = '';
  };
  lt.addEventListener('change', applyLt);

  body.append(expiryField, ltWrap);
  applyLt();

  body.append(field('购买日期', input('purchased_on', stock?.purchasedOn ?? '', 'date')));
  body.append(field('单价（元）', input('unitPriceYuan', stock?.unitPriceYuan ?? '', 'text', '如 2.50')));
  body.append(field('购买渠道', input('store', stock?.store ?? '', 'text', '如 山姆')));
  body.append(field('备注', input('notes', stock?.notes ?? '')));

  openModal({
    title: stock ? `修改第 ${stock.index} 组库存` : '新增一组库存',
    body,
    actions: [
      {
        label: stock ? '保存' : '添加',
        kind: 'primary',
        onClick: async () => {
          const v = collect(body);
          const qty = Number(v['quantity'] ?? 1);
          if (!Number.isInteger(qty) || qty < 0) {
            toast('数量必须是非负整数', 'warn');
            return;
          }
          const payload: Record<string, unknown> = {
            quantity: String(qty),
            purchased_on: v['purchased_on'] ?? '',
            unitPriceYuan: v['unitPriceYuan'] ?? '',
            store: v['store'] ?? '',
            notes: v['notes'] ?? '',
            // 长期 → 明确清空到期日
            expires_on: lt.checked ? null : (v['expires_on'] ?? ''),
          };
          try {
            if (stock) {
              payload['uuid'] = stock.uuid;
              await window.api.stock.update(state.wsId, stock.uuid, payload);
              toast('已保存');
            } else {
              await window.api.stock.add(state.wsId, itemUuid, payload);
              toast('已添加一组库存');
            }
            $('#modal-root').classList.add('hidden');
            await reloadAll();
            await openItem(itemUuid);
          } catch (err) {
            fail(err);
          }
        },
      },
    ],
  });
}

async function removeStockRow(itemUuid: string, stock: BulkStock): Promise<void> {
  try {
    await window.api.stock.remove(state.wsId, stock.uuid);
    toast(`已删除第 ${stock.index} 组库存`);
    await reloadAll();
    await openItem(itemUuid);
  } catch (err) {
    fail(err);
  }
}

function openItemForm(uuid: string | null): void {
  const existing = uuid ? state.items.find((i) => i.uuid === uuid) : undefined;
  const body = el('div', { class: 'form' });

  // ── 它是什么 ──
  body.append(field('名称 *', input('name', existing?.name ?? '', 'text', '如 布洛芬缓释胶囊')));

  const cats = state.schema?.enums['item_category'] ?? [];
  body.append(
    field('分类 *', select('category', cats.map((c) => ({ value: c.key, label: c.label })), existing?.category ?? 'other')),
  );
  body.append(field('品牌', input('brand', existing?.brand ?? '', 'text', '如 芬必得 / Anker'), '选填'));
  body.append(field('型号', input('model', existing?.model ?? '', 'text', '如 MX Master 3S'), '选填，与规格不同'));
  body.append(field('规格', input('spec', existing?.spec ?? '', 'text', '如 0.25g×24粒'), '选填'));

  const units = ['件', '盒', '瓶', '袋', '罐', '支', '个', '包', '箱', '板', '本', '份', '台'];
  body.append(field('单位', select('unit', units.map((u) => ({ value: u, label: u })), existing?.unit ?? '件')));
  body.append(field('条码', input('barcode', existing?.barcode ?? '')));

  // ── 放在哪 ──
  body.append(field('房间', input('room', existing?.room ?? '', 'text', '如 客厅'), '存放位置第一级'));
  body.append(field('容器 / 柜格', input('container', existing?.container ?? '', 'text', '如 药箱-上层'), '存放位置第二级'));

  // ── 多少 ──
  // 默认不是批量物品：数量恒为 1，这里只是展示，不给改
  const bulkBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  bulkBox.checked = existing?.is_bulk === 'true';
  const bulkWrap = el('label', { class: 'check' });
  bulkWrap.append(bulkBox, el('span', { text: '批量物品（需要按个数管理，如抽纸 / 电池 / 口罩）' }));
  const bulkField = el('div', { class: 'field span-2' });
  bulkField.append(bulkWrap);
  bulkField.append(
    el('span', {
      class: 'field-hint',
      text: '不开启时数量恒为 1，操作是「消耗」一次归零；开启后才能设数量、多次领用、设最低库存',
    }),
  );
  body.append(bulkField);

  const qtyInput = input('quantity', String(existing?.quantity ?? 1), 'number');
  const qtyField = field('数量', qtyInput, '买入时多少个');
  body.append(qtyField);

  const remainInput = input('remaining', String(existing?.remaining ?? existing?.quantity ?? 1), 'number');
  const remainField = field('剩余数量', remainInput, '领用或丢弃后会自动变化');
  body.append(remainField);

  const minStockInput = input('min_stock', String(existing?.minStock ?? 0), 'number');
  const minStockField = field('最低库存', minStockInput, '剩余低于此值会进入待补货');
  body.append(minStockField);

  /** 非批量时把数量相关的输入全部锁成 1 并置灰 */
  const applyBulk = (): void => {
    const bulk = bulkBox.checked;
    for (const el2 of [qtyInput, remainInput, minStockInput]) {
      el2.disabled = !bulk;
    }
    for (const f of [qtyField, remainField, minStockField]) {
      f.classList.toggle('locked', !bulk);
    }
    if (!bulk) {
      qtyInput.value = '1';
      remainInput.value = existing && existing.is_bulk !== 'true' ? String(existing.remaining) : '1';
      minStockInput.value = '0';
    }
  };
  bulkBox.addEventListener('change', applyBulk);
  applyBulk();

  // ── 买的 ──
  body.append(field('购买日期', input('purchased_on', existing?.purchased_on ?? new Date().toISOString().slice(0, 10), 'date')));
  body.append(field('购买渠道', input('store', existing?.store ?? '', 'text', '如 京东健康')));

  const priceWrap = el('div', { class: 'field' });
  priceWrap.append(el('span', { class: 'field-label', text: '单价（元）' }));
  const priceInput = input('unitPriceYuan', existing?.unitPriceYuan ?? '', 'text', '如 19.30');
  priceWrap.append(priceInput);
  const autoAmount = el('label', { class: 'check mini' });
  const autoBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  autoBox.checked = true;
  autoAmount.append(autoBox, el('span', { text: '总价按 单价 × 数量 自动算' }));
  priceWrap.append(autoAmount);
  body.append(priceWrap);

  const amountField = field('总价（元）', input('amountYuan', existing?.amountYuan ?? '', 'text'));
  const amountInput = amountField.querySelector('input') as HTMLInputElement;
  const syncAmount = (): void => {
    if (!autoBox.checked) return;
    const p = Number(priceInput.value);
    const q = Number((body.querySelector('[name="quantity"]') as HTMLInputElement | null)?.value ?? 1);
    amountInput.value = Number.isFinite(p) && p > 0 ? (p * q).toFixed(2) : '';
  };
  autoBox.addEventListener('change', () => {
    amountInput.disabled = autoBox.checked;
    syncAmount();
  });
  priceInput.addEventListener('input', syncAmount);
  amountInput.disabled = autoBox.checked;
  syncAmount();
  body.append(amountField);

  // ── 什么时候到期 ──
  // 取消了「到期类型」：填了日期就是那一天，勾了长期就没有到期日。
  const expiresOn = input('expires_on', existing?.expiresOn ?? '', 'date');
  const lt = el('input', { type: 'checkbox' }) as HTMLInputElement;
  lt.checked = existing ? existing.isLongTerm : false;
  const ltWrap = el('label', { class: 'check mini' });
  ltWrap.append(lt, el('span', { text: '长期有效 / 没有到期日（不参与到期提示）' }));

  const expiryField = field('到期日', expiresOn, '包装只印到月份就填那个月的最后一天，如 2027-03-31');
  const applyLongTerm = (): void => {
    expiresOn.disabled = lt.checked;
    expiryField.classList.toggle('locked', lt.checked);
    if (lt.checked) expiresOn.value = '';
  };
  lt.addEventListener('change', applyLongTerm);

  body.append(expiryField, ltWrap);

  body.append(field('开封日期', input('opened_on', existing?.opened_on ?? '', 'date'), '与下面的天数结合自动算开封后到期'));
  body.append(
    field(
      '开封后可用天数',
      input('open_shelf_life_days', existing?.open_shelf_life_days ?? '', 'number', '如 28'),
      '很多药开封后远短于保质期',
    ),
  );
  body.append(field('质保月数', input('warranty_months', existing?.warranty_months ?? '', 'number', '数码设备用')));
  body.append(field('质保到期日', input('warranty_until', existing?.warranty_until ?? '', 'date')));
  body.append(field('序列号', input('serial_no', existing?.serial_no ?? '', 'text', '数码设备建议填写')));

  // ── 属性 ──
  const statuses = state.schema?.enums['item_status'] ?? [];
  body.append(
    field('状态', select('status', statuses.map((s) => ({ value: s.key, label: s.label })), existing?.status ?? 'in_stock')),
  );
  body.append(field('标签', input('tags', existing?.tags ?? '', 'text', '逗号分隔')));

  const rx = el('input', { type: 'checkbox' }) as HTMLInputElement;
  rx.checked = existing?.is_prescription === 'true';
  const rxWrap = el('label', { class: 'check' });
  rxWrap.append(rx, el('span', { text: '处方药' }));
  body.append(rxWrap);

  const notes = el('textarea', { name: 'notes', rows: '3' });
  notes.value = existing?.notes ?? '';
  const notesField = field('备注', notes);
  notesField.classList.add('span-2');
  body.append(notesField);

  applyLongTerm();

  openModal({
    title: uuid ? `编辑「${existing?.name ?? ''}」` : '新增物品',
    wide: true,
    body,
    actions: [
      {
        label: uuid ? '保存' : '创建',
        kind: 'primary',
        onClick: async () => {
          const v = collect(body);
          if (!v['name'] || !v['name'].trim()) {
            toast('名称不能为空', 'warn');
            return;
          }
          if (Number(v['quantity'] ?? 0) < 0 || Number(v['remaining'] ?? 0) < 0) {
            toast('数量不能为负数', 'warn');
            return;
          }
          const payload: Record<string, unknown> = { ...v };
          if (uuid) payload['uuid'] = uuid;
          payload['is_prescription'] = rx.checked ? 'true' : 'false';
          payload['is_bulk'] = bulkBox.checked ? 'true' : 'false';
          // 长期 → 明确清空到期日，别让上一次填的值留在库里
          if (lt.checked) payload['expires_on'] = null;
          // 勾了自动算总价就不提交手填的总价，交给后端按单价 × 数量推
          if (autoBox.checked) delete payload['amountYuan'];
          const res = await window.api.item.save(state.wsId, payload);
          toast(res.created ? '已新增' : '已保存');
          $('#modal-root').classList.add('hidden');
          await reloadAll();
          if (res.created && res.item) await openItem(res.item.uuid);
        },
      },
    ],
  });
}

// ─── 工作区操作 ───

function openNewWorkspace(): void {
  const body = el('div', { class: 'form' });
  body.append(field('工作区名称 *', input('name', '', 'text', '如 自己家 / 父母家 / 办公室')));
  const seedBox = el('input', { type: 'checkbox', name: 'seed' }) as HTMLInputElement;
  seedBox.checked = true;
  const seedWrap = el('label', { class: 'check' });
  seedWrap.append(seedBox, el('span', { text: '写入演示数据（17 件物品，含各种到期情况，便于先看看效果）' }));
  body.append(seedWrap);
  body.append(
    el('p', {
      class: 'muted',
      text: '新工作区是一个全新的空 SQLite 文件，与其它工作区完全隔离。',
    }),
  );

  openModal({
    title: '新建工作区',
    body,
    actions: [
      {
        label: '创建',
        kind: 'primary',
        onClick: async () => {
          const v = collect(body);
          if (!v['name']?.trim()) {
            toast('请填写名称', 'warn');
            return;
          }
          const res = await window.api.ws.create(v['name'].trim(), seedBox.checked);
          toast(`工作区「${res.name}」已创建`);
          $('#modal-root').classList.add('hidden');
          state.wsId = res.id;
          await reloadAll();
        },
      },
    ],
  });
}

/**
 * 一键清理确认框。
 *
 * 先把要删的清单拉出来给用户看，再让他确认 —— 批量删除最怕的就是
 * 「不知道删了什么」。
 */
async function confirmPurge(w: WsRow): Promise<void> {
  let preview: { items: { uuid: string; name: string; location: string }[] };
  try {
    preview = await window.api.item.purgeSpent(w.id, true);
  } catch (err) {
    fail(err);
    return;
  }

  const body = el('div');
  body.append(
    el('p', {
      text: `「${w.name}」里有 ${preview.items.length} 条已经消耗完的普通物品记录。清理只删这些记录，批量物品即使数量为 0 也会保留。`,
    }),
  );

  const t = el('table');
  const hrow = el('tr');
  for (const h of ['名称', '位置']) hrow.append(el('th', { text: h }));
  t.append(el('thead', {}, hrow));
  const tb = el('tbody');
  for (const it of preview.items) {
    const tr = el('tr');
    tr.append(td(it.name), td(it.location || '—', 'muted'));
    tb.append(tr);
  }
  t.append(tb);
  body.append(tableWrap(t));

  const alsoMoves = el('p', {
    class: 'muted small',
    text: '这些记录各自的出入库流水会一并删除。这一步不可撤销。',
  });
  body.append(alsoMoves);

  openModal({
    title: `清理 ${preview.items.length} 条已用完的记录？`,
    wide: true,
    body,
    actions: [
      {
        label: `清理 ${preview.items.length} 条`,
        kind: 'danger',
        onClick: async () => {
          try {
            const res = await window.api.item.purgeSpent(w.id, false);
            toast(`已清理 ${res.purged} 条`);
            $('#modal-root').classList.add('hidden');
            await reloadAll();
          } catch (err) {
            fail(err);
          }
        },
      },
    ],
  });
}

function confirmDeleteWs(w: WsRow): void {  openModal({
    title: `删除工作区「${w.name}」？`,
    body: el('div', {}, [
      el('p', { text: '该工作区的目录与数据库会被删除。删除前会自动导出一份快照到 backups 目录，以防误删。' }),
      el('p', { class: 'muted', text: `物品记录 ${w.items ?? '—'} 条 · 出入库流水 ${w.moves ?? '—'} 条 · 来源 ${w.sourceLabel}` }),
      el('p', { class: 'danger-text', text: '这一步不可撤销（快照可以手工恢复，但需要先把文件放回工作区目录）。' }),
    ]),
    actions: [
      {
        label: '确认删除',
        kind: 'danger',
        onClick: async () => {
          const res = await window.api.ws.remove(w.id);
          toast(res.snapshotPath ? '已删除，快照已保留' : '已删除');
          $('#modal-root').classList.add('hidden');
          state.wsId = null;
          await reloadAll();
        },
      },
    ],
  });
}

function confirmDeleteItem(it: ItemRow): void {
  openModal({
    title: `删除「${it.name}」？`,
    body: el('p', { text: '该物品及其所有批次都会被删除。出库流水会保留为孤立记录。' }),
    actions: [
      {
        label: '确认删除',
        kind: 'danger',
        onClick: async () => {
          await window.api.item.delete(state.wsId, it.uuid);
          toast('已删除');
          $('#modal-root').classList.add('hidden');
          await reloadAll();
        },
      },
    ],
  });
}

async function switchWorkspace(id: string): Promise<void> {
  try {
    await window.api.ws.use(id);
    state.wsId = id;
    state.filter = { search: '', category: '', room: '' };
    await reloadAll();
  } catch (err) {
    fail(err);
  }
}

// ─── 导入导出 ───

async function doExport(wsId?: string): Promise<void> {
  try {
    const res = await window.api.io.exportWs(wsId ?? state.wsId);
    if (res.canceled) return;
    openModal({
      title: '导出完成',
      body: el('div', {}, [
        el('p', { text: `归档已生成，共 ${res.fileCount} 个文件。` }),
        el('div', { class: 'kv' }, [
          el('span', { class: 'k', text: '路径' }),
          el('span', { class: 'v mono', text: res.archivePath ?? '' }),
          el('span', { class: 'k', text: '大小' }),
          el('span', { class: 'v', text: res.bytesText ?? '' }),
        ]),
        el('p', {
          class: 'muted',
          text: '归档内含 manifest.json（机器可读的字段说明）、README.md（人可读的字段表）、每张表一个 CSV，以及 checksums.txt。',
        }),
        el('p', { class: 'muted', text: `行数：${Object.entries(res.rowCounts ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ')}` }),
      ]),
      actions: [
        {
          label: '在资源管理器中显示',
          kind: 'primary',
          onClick: () => window.api.io.revealPath(res.archivePath ?? ''),
        },
      ],
    });
  } catch (err) {
    fail(err);
  }
}

async function doImport(): Promise<void> {
  try {
    const preview = await window.api.io.previewImport();
    if (preview.canceled) return;

    const body = el('div');
    const okToImport = (preview.errorCount ?? 0) === 0;

    const kv = el('div', { class: 'kv' });
    const add = (k: string, v: string): void => {
      kv.append(el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }));
    };
    add('归档', preview.archivePath ?? '');
    add('将创建的工作区', preview.workspaceName ?? '');
    add('导出于', fmtDate(preview.exportedAt ?? null));
    add('归档格式版本', String(preview.formatVersion ?? ''));
    add('数据结构版本', String(preview.schemaVersion ?? ''));
    add('完整性校验', preview.checksumVerified ? '通过' : '未通过');
    add('总行数', String(preview.totalRows ?? 0));
    body.append(kv);

    if (preview.tables?.length) {
      const t = el('table');
      const head = el('tr');
      for (const h of ['表', '行数', '错误', '警告']) head.append(el('th', { text: h }));
      t.append(el('thead', {}, head));
      const tb = el('tbody');
      for (const row of preview.tables) {
        const tr = el('tr');
        tr.append(td(row.table), td(row.rows), td(row.errors, row.errors ? 'danger-text' : ''), td(row.warnings, row.warnings ? 'warn-text' : ''));
        tb.append(tr);
      }
      t.append(tb);
      body.append(t);
    }

    if (preview.issues?.length) {
      body.append(el('h3', { text: `校验问题（${preview.errorCount} 个错误 / ${preview.warningCount} 个警告）` }));
      const list = el('div', { class: 'issues' });
      for (const i of preview.issues.slice(0, 40)) {
        list.append(
          el('div', {
            class: i.level === 'error' ? 'issue err' : 'issue warn',
            text: `${i.table}${i.line ? `:${i.line}` : ''} — ${i.message}`,
          }),
        );
      }
      body.append(list);
    }

    body.append(
      el('p', {
        class: 'muted',
        text: okToImport
          ? '导入会新建一个工作区，不会修改任何已有工作区。'
          : '存在错误，无法导入。请修正归档后重试 —— 有错误时不会写入任何数据。',
      }),
    );

    const nameInput = input('name', preview.workspaceName ?? '');
    if (okToImport) body.append(field('新工作区名称', nameInput));

    openModal({
      title: okToImport ? '确认导入' : '归档校验未通过',
      wide: true,
      body,
      actions: okToImport
        ? [
            {
              label: '导入为新工作区',
              kind: 'primary',
              onClick: async () => {
                const res = await window.api.io.import(preview.archivePath!, nameInput.value.trim() || undefined);
                if (!res.ok) {
                  toast(`导入失败：${res.errorCount} 个错误`, 'err');
                  return;
                }
                toast(`已导入为工作区「${res.workspaceName}」`);
                $('#modal-root').classList.add('hidden');
                state.wsId = res.workspaceId;
                await reloadAll();
                setTab('workspaces');
              },
            },
          ]
        : [],
    });
  } catch (err) {
    fail(err);
  }
}

// ─── 启动 ───

function wireChrome(): void {
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => setTab((b as HTMLElement).dataset['tab'] as typeof state.tab));
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const root = $('#modal-root');
      if (!root.classList.contains('hidden')) {
        root.classList.add('hidden');
        root.innerHTML = '';
      }
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n') {
      ev.preventDefault();
      if (state.wsId) openItemForm(null);
    }
  });
}

/**
 * 跨天时重画。
 *
 * 「剩余时间」是算出来的（到期日 − 今天），所以它在页面上会自己过期：
 * 开着应用过一夜，昨天写的"剩 7 个月"今天就错了。
 *
 * 三个刷新时机（需求里点名了）：
 *   1. **零点** —— 主进程定时广播 `date:changed`
 *   2. **打开程序** —— 首屏本来就会重算
 *   3. **改了到期时间** —— 走既有的 reloadAll()
 *
 * 这里额外做一道自检：主进程的定时器在系统睡眠期间不保证准时，
 * 所以自己每 60 秒比一次日期，外加窗口重新获得焦点时比一次。
 * 两个检查都很便宜（只比字符串），不会有什么开销。
 */
function wireDateRollover(): void {
  let lastDay = new Date().toDateString();

  const check = (): void => {
    const now = new Date().toDateString();
    if (now === lastDay) return;
    lastDay = now;
    // 跨天了：提醒与剩余时间都要重算
    void reloadAll();
  };

  window.api.onDateChanged(check);
  window.addEventListener('focus', check);
  window.setInterval(check, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
}

async function boot(): Promise<void> {
  try {
    wireChrome();
    wireDateRollover();
    state.info = await window.api.app.info();
    state.schema = await window.api.app.schema();
    await loadSortFields();
    $('#app-meta').textContent = `v${state.info.version} · 数据结构 v${state.info.schemaVersion}`;

    const list = await window.api.ws.list();
    if (list.workspaces.length === 0) {
      await refreshWorkspaces();
      renderBanner();
      render();
      setTab('workspaces');
      return;
    }
    await reloadAll();
  } catch (err) {
    fail(err);
    $('#view').append(el('div', { class: 'empty', text: `启动失败：${(err as Error).message}` }));
  }
}

void boot();
