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
  /** 数据目录能不能写。false 时整个界面禁用，只留「数据位置」上的配置入口 */
  dataDirWritable: boolean;
  dataDirReason: string;
  dataDirConfigured: boolean;
  dataDirFallback: string;
  bootstrapPath: string;
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
  /** 点这个列头时按哪个排序字段排；不写 = 不可排序（见 core/columns.ts） */
  sortKey?: string;
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
  /** 待办条数 = 已过期 + 15 天内到期。长期不计入；null = 读不出来 */
  pending: number | null;
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
  /** 只有质保期到期的物品数。单独标，不进「已过期」也不进高亮 */
  warranty: number;
}

interface GroupTreeResult {
  levels: number;
  requestedLevels: number;
  sortedBy: string;
  /**
   * 拖动是否可用。
   *
   * `true` = 没有任何分组被排序（全手动）。**只要有一个分类被点了列头，
   * 那个分类就不能再拖** —— 拖了也会立刻被排序覆盖，看着像坏了。
   * 但别的分类不受影响，所以这是整页一个标志、按组判定在渲染层做。
   */
  dragEnabled: boolean;
  /** 每个分组各自的排序；表里没有的组 = 手动顺序 */
  groupSort?: Record<string, { field: string; desc: boolean }>;
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
  /**
   * 这条日期算「过期」还是「过保」，由来源自动判定：
   * 保质期 / 开封后有效期 → expire；质保期 → warranty。
   *
   * 界面靠它决定报不报红 —— 保修到期不等于东西坏了。
   */
  alertKind?: 'expire' | 'warranty';
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

// 时间轴页已取消，「时间轴上的一格 / 一条到期项 / 整页数据」三个类型
// 曾经定义在这里。命令行 `timeline` 仍在（它直接用 core 的
// `buildTimelineSlots`），只是界面不再有这一页 —— 见 index.html 里的说明。

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

interface InventoryApi {
  app: {
    info(): Promise<AppInfo>;
    schema(): Promise<SchemaInfo>;
    manifest(): Promise<unknown>;
    pickDataDir(): Promise<{ canceled: boolean; dir?: string; writable?: boolean; reason?: string }>;
    setDataDir(dir: string): Promise<{ dataDir: string; bootstrapPath: string }>;
    resetDataDir(): Promise<{ dataDir: string }>;
  };
  ws: {
    list(): Promise<WsList>;
    create(name: string): Promise<{ id: string; name: string }>;
    use(id: string): Promise<{ id: string; name: string }>;
    rename(id: string, name: string): Promise<{ id: string; name: string }>;
    /** 改名称与备注 */
    update(
      id: string,
      patch: { name?: string; notes?: string },
    ): Promise<{ id: string; name: string; notes: string; source: string; sourceLabel: string }>;
    remove(id: string): Promise<{ id: string; name: string; snapshotPath: string | null }>;
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
  /** 一次删多条，在一个事务里做完。已不存在的 uuid 计入 missing 而不报错 */
  deleteMany(
    wsId: string | null,
    uuids: string[],
  ): Promise<{ deleted: number; missing: number; removed: string[] }>;
    /**
     * 展开区：位置 / 规格 / 备注 + 这件东西自己的补充字段。
     *
     * 保存时值为空串表示删除该字段。
     */
    extra(
      wsId: string | null,
      uuid: string,
    ): Promise<{
      uuid: string;
      name: string;
      fields: { key: string; label: string; value: string }[];
      custom: Record<string, string>;
      count: number;
    }>;
    extraSave(wsId: string | null, uuid: string, patch: Record<string, string>): Promise<unknown>;
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
    api: InventoryApi;
  }
}

// ─── 状态 ───

const state: {
  info: AppInfo | null;
  schema: SchemaInfo | null;
  wsList: WsList | null;
  wsId: string | null;
  alert: AlertSummary | null;
  items: ItemRow[];
  detail: ItemDetail | null;
  /*
   * `'timeline'` 从联合类型里去掉了 —— 页签已取消，留着它会让
   * `setTab('timeline')` 这类调用编译得过，而那是一个到不了的页面。
   * （`'workspaces'` / `'schema'` 仍是合法值：它们只是页签隐藏，
   * 分别由返回箭头和排查问题时进入。）
   */
  tab: 'dashboard' | 'groups' | 'items' | 'workspaces' | 'schema';
  filter: { search: string; category: string };
  /** 分组页：服务端算好的树 + 本地筛选 */
  groupTree: GroupTreeResult | null;
  /** 排序字段；'manual' = 排序关闭，按拖动固定下来的顺序 */
  sortField: string;
  sortFields: SortFieldDef[];
  /**
   * **每个分组各自的排序**：`pathKey(path)` → `{ field, desc }`。
   *
   * 与 `sortField` 的分工：那个是"一个字段排全部"（命令行与概览页仍用它），
   * 这个是分组页的"每个分类各自排各自的"。
   * **表里没有的组 = 手动顺序**（可拖动），所以"一个都没点过"就等于全手动。
   */
  groupSort: Record<string, { field: string; desc: boolean }>;
  /** 展开到第几级（1~3，一级不可关） */
  /** 收起的分组路径 */
  collapsed: Set<string>;
  groupOnlyExpired: boolean;
  categoryFilter: string;
  /** 物品页里展开了「一组库存」的行 */
  expanded: Set<string>;
  /**
   * 简明视图：只看「已过期」与「N 天内到期」的物品。
   *
   * 是个**筛选开关**而不是另一个页面 —— 打开就筛，关掉就回来，
   * 当前的分组层级、排序、列设置都不受影响。
   */
  /**
   * 展开了「补充信息」的行。
   *
   * 与 `expanded`（批量物品的库存明细）分开：两者可以同时展开，
   * 而且触发的入口不同，混在一个集合里会让"点箭头把库存明细也打开了"。
   */
  extraOpen: Set<string>;
  /**
   * 物品页的批量删除模式。
   *
   * 打开时每一行前面出现复选框，工具栏上的按钮变成「删除选中 (N)」。
   * 之所以要两步（先进入模式、再勾选、再确认），是因为删除不可撤销：
   * 常驻的复选框会让"误点"直接变成"误删"。
   *
   * `batchSelected` 只活在这一次选择里 —— 退出模式、换工作区、
   * 删完之后都清空。留着上一条工作区的勾选状态去删另一个库里的东西，
   * 是最不该发生的事。
   */
  batchMode: boolean;
  batchSelected: Set<string>;
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
  items: [],
  detail: null,
  tab: 'dashboard',
  filter: { search: '', category: '' },
  groupTree: null,
  sortField: 'manual',
  sortFields: [],
  /*
   * **每个分组各自的排序**：`pathKey(path)` → `{ field, desc }`。
   *
   * 与 `sortField` 的分工：那个是"一个字段排全部"（命令行与概览页仍用它），
   * 这个是分组页的"每个分类各自排各自的"。
   * **表里没有的组 = 手动顺序**，所以"一个都没点过"就等于全手动可拖动，
   * 不用再存一个"排序关闭"的标志。
   */
  groupSort: {} as Record<string, { field: string; desc: boolean }>,
  collapsed: new Set<string>(),
  groupOnlyExpired: false,
  categoryFilter: '',
  expanded: new Set<string>(),
  extraOpen: new Set<string>(),
  batchMode: false,
  batchSelected: new Set<string>(),
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

/** 分组路径的字符串键：拖动顺序与收起状态都按它存（实现见下面的 pathKey） */

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
  /*
   * 剩余为 0 时**不要用 `empty` 这个类名**。
   *
   * 样式表里已经有一个全局的 `.empty`（整页占位块：padding 56px 24px + 虚线框）。
   * 两者一撞，这条 6px 高的小条会吃到那个 48px 的水平内边距，
   * `width: 0%` 再也压不下去 —— 表现是"剩余为 0，却画出一条几乎占满的红条"，
   * 语义完全反了。过宽的内边距撑开元素比缺样式更难查：宽度看起来像是"算出来的"。
   */
  if (current === 0) fill.classList.add('zero');
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

/**
 * 标题旁边的悬停说明：一个圆圈 `?`，鼠标移上去浮出一段文字。
 *
 * 为什么不用原生 `title`：它是系统画的方角白框，在纯黑主题里像从别的
 * 程序里掉出来的。这个提示是**唯一**的载体（原文已经不在页面上了），
 * 所以更不能用那个。
 *
 * 浮层用 `position: absolute` 挂在 `.tip` 里，不占布局 ——
 * 否则一句话会把标题那一行撑开，等于没挪走。
 * 纯 CSS 显示（`:hover` / `:focus-within`），不写 JS：
 * 它是"看一眼"的东西，为它维护一份开关状态不值得。
 * 键盘也要能触发（`:focus-within`），不然只有鼠标用户看得到。
 */
function hoverTip(text: string): HTMLElement {
  const wrap = el('span', { class: 'tip' });
  // 用 button：它天生可聚焦、可被读屏软件念出来，不用自己补 tabindex
  const dot = el('button', { class: 'tip-dot', type: 'button', text: '?' });
  dot.setAttribute('aria-label', text);
  wrap.append(dot, el('span', { class: 'tip-text', text }));
  return wrap;
}

/** 所有表格都套一层，才能有粘性表头与独立滚动 */
function tableWrap(t: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'table-wrap' });
  wrap.append(t);
  return wrap;
}

/**
 * 「快到期」窗口的显示文案。
 *
 * 真正的阈值在 core 的 `SOON_DAYS`（那边是唯一真相，`counts.soon` 就按它算）。
 * 渲染层 import 不到 core（纯 Node 模块 + rootDir 限制），所以这里只放文案；
 * **改 core 的 SOON_DAYS 时记得同步这个字符串**。
 */
const SOON_TEXT = '15';

/**
 * 一件物品的「过期」类到期条目 —— **不含过保**。
 *
 * 质保期到了（过保）说明不再免费维修，不是"东西坏了"。
 * 早先不区分，结果是"鼠标保修到期"和"药过期了"一起报红，
 * 真正不能吃的那个反而被淹掉。
 */
function expireOnly(it: ItemRow): ExpiryInfo[] {
  return it.expiry.filter((e) => e.alertKind !== 'warranty');
}

/**
 * 一件物品最要紧的「过期」条目，用来决定列表里报不报红。
 * 全是质保期的话返回 undefined —— 那件东西不报红。
 */
function worstExpire(it: ItemRow): ExpiryInfo | undefined {
  const expiring = expireOnly(it);
  return expiring.find((e) => e.expired) ?? expiring[0];
}

/** 这件东西有没有真的过期（不含过保） */
function hasExpired(it: ItemRow): boolean {
  return expireOnly(it).some((e) => e.expired);
}


/**
 * 时间分布条：过期 / 15 天内 / 之后 / 长期。
 *
 * `counts.expired` 与 `counts.soon` **只含「过期」那类**（保质期 / 开封后有效期），
 * 过保（质保期）不在里面 —— 保修到期不等于东西坏了，混进来会稀释真正的提醒。
 * 所以这个条的总长会小于「有到期日的条目数」，这是刻意的。
 */
function severityDist(counts: AlertSummary['counts']): HTMLElement | null {
  const later = Math.max(0, counts.dated - counts.expired - counts.soon);
  const segs: { key: string; label: string; value: number; color: string }[] = [
    { key: 'expired', label: '已过期', value: counts.expired, color: 'var(--danger)' },
    { key: 'soon', label: `${SOON_TEXT} 天内`, value: counts.soon, color: 'var(--warn)' },
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
    /*
     * 数字和标签之间要**有东西**顶着。
     *
     * 原来靠一个普通空格，而 `.dist-legend` 是 flex 容器、`item` 是 flex item ——
     * 里面的空白文本节点会被丢掉，于是渲染成「615 天内」。
     * 用 nowrap 保证不折行，再用 CSS 给 b 加右边距把间距做实，
     * 不再依赖会被折叠掉的空白。
     */
    item.append(swatch, el('b', { text: String(s.value) }), el('span', { text: s.label }));
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
  /**
   * 已经做好的按钮，直接追加在操作栏**最右边**。
   *
   * 给"按钮上要挂自己的状态"的场合用（比如数据目录那三个里，
   * 「保存」的 disabled 由浏览结果决定，用 actions 的声明式写法够不着）。
   *
   * 实际次序是：`[hint] [actions…] [extraActions…] [取消]` ——
   * 声明时按"从左到右"读，不用去猜"它到底插在哪两个之间"。
   */
  extraActions?: HTMLElement[];
  /**
   * 操作栏最前面的一行半灰说明。
   *
   * 给"整块说明"用：它讲的是**这个弹窗整体**要做什么，而不是某一个字段 ——
   * 所以不该挤在表单里占一整行，把下面的字段往下推。
   * 放在操作栏前部，正好在"要动手了"的位置上再交代一次。
   *
   * 定位靠操作栏自己的 `justify-content: flex-end`：它是第一个子元素，
   * 剩下的空间都堆到左边，于是它贴左、按钮贴右（见 `.modal-hint`）。
   */
  hint?: string;
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
  /*
   * 半灰说明放在**最前**，靠容器自己的 `justify-content: flex-end` 顶到最左，
   * 按钮自然留在最右 —— 不用给按钮加 `margin-left: auto`。
   * `flex: 0 1 auto` 让它只占文字宽度、需要时能换行收缩，不抢按钮的位置。
   */
  if (spec.hint) actions.append(el('span', { class: 'modal-hint', text: spec.hint }));
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
  actions.append(...(spec.extraActions ?? []), cancel);
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

  /*
   * 返回箭头：回到「工作区」页。
   *
   * 这一页不再是常驻页签（"换个地方"是低频动作，占一个页签不值得），
   * 所以需要一个入口。放在下拉框左边而不是顶上，是因为它和下拉框做的是同一件事
   * （都是"去另一个工作区"），摆在一起语义连贯 —— 左边进去挑，右边直接切。
   */
  const back = el('button', { class: 'wsp-back', type: 'button' });
  back.title = '管理工作区（新建、导入、导出、删除）';
  back.setAttribute('aria-label', '管理工作区');
  back.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  back.addEventListener('click', () => setTab('workspaces'));
  host.append(back);

  /*
   * 一个工作区都没有时，这个下拉**整个不可用**。
   *
   * 它平时是"切到另一个工作区"，而这时候没有任何地方可切 —— 点开只有一句空话。
   * 所以空态下：文案换成「新建工作区」（读起来就像在邀请你点，而不是
   * 一句"还没有工作区"的死描述）、去掉件数、**不生成面板**、
   * 点它也不展开。样式那边同时把它压灰（见 styles.css 的 `.wsp-trigger.blank`）。
   *
   * 这不是"藏起来"：控件留在原地，位置不跳；灰掉的是它的可操作性。
   *
   * 类名用 `blank` 而不是 `empty` —— 样式表里已经有一个全局的 `.empty`
   * （整页占位块，`padding: 56px 24px`），撞上去这个 26px 的按钮会被撑到
   * 133px、顶出顶栏压住下面的横幅。详见 styles.css 里那段注释。
   */
  const blank = list.length === 0;

  const trigger = el('button', { class: `wsp-trigger${blank ? ' blank' : ''}`, type: 'button' });
  /*
   * 状态点。
   *
   * 平时它是绿的，意思是"这个工作区没问题"。**没有工作区的时候绿灯是错的** ——
   * 绿色是全套界面里"一切正常"的信号，而此时连一个工作区都还没有，
   * 亮着绿灯会让人以为"已经就绪，只是没显示出来"。
   * 所以空态换成暗灰的点：只表示"这里没东西"，不表示"一切正常"。
   */
  trigger.append(el('span', { class: `wsp-dot${blank ? ' off' : ''}` }));
  trigger.append(el('span', { class: 'wsp-name', text: blank ? '新建工作区' : (current?.name ?? '') }));
  if (current && current.items !== null) {
    trigger.append(el('span', { class: 'wsp-count', text: `${current.items} 件` }));
  }
  trigger.append(el('span', { class: 'wsp-caret', text: '▾' }));
  if (blank) trigger.setAttribute('aria-disabled', 'true');
  host.append(trigger);

  const panel = el('div', { class: 'wsp-panel hidden' });

  if (blank) {
    /*
     * 空态没有面板可开，但**点一下要能新建** —— 否则这个灰控件就是死的，
     * 用户只能去「工作区」页绕一圈。直接接上新建弹窗，
     * 文案（新建工作区）和动作就对上了。
     */
    trigger.title = '还没有工作区，点这里新建一个';
    trigger.addEventListener('click', () => openNewWorkspace());
    return;
  }

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

/** 拉分组树（层级、排序字段、组顺序都由工作区偏好决定） */
async function loadGroupTree(): Promise<void> {
  if (!state.wsId) {
    state.groupTree = null;
    return;
  }
  /*
   * 分组固定一级（只按分类）。
   *
   * 请求里不再传 levels —— 传了也只是被 core 收下、再原样写回偏好，
   * 而界面上已经没有地方能改它了。留着一个"能改但没人改"的参数，
   * 下次有人接手时会以为它是活的。
   */
  state.groupTree = await window.api.group.list(state.wsId, {
    levels: 1,
    sort: state.sortField,
  });
  state.sortField = state.groupTree.sortedBy;
  /*
   * 每个分组各自的排序，以服务端返回的为准。
   *
   * 服务端会把 `field === 'manual'` 的项剔掉（manual 等于"没设定"，
   * 靠"表里没有"表达），所以这里拿到的就是"设过的那些组"。
   */
  state.groupSort = (state.groupTree.groupSort as typeof state.groupSort) ?? {};
  /*
   * 收起状态**不再从服务端读** —— 分组页默认全部展开。
   *
   * 原来它是存在工作区注册表里的（`collapsed` 数组），于是"上次收起了哪几组"
   * 会跟到下一次打开。但用户的原话是"分类页面默认全部展开"：
   * 每次进来都该看到全部内容，收起只是**这一次**的临时动作。
   *
   * 所以这一份现在是纯内存状态：`state.collapsed` 每次加载都清空，
   * 页面内点收起照常生效，重画/换工作区就回到全展开。
   * 服务端那个字段留着不读（老数据里的值会被忽略），
   * 这样不用写迁移，也不会因为旧值把界面锁成收起态。
   */
  state.collapsed = new Set();
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
  groupSort?: Record<string, { field: string; desc: boolean }>;
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
  state.items = await window.api.item.list(state.wsId, filter);
}

async function reloadAll(): Promise<void> {
  await refreshWorkspaces();
  await Promise.all([refreshAlerts(), refreshItems(), loadGroupTree(), loadColumns()]);
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
    /*
     * 一个工作区都没有 —— 横幅**整条不出现**。
     *
     * 原来这里挂一句「还没有工作区 —— 到「工作区」页新建一个，或直接导入一个归档。」
     * 现在顶栏那个下拉本身就写着「新建工作区」、点一下直接开新建弹窗，
     * 说的和做的跟这句话一模一样 —— 再挂一条横幅是同一个意思说两遍。
     * 而且它还把顶栏和正文切了一刀，让"空"这件事看着更重。
     *
     * 弹窗里还有「导入归档为工作区」的入口，所以删掉这句话不会让人
     * 找不到导入。返回前把 chips 清掉，别留下上一次的残留。
     */
    banner.classList.add('hidden');
    text.textContent = '';
    return;
  }
  banner.classList.remove('hidden');

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
  // 「15 天内到期」原来跳时间轴。时间轴页已取消（见 index.html 与 render() 里的说明），
  // 改跳分组页 —— 那里按分类列出全部物品，也带到期时间与剩余天数，
  // 是现在"看看哪些快到点了"最直接的去处。
  if (soon > 0) add(`${soon} 项 ${SOON_TEXT} 天内到期`, 'info', () => setTab('groups'));
  if (lowStock > 0) add(`${lowStock} 项待补货`, 'info', () => setTab('items'));
  /*
   * 长期物品**不在这里出现**。
   *
   * 这条横幅讲的是"需要留意"，而长期物品的定义就是"没有到期日、不用盯" ——
   * 把它们和需要处理的东西并列是自相矛盾的，还会把真正要看的数字稀释掉。
   * 「长期」自己那张卡片已经报了数量，不必在横幅里再说一遍。
   */
}

/** 把数量显示在导航上，不用切页就知道有多少事 */
function updateTabCounts(): void {
  const a = state.alert;
  const counts: Record<string, number> = {
    items: state.items.length,
    workspaces: state.wsList?.workspaces.length ?? 0,
    groups: a?.counts.items ?? 0,
  };
  document.querySelectorAll('.tab:not(.hidden)').forEach((btn) => {
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
  /** 工作区页没有对应的页签了（入口是返回箭头），高亮规则单独处理 */
  const highlight = tab === 'workspaces' || tab === 'schema' ? null : tab;
  document.querySelectorAll('.tab:not(.hidden)').forEach((b) => {
    b.classList.toggle('active', highlight !== null && (b as HTMLElement).dataset['tab'] === highlight);
  });
  render();
}

function render(): void {
  const view = $('#view');
  view.innerHTML = '';
  // 每个页面自己的标记都要清掉，否则从概览切到物品页会带上概览的样式
  view.classList.remove('has-footer');
  view.classList.remove('no-pad');
  view.classList.remove('dashboard');

  /*
   * 数据目录不可用时**整页置灰**，只留顶部那条和数据位置。
   *
   * 为什么不是"让用户自己看着办"：写不进去的话，任何一次保存都会失败，
   * 而失败点散落在几十个按钮上（新增、编辑、领用、分组拖动…），
   * 每个都弹一次错只会让人以为程序坏了。**一眼看出"还不能用，
   * 先去设置数据目录"比逐个报错好得多。**
   *
   * 只读也不是出路：一个用不了的库存应用，能看不能记没有意义。
   */
  if (state.info && state.info.dataDirWritable === false) {
    view.classList.add('blocked');
    view.classList.add('has-footer');
    // 顶栏的页签与工作区下拉也一起置灰：现在哪都去不了，别装作能点
    document.getElementById('app')?.classList.add('is-blocked');
    view.append(blockedState(state.info));
    view.append(buildDataFooter(state.info));
    return;
  }
  document.getElementById('app')?.classList.remove('is-blocked');

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
  /*
   * 打上标记，让样式能只针对概览页。
   *
   * 这一页的内容高度是**常数**（8 项最先到期 + 2 项待补货），
   * 所以不需要 `.table-wrap` 那条 `max-height: 62vh` 的内部滚动 ——
   * 那个上限还会随视口高度变，让整页高度变成移动目标，
   * 窗口该开多大就永远算不准（默认高度 860/900 都差十几像素，待补货被切在视口外）。
   */
  view.classList.add('dashboard');

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
      '15 天内到期',
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

  /*
   * 概览页的两块固定容量：**8 项最先到期 + 2 项待补货**。
   *
   * 数量固定是为了让这一页的高度稳定 —— 概览是每次打开都会看到的第一屏，
   * 一会儿三行一会儿二十行的话，下面的东西会跟着上下跳，
   * 而且默认窗口高度也没法保证装得下（见 main.ts 的窗口尺寸）。
   *
   * **不满足就有多少显示多少**，不补空行、不显示占位；一项都没有就整块不出现。
   * 空表格比"没有内容"更让人以为出了故障。
   */
  const SOONEST_SLOTS = 8;
  const RESTOCK_SLOTS = 2;

  const soonest = allDated.slice(0, SOONEST_SLOTS);
  if (soonest.length > 0) {
    view.append(
      sectionTitle(
        '最先到期',
        allDated.length > soonest.length
          ? `共 ${allDated.length} 项，显示前 ${soonest.length} 项`
          : `共 ${allDated.length} 项`,
      ),
    );
    view.append(tableWrap(itemsTable(soonest, { quickDelete: true })));
  }

  const restock = (a?.lowStock ?? []).slice(0, RESTOCK_SLOTS);
  if (restock.length > 0) {
    view.append(
      sectionTitle(
        '待补货',
        a && a.lowStock.length > restock.length
          ? `共 ${a.lowStock.length} 项，显示前 ${restock.length} 项`
          : `${restock.length} 项`,
      ),
    );
    view.append(tableWrap(restockTable(restock)));
  }
}

/** 待补货表：概览页与分组页共用 */
function restockTable(rows: RestockRow[]): HTMLElement {
  const t = el('table');
  const head = el('tr');
  /*
   * 数值列的表头**必须与它的值同一边**。
   *
   * 表头默认贴左、值右对齐的话，两者会各自贴住所在列的两端 ——
   * 列一宽（自动布局下经常很宽）就能差出几百像素，
   * 看起来像"列宽算错了"，实际是贴的边不同。
   *
   * 注意「剩余」**不**属于这一类：它的值左边是进度条（`stockBar`），
   * 进度条是一条贴着左侧、长度表示数量的图形，所以那一列两边都靠左。
   * 只有纯数字的「最低库存」「缺口」右对齐，与下面的数字连成一条右边缘。
   */
  for (const h of ['名称', '分类']) head.append(el('th', { text: h }));
  head.append(el('th', { text: '剩余' }));
  for (const h of ['最低库存', '缺口']) head.append(el('th', { class: 'right', text: h }));
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
/**
 * 通用物品表（概览页与别处的紧凑列表用）。
 *
 * `opts.quickDelete` 打开时，**已过期**的行末尾多一个垃圾桶图标 ——
 * 概览页就是给你扫过期物品的，扫到之后最想做的事就是删掉它，
 * 不该再逼你跳转到物品页、找到那一行、再点删除。
 *
 * 只给过期行加，不是所有行都加：一行一个垃圾桶会让整张表变吵，
 * 而且平时删东西走物品页更稳妥（那里有编辑、展开、批量）。
 */
function itemsTable(items: ItemRow[], opts?: { quickDelete?: boolean }): HTMLElement {
  const quickDelete = opts?.quickDelete === true;
  const cols = visibleItemCols(state.columnVisible);
  const t = el('table');
  const head = el('tr');
  for (const c of cols) {
    head.append(el('th', { class: c.align === 'right' ? 'right' : '', text: c.head }));
  }
  if (quickDelete) head.append(el('th', { class: 'col-act', text: '' }));
  t.append(el('thead', {}, head));

  const body = el('tbody');
  for (const it of items) {
    const expired = hasExpired(it);
    const tr = el('tr', { class: expired ? 'row-expired' : '' });

    const bulk = it.is_bulk === 'true';
    const worst = worstExpire(it);
    const ctx: ColCtx = { worst, bulk };
    for (const c of cols) {
      const cell = c.cell(it, ctx);
      // 概览页要在名称旁多标一个「已过期」——这一页就是给你扫过期的
      if (c.key === 'name' && expired) cell.append(el('span', { class: 'tag danger', text: '已过期' }));
      tr.append(cell);
    }
    if (quickDelete) {
      const act = el('td', { class: 'col-act' });
      if (expired) act.append(quickDeleteButton(it));
      tr.append(act);
    }
    body.append(tr);
  }
  t.append(body);
  return t;
}

/** 概览页行末的快速删除：点一下出来的是确认框，不是直接删 */
function quickDeleteButton(it: ItemRow): HTMLElement {
  const btn = trashButton(`删除「${it.name}」`);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    confirmQuickDelete(it);
  });
  return btn;
}

/**
 * 单条快速删除的确认框。
 *
 * 需求要的是"点一下就能删"，但删除不可撤销 —— 图标紧挨着表格内容，
 * 误点很容易。折中是：**图标本身没有任何二次点击**（就是垃圾桶），
 * 点完立刻弹一个只说这一件东西的确认框，按回车即删。
 * 比"长按""再点一次图标"这些手势都直白。
 */
function confirmQuickDelete(it: ItemRow): void {
  const body = el('div');
  const wsName =
    state.wsList?.workspaces.find((w) => w.id === state.wsList?.activeWorkspaceId)?.name ?? '当前工作区';
  body.append(el('p', { text: `将从「${wsName}」删除这条记录。` }));

  const t = el('table');
  const hrow = el('tr');
  for (const h of ['名称', '到期时间', '位置']) hrow.append(el('th', { text: h }));
  t.append(el('thead', {}, hrow));
  const tb = el('tbody');
  const tr = el('tr');
  const worst = worstExpire(it);
  tr.append(
    td(it.name),
    td(worst?.expiresOn ?? it.expiresOn ?? '长期', 'mono'),
    td(it.container ?? '—', 'muted'),
  );
  tb.append(tr);
  t.append(tb);
  body.append(tableWrap(t));

  body.append(
    el('p', {
      class: 'muted small',
      text: '这条记录的出入库流水会一并删除。这一步不可撤销。',
    }),
  );

  openModal({
    title: `删除「${it.name}」？`,
    body,
    actions: [
      {
        label: '删除',
        kind: 'danger',
        onClick: async () => {
          try {
            await window.api.item.delete(state.wsId, it.uuid);
            toast(`已删除「${it.name}」`);
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
      /*
       * 说明挪进悬停提示（和工作区页同一条规则）。
       *
       * 原来的文案是"排序已关闭/已开启……"，那是**一个全局排序开关**时代的话；
       * 现在排序是每列、每分类各自的事，常驻一句"排序已关闭"既不对也不再有用。
       * 改成讲清楚"怎么排、怎么恢复拖动"，需要时悬停即得。
       */
      hoverTip(
        '点列头旁边的 ▲ / ▼ 按那一列排序；再点一次同一个箭头回到手动顺序。\n' +
          '每个分类各自独立 —— 一个分类排了序，不会动到别的分类。\n' +
          '被排序的分类不能拖动行首手柄（拖了也会被排序覆盖）；' +
          '没排序的分类照旧可以拖。',
      ),
    ),
  );

  /*
   * 「还没分类」这件事不再用顶部横幅说。
   *
   * 横幅占了整整一行，却只是在讲一件「未分类」组自己就能说明的事 ——
   * 而那一组永远置顶，本来就在第一屏里。说明改挂在组标题右边的悬停标记上
   * （见下面 renderGroupNode 的 unpin-tip），想看的人悬停即得，
   * 其余时候不占地方。
   */

  // ── 工具栏 ──
  //
  // 排布：分类筛选 → 排序 → （弹性空隙）→ 只看已过期 → 全部收起/展开。
  //
  // 原来这一行堆了九样东西，而且大部分是**噪音**：
  //   - 「按分类分组」标签：分组层级已经取消选择器、固定一级，这句是废话
  //   - 一段常驻的说明文字（"拖动行首的手柄可以固定顺序"）：占了最宽的一块，
  //     却是看两次就记住的东西 —— 挪进 tooltip
  //   - 「开启排序」做成描边按钮样式，视觉重量和旁边真正的按钮一样，
  //     让人分不清哪个是开关哪个是动作
  // 现在：标签去掉、说明进 tooltip、开关统一成朴素复选框，
  // 并用一段弹性空隙把「筛选/排序」和「视图动作」分成两拨。
  const bar = el('div', { class: 'toolbar' });

  /*
   * 当前可见的分组（分类筛选生效时只有一个）。
   *
   * 提前算：工具栏要用它来决定「全部收起」收集哪些键、要不要出现。
   * 注意这里收的是**可见的组**，不是"有子组的节点" —— 见下面那段说明。
   */
  const roots = state.categoryFilter
    ? tree.groups.filter((g) => g.key === state.categoryFilter)
    : tree.groups;

  /*
   * 工具栏只剩两样：右边的「只看已过期」和「全部收起」。
   *
   * ── 去掉了分类筛选下拉 ──
   * 它和分组标题是**同一份信息的两遍**：这一页本来就一个分类一组、
   * 组标题上写着组名和件数，想只看药品直接对那一组做就是了。
   * 下拉只是把同一批东西"藏掉一部分"，却要多点一次、还要多点一次切回来。
   *
   * ── 去掉了排序开关 + 字段下拉 ──
   * 换成点列头排序（见 `sortableTh`）。原来那套有两个说不清的地方：
   *   1. "排序"开关和"字段"下拉互相牵制 —— 关掉开关时下拉还杵在那儿
   *      （虽然禁用了），看起来像坏了；
   *   2. 一个字段排全部分类。想知道"药品里最近到期的"就得把日用品
   *      也一起重排，而用户根本没想动后者。
   * 现在每个分类各排各的，方向由点哪个箭头直接决定。
   */

  // 弹性空隙：把左边（留白）和右边这组视图动作分开，右边贴右
  bar.append(el('span', { class: 'tb-gap' }));

  const onlyExpired = el('label', { class: 'check mini' });
  const oeBox = el('input', { type: 'checkbox', class: 'mini-check' }) as HTMLInputElement;
  oeBox.checked = state.groupOnlyExpired;
  oeBox.addEventListener('change', () => {
    state.groupOnlyExpired = oeBox.checked;
    render();
  });
  onlyExpired.append(oeBox, el('span', { text: '只看已过期' }));
  bar.append(onlyExpired);

  /*
   * 全部收起 / 展开合成一个 toggle。
   *
   * 两个按钮摆在一起，任何时刻总有一个是没用的（全展开时"全部展开"无事可做）。
   * 一个按钮按当前状态换文案更省地方，也更直接地表达"这是同一件事的两面"。
   *
   * ── 曾经坏在这里 ──
   * 原来收集的是"**有子组**的节点"（`n.children.length > 0`）——
   * 那是给二级/三级分组准备的。分组固定一级之后，所有组的 `children` 都是空的，
   * 收集结果是个**空数组**，于是这个按钮点了什么都不发生：
   * 没有报错、按钮也不禁用，就是没反应。
   * 现在收**当前可见的每一个组**，与层级无关。
   */
  const allKeys = roots.map((n) => pathKey(n.path));
  const allCollapsed = allKeys.length > 0 && allKeys.every((k) => state.collapsed.has(k));
  if (allKeys.length > 0) {
    const collapseBtn = el('button', {
      class: 'ghost small',
      text: allCollapsed ? '全部展开' : '全部收起',
    });
    collapseBtn.title = allCollapsed ? '展开所有分组' : '收起所有分组';
    collapseBtn.addEventListener('click', () => {
      /*
       * 只改内存状态，**不存**。
       *
       * "默认全部展开"意味着下次打开一定要是展开的；把它存下来，
       * 那一次"全部收起"就会变成永久的默认，与需求相反。
       */
      state.collapsed = allCollapsed ? new Set() : new Set(allKeys);
      render();
    });
    bar.append(collapseBtn);
  }

  view.append(bar);

  // ── 树 ──（roots 已在工具栏之前算好）
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
    // 两个筛选互不冲突：简明视图看「该处理的」，只看过期看「已经坏了的」
      if (state.groupOnlyExpired) items = items.filter((it) => hasExpired(it));
    const kids = node.children.map((c) => buildGroupNode(c, depth + 1)).filter((x): x is HTMLElement => x !== null);
    if (items.length === 0 && kids.length === 0) return null;

    const key = pathKey(node.path);
    const isCollapsed = state.collapsed.has(key);

    const sec = el('section', {
      /*
       * 收起状态用**一个类**表达，不删节点。
       *
       * 原来收起时直接不生成 `.group-body`：那样 DOM 里"啪"地少一块，
       * 浏览器没有可补间的起止值，只能硬切。
       * 现在节点始终在，收起态由 `sec.collapsed` 交给 CSS 过渡
       * （见 styles.css 的 `grid-template-rows: 0fr → 1fr`）。
       */
      class: `group-section lv-${node.level}${node.pinned ? ' pinned' : ''}${isCollapsed ? ' collapsed' : ''}`,
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
      toggleCollapse(key, sec);
    });
    head.append(caret);
    if (node.pinned) {
      head.append(el('span', { class: 'pin', text: '📌' }));
    } else {
      const grip = el('span', { class: 'grip', text: '⋮⋮' });
      grip.title = '拖动可以固定这一组的顺序';
      head.append(grip);
      makeGroupDraggable(head, node, sec);
    }

    head.append(el('span', { class: 'group-label', text: node.label }));

    /*
     * 「未分类」右边挂一个悬停说明。
     *
     * 原来这段解释是页面顶部的一条横幅，但横幅讲的是这一组自己的性质，
     * 挂在组标题旁边才对得上号 —— 也不占一整行。
     *
     * 件数用 `node.count`（这一组的物品数），正好就是"还没分类"的件数。
     */
    if (node.pinned) {
      const tip = el('span', { class: 'pin-tip', text: '?' });
      tip.title =
        `有 ${node.count} 件物品还没分类，它们在「未分类」组里 —— ` +
        '这一组永远在最上面，不会被排序或拖动移走。';
      head.append(tip);
    }

    const meta = el('span', { class: 'group-meta' });
    meta.append(el('span', { class: 'muted', text: `${node.count} 项` }));
    if (node.expired) meta.append(el('span', { class: 'badge danger', text: `${node.expired} 已过期` }));
    if (node.soon) meta.append(el('span', { class: 'badge info', text: `${node.soon} ${SOON_TEXT} 天内` }));
    // 过保单独标，用中性色 —— 它不是"要马上处理"的事
    if (node.warranty) meta.append(el('span', { class: 'badge muted', text: `${node.warranty} 过保` }));
    if (node.longTerm) meta.append(el('span', { class: 'muted', text: `${node.longTerm} 长期` }));
    // 「置顶 · 不可拖动」不再单独标：右边那个悬停说明把它们讲全了
    head.append(meta);

    head.addEventListener('click', () => toggleCollapse(key, sec));
    sec.append(head);

    // ── 组内容 ──
    // **收起时也照常生成**，只是外面套一层会被 CSS 收成 0 高度的容器 ——
    // 节点必须在 DOM 里，过渡才有起止值可用（见 toggleCollapse 的说明）。
    const body = el('div', { class: 'group-body' });
    const inner = el('div', { class: 'group-body-inner' });
    if (items.length > 0) inner.append(groupItemsTable(items, node));
    for (const k of kids) inner.append(k);
    body.append(inner);
    sec.append(body);

    return sec;
  }
}

/**
 * 收起 / 展开一个分组。
 *
 * ── 做法：内容节点**一直在 DOM 里**，只用类控制显示 ──
 *
 * 试过"先播动画再重画"那套（收起时把节点留在原地播完、展开时 render
 * 之后再加起始态），但它依赖**动画事件和帧时序**：收起要等 transitionend
 * 或一个超时兜底，展开要抢在浏览器绘制之前把起始态挂上。
 * 这些在真实环境里都不稳 —— 少一次事件，内容就永远留在 DOM 里；
 * 抢不到那一帧，浏览器就认为"没有变化"，动画整个不跑。
 *
 * 现在的做法把这些全绕开了：`buildGroupNode` **不再**在收起时跳过
 * `.group-body`，节点始终在；收起态由 `sec.collapsed` 这一个类表达，
 * 交给 CSS 过渡。没有事件、没有计时、也没有"起点必须被绘制过"的假设。
 *
 * 收起态用 `grid-template-rows: 0fr → 1fr`，而不是 `height` 或 `scaleY`：
 *   - `height: 0` 量不到"自动高度"（内容里混着 `<table>` 和绝对定位元素）
 *   - `scaleY(0)` 会把内容压成一团，收起过程中看着像被挤压变形
 * `grid-template-rows` 是真的把高度从 0 过渡到内容高度，也不参与布局计算。
 */
function toggleCollapse(key: string, sec: HTMLElement | null): void {
  const opening = state.collapsed.has(key);
  if (opening) state.collapsed.delete(key);
  else state.collapsed.add(key);
  // **不存**：分组页默认全展开，收起只是这一次的临时动作（见 loadGroupTree）

  /*
   * **就地切换类，不调 render()。**
   *
   * render() 会把整个组重建一遍，新节点没有"收起前"的旧值，
   * 过渡就无从谈起 —— 这正是原来"啪"地一下的原因。
   * 只改这一个类，浏览器手上有完整的起止状态，自己会补间。
   *
   * 局部更新不会和别处不同步：收起状态唯一的事实来源是 `state.collapsed`
   * （上面已经改了），类只是它的投影。
   */
  const target = sec ?? findGroupSection(key);
  if (target) {
    target.classList.toggle('collapsed', !opening);
    target.querySelector('.caret')?.classList.toggle('collapsed', !opening);
    return;
  }
  // 找不到节点（理论上不该发生）才退回整页重画
  render();
}

/**
 * 设置某一个分组的排序。
 *
 * **只动这一个分类**，别的分类原样保留 —— 需求就是"所有分类在排序上互相独立"。
 * 所以这里改的是 `state.groupSort` 里的一个键，不是整页一个 `sortField`。
 *
 * `desc` 传 `null` 表示"清掉这一组的排序，回到手动顺序"：
 * 表里删掉这个键就等于没设定过，`buildTree` 会退回 `opts.sort`
 * （这里是 `manual`），于是拖动又可用。
 *
 * 存整份表（不是增量）：服务端那边也是整份替换，因为"删除"这件事
 * 用合并式更新表达不出来，会留下一个永远清不掉的旧设定。
 */
function setGroupSort(pathKey: string, field: string, desc: boolean | null): void {
  const next = { ...state.groupSort };
  if (desc === null || field === 'manual') delete next[pathKey];
  else next[pathKey] = { field, desc };
  state.groupSort = next;

  /*
   * 顺手把全局 `sortField` 也切到 `manual`。
   *
   * 两个排序来源同时活着的话，`buildTree` 里没被单独设定的组还会按
   * 全局字段排 —— 那样"清掉某一列的排序"就回到的是**上一个全局字段**，
   * 而不是手动顺序，跟按钮上写的对不上。
   * 全局那份留给命令行与概览页用，界面上既然改成了按列点，就让它退场。
   */
  if (state.sortField !== 'manual') {
    state.sortField = 'manual';
    void savePrefs({ sort: 'manual', groupSort: next });
  } else {
    void savePrefs({ groupSort: next });
  }
  void loadGroupTree().then(render);
}

/**
 * 可排序的列头：文案 + 两个箭头（升序 / 降序）。
 *
 * ── 为什么是两个箭头，不是一个可点的标题 ──
 * "点一下切换方向"读起来简单，但它有个说不清的状态：**第一次点是从升序开始
 * 还是降序？** 只能靠一个隐藏的规则（"这个字段默认降序"）决定，
 * 而用户看不到那条规则。两个箭头把"点哪个就是哪个"写在脸上，
 * 而且当前方向高亮哪一支一目了然 —— 不用去猜"现在是升是降"。
 *
 * 当前已排在这一列时，点**同一个箭头**清掉排序、回到手动顺序（即恢复可拖动）。
 * 这条写在标题的悬停提示里。
 */
function sortableTh(
  label: string,
  sortKey: string | undefined,
  groupKey: string,
  align: 'right' | undefined,
  hint: string,
): HTMLElement {
  const cls = [align === 'right' ? 'right' : '', 'sortable'].filter(Boolean).join(' ');
  const th = el('th', { class: cls });

  // 没有排序字段的列（以后可能加）也画出标题，只是不带箭头
  if (!sortKey) {
    th.append(el('span', { class: 'th-label', text: label }));
    return th;
  }

  const cur = state.groupSort[groupKey];
  const active = cur && cur.field === sortKey ? cur : null;
  const def = state.sortFields.find((f) => f.key === sortKey);
  const fieldLabel = def?.label ?? label;

  const make = (desc: boolean, glyph: string): HTMLElement => {
    const on = active?.desc === desc;
    const b = el('button', {
      class: `th-sort${on ? ' on' : ''}`,
      type: 'button',
      text: glyph,
    });
    b.title = on
      ? `取消排序，回到手动顺序（可以拖动）`
      : `按${fieldLabel}${desc ? '降序' : '升序'}排`;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setGroupSort(groupKey, sortKey, on ? null : desc);
    });
    return b;
  };

  th.append(el('span', { class: 'th-label', text: label }));
  const arrows = el('span', { class: 'th-arrows' });
  arrows.append(make(false, '▲'), make(true, '▼'));
  th.append(arrows);
  // 列本身的说明（原来靠 title 挂在 th 上）现在并进这一列的提示里
  th.title = hint;
  return th;
}

/**
 * 取某一列的说明文字（来自 core 的列定义）。
 *
 * 列说明原本挂在 `th` 的 `title` 上，现在那个位置被"点箭头排序"的说明占了，
 * 所以并进 `sortableTh` 传进去的那个提示里 —— 一个列头只留一条提示，
 * 不要出现"悬停看到哪条取决于鼠标落在标题上还是箭头上"这种事。
 */
function hintForCol(key: string): string {
  const def = state.columnAvailable.find((c) => c.key === key);
  const parts: string[] = [];
  if (def?.hint) parts.push(def.hint);
  const col = visibleItemCols(state.columnVisible).find((c) => c.key === key);
  if (col?.sortKey) parts.push('点 ▲ / ▼ 按这一列排序；再点一次同一个箭头回到手动顺序。');
  return parts.join('\n');
}

/**
 * 按 key 找组的 section。
 *
 * key 可能是**空字符串**（未分类那一组），所以不能用属性选择器
 * `[data-path="..."]` —— 它匹配不到空属性，会让动效静默失效。
 * 只能遍历比对。
 */
function findGroupSection(key: string): HTMLElement | null {
  for (const s of Array.from(document.querySelectorAll<HTMLElement>('.group-section'))) {
    if ((s.dataset['path'] ?? null) === key) return s;
  }
  return null;
}

/**
 * 折叠状态用的路径键。
 *
 * 与 core 的 `groupPathKey()` **必须同拼法** —— 界面存的时候和 core 查的时候
 * 各拼一次，拼法一旦不同就是"存了但读不到"，而且不报错、只是设定不生效。
 * 渲染层 import 不到 core，所以这里只能再写一份；改一处要记得另一处。
 */
function pathKey(path: readonly string[]): string {
  return path.join('\u0001');
}

/**
 * 组内物品表。
 *
 * 排序关闭时每行前面有拖动手柄；开启排序时手柄消失 ——
 * 让「现在能不能拖」这件事从界面上直接看得出来，而不是拖了没反应。
 */
function groupItemsTable(items: ItemRow[], node: GroupNode): HTMLElement {
  const groupKey = pathKey(node.path);
  /*
   * 拖动是否可用：**看这一组自己有没有被排序**，不是看整页。
   *
   * 需求是"一旦主动点击按某一列排列之后就不允许拖拽" —— 那个"之后"是
   * 指**这个分类**。整页一刀切会在"药品按到期排、日用品保持手动"时
   * 把日用品的拖动也封掉，而用户要的是两者互不影响。
   */
  const draggable = !state.groupSort[groupKey];
  const cols = visibleItemCols(state.columnVisible);

  const t = el('table', { class: 'items group-items' });
  const head = el('tr');
  // 手柄列**恒在**（不能拖时也占位，避免整行左右跳，见下面物品行的说明）
  head.append(el('th', { class: 'seq drag-col', text: '' }));
  head.append(el('th', { class: 'col-extra', text: '' }));
  head.append(el('th', { class: 'seq right', text: '#' }));
  for (const c of cols) {
    head.append(sortableTh(c.head, c.sortKey, groupKey, c.align, hintForCol(c.key)));
  }
  // 操作列：值是 `.ops`（右对齐），表头也跟着右对齐（见 restockTable 上的说明）
  head.append(el('th', { class: 'right', text: '' }));
  t.append(el('thead', {}, head));

  // colspan：手柄 + 展开箭头 + 位次 + 配置列 + 操作
  // 手柄那一列**恒在**（不能拖时也渲染，见下面），所以不再按 draggable 加减
  const colSpan = cols.length + 4;

  const body = el('tbody');
  body.dataset['path'] = pathKey(node.path);
  if (draggable) body.dataset['droppable'] = '1';

  items.forEach((it, i) => {
    const tr = el('tr', { class: 'item-row' });
    tr.dataset['uuid'] = it.uuid;
    /*
     * 拖动手柄**始终渲染**，被排序的组只是把它置为不可拖。
     *
     * 早先是"不能拖就整个 td 不生成"，于是点了列头排序之后这一列凭空消失，
     * **整行会往左跳一格** —— 用户正在看的那一列位置全变了，
     * 视线得重新找一遍。留着手柄、只是拖不动，位置就稳住了；
     * 也顺带把"为什么拖不动"写在手柄的悬停提示里。
     */
    const grip = el('td', { class: `drag-handle${draggable ? '' : ' locked'}` });
    grip.append(el('span', { class: 'grip', text: '⋮⋮' }));
    grip.title = draggable ? '拖动改变顺序' : '这一组已按列排序，不能拖动；再点一次同一个箭头即可恢复';
    if (!draggable) grip.setAttribute('aria-disabled', 'true');
    tr.append(grip);
    if (draggable) {
      tr.draggable = true;
      makeItemDraggable(tr, body);
    }

    tr.append(el('td', { class: 'col-extra' }, extraToggle(it)));

    // 位次：排序开着时是排序后的位置，关着时就是手动顺序的位置
    tr.append(td(String(i + 1), 'seq muted'));

    const bulk = it.is_bulk === 'true';
    const worst = worstExpire(it);
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

    // 展开区：与物品页同一份实现
    if (state.extraOpen.has(it.uuid)) body.append(extraPanel(it, colSpan));
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
  /**
   * 点这个列头时按哪个排序字段排。
   *
   * 值是 core `SortField` 里的一个 —— 渲染层 import 不到 core，
   * 所以这里只是个字符串，真正认它的是 `buildTree`。
   * 名字与 `key` 大多相同，但**刻意分开写**：`sortKey` 说的是"按什么排"，
   * `key` 说的是"这列画什么"，两者不必一致。
   */
  sortKey?: string;
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
      sortKey: 'name',
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
      sortKey: 'expiry',
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

        /**
         * 显示**最紧迫的那条「过期」**，不是 `expires_on`。
         *
         * 两者常常不是一回事：奶粉保质期还剩 20 天，但开封后有效期只剩 3 天 ——
         * 后者才是要处理的。早先这里固定显示 `expiresOn`，
         * 结果简明视图把这条筛进来了，列表里却写着"剩 20 天"，看着像筛错了。
         */
        const worst = ctx.worst;
        const on = worst?.expiresOn ?? it.expiresOn ?? '';
        const leftText = worst?.daysLeftText ?? it.daysLeftText;

        inner.append(el('span', { class: 'mono', text: on }));
        inner.append(
          el('span', {
            class: `expiry-left ${worst?.expired ? 'lvl-expired-text' : worst ? 'lvl-warn-text' : 'muted'}`,
            text: leftText,
          }),
        );
        // 显示的日期不是「保质期」那条时，标一下是哪来的 —— 否则
        // 用户按这个日期去翻包装上的保质期会对不上
        if (worst && worst.kind !== '保质期') {
          inner.append(el('span', { class: 'expiry-src', text: worst.kind }));
        }
        cell.append(inner);
        return cell;
      },
    },
    {
      key: 'category',
      head: '分类',
      sortKey: 'category',
      cls: 'muted',
      cell: (it) => td(enumLabel('item_category', it.category) || '未分类', 'muted'),
    },
    { key: 'brand', head: '品牌', sortKey: 'brand', cell: (it) => td(it.brand ?? '', 'muted') },
    { key: 'model', head: '型号', sortKey: 'model', cell: (it) => td(it.model ?? '', 'muted mono') },
    {
      key: 'location',
      head: '位置',
      sortKey: 'location',
      cell: (it) => td(it.container ?? '', 'muted'),
    },
    {
      key: 'quantity',
      head: '数量',
      align: 'right',
      sortKey: 'quantity',
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
    { key: 'purchased', head: '入库', sortKey: 'purchased', cell: (it) => td(it.purchased_on ?? '', 'muted mono') },
    { key: 'spec', head: '规格', sortKey: 'spec', cell: (it) => td(it.spec ?? '', 'muted') },
    { key: 'notes', head: '备注', sortKey: 'notes', cell: (it) => td(it.notes ?? '', 'muted wrap') },
  ];
}

/**
 * 垃圾桶图标按钮。
 *
 * 用 SVG 而不是 emoji：emoji 在不同系统上长得不一样，而且会带上颜色，
 * 在这套纯黑界面里很跳。**一个图标就够了**，不放文字 ——
 * 边上已经有「编辑」「消耗」，再加一个"删除"两个字会让操作列挤成一团。
 * 语义靠 title 补足（悬停能看全）。
 */
function trashButton(title: string, small = true): HTMLElement {
  const btn = el('button', {
    class: `icon-btn danger-text${small ? ' small' : ''}`,
    type: 'button',
  });
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<path d="M6 2h4M2.5 4.5h11M4 4.5l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-9"' +
    ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M6.6 7v4.6M9.4 7v4.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '</svg>';
  return btn;
}

/** 退出批量模式：按钮状态与勾选一起清掉，别留下半截状态 */
function exitBatchMode(): void {
  state.batchMode = false;
  state.batchSelected.clear();
}

/**
 * 批量删除：先给用户看清单，再删。
 *
 * 删除不可撤销，所以**必须**有这一步。清单只列前 20 条 ——
 * 勾 300 条时把 300 行塞进弹窗，用户只会看都不看直接点确认，
 * 那这个确认框就白做了。给数量 + 前几条 + "还有 N 条"，
 * 人反而会真的读一遍。
 */
function confirmBatchDelete(): void {
  const uuids = [...state.batchSelected];
  if (uuids.length === 0) return;

  const byUuid = new Map(state.items.map((i) => [i.uuid, i]));
  const named = uuids.map((u) => byUuid.get(u)).filter((x): x is ItemRow => Boolean(x));
  const preview = named.slice(0, 20);

  const body = el('div');
  body.append(
    el('p', {
      text: `将删除 ${uuids.length} 条物品记录。每条的出入库流水会一并删除，这一步不可撤销。`,
    }),
  );

  const t = el('table');
  const hrow = el('tr');
  for (const h of ['名称', '分类', '位置']) hrow.append(el('th', { text: h }));
  t.append(el('thead', {}, hrow));
  const tb = el('tbody');
  for (const it of preview) {
    const tr = el('tr');
    tr.append(
      td(it.name),
      td(enumLabel('item_category', it.category) || '未分类', 'muted'),
      td(it.container ?? '—', 'muted'),
    );
    tb.append(tr);
  }
  t.append(tb);
  body.append(tableWrap(t));

  if (named.length < uuids.length) {
    body.append(
      el('p', {
        class: 'muted small',
        text: `另有 ${uuids.length - named.length} 条不在当前列表里（可能已被筛选或已删除）。`,
      }),
    );
  }
  if (uuids.length > preview.length) {
    body.append(el('p', { class: 'muted small', text: `上面只列了前 ${preview.length} 条。` }));
  }

  openModal({
    title: `删除选中的 ${uuids.length} 条？`,
    wide: true,
    body,
    actions: [
      {
        label: `删除 ${uuids.length} 条`,
        kind: 'danger',
        onClick: async () => {
          try {
            const res = await window.api.item.deleteMany(state.wsId, uuids);
            // 已被别处删掉的条目会算进 missing，说清楚免得用户以为出错了
            toast(
              res.missing > 0
                ? `已删除 ${res.deleted} 条（${res.missing} 条此前已不在）`
                : `已删除 ${res.deleted} 条`,
            );
            exitBatchMode();
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

/** 按配置取列定义。`keys` 来自 core，已经保证锁定列在里面 */
function visibleItemCols(keys: string[] | undefined): ItemCol[] {  const all = itemCols();
  if (!keys || keys.length === 0) return all;
  const wanted = new Set(keys);
  const picked = all.filter((c) => wanted.has(c.key));
  // 兜底：core 已经保证「物品」「到期时间」在，这里再防一次空表
  return picked.length > 0 ? picked : all;
}

// ─────────────────────────────────────────────────────────────
// 展开区（补充信息）
//
// 需求：表格里加一个"按键"，用户主动点开才显示位置、规格、备注这些，
// 默认不占地方。位置/规格/备注仍然是**真实字段**（要参与分组、搜索、导出），
// 额外每件东西还能自己加字段，那些存在 items.extra_json 里（扁平 JSON）。
//
// 就地展开而不是弹窗：能边看列表边看详情，也不用为"看一眼"付一次
// 弹窗开关的代价。展开状态记在 state 里，页面重画后保持。
// ─────────────────────────────────────────────────────────────

/** 行首的展开按钮 */
function extraToggle(it: ItemRow): HTMLElement {
  const open = state.extraOpen.has(it.uuid);
  const btn = el('button', {
    class: `extra-toggle${open ? ' open' : ''}`,
    type: 'button',
    text: '▸',
    title: open ? '收起补充信息' : '展开补充信息（位置、规格、备注、自定义字段）',
  });
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (open) state.extraOpen.delete(it.uuid);
    else state.extraOpen.add(it.uuid);
    render();
  });
  return btn;
}

/**
 * 展开后的内容区，占满整行（colspan）。
 *
 * 数据是**按需拉取**的：列表接口不返回 extra_json 里的自定义字段，
 * 因为绝大多数行不会被展开。这样列表查询不用为没人看的数据买单。
 */
function extraPanel(it: ItemRow, colSpan: number): HTMLElement {
  const tr = el('tr', { class: 'extra-row' });
  const tdEl = el('td');
  tdEl.colSpan = colSpan;

  const box = el('div', { class: 'extra-box' });
  box.append(el('div', { class: 'extra-loading muted small', text: '正在读取…' }));
  tdEl.append(box);
  tr.append(tdEl);

  void (async () => {
    try {
      const data = await window.api.item.extra(state.wsId, it.uuid);
      box.innerHTML = '';
      box.append(buildExtraEditor(it, data));
    } catch (err) {
      box.innerHTML = '';
      box.append(el('div', { class: 'muted small', text: `读取失败：${(err as Error).message}` }));
    }
  })();

  return tr;
}

/**
 * 编辑器：三个真实字段 + 任意条自定义字段。
 *
 * 保存策略是**失焦即存**，没有"保存"按钮 ——
 * 展开区本来就是随手记一笔的地方，多一步确认只会让人不想用。
 * 每次只提交**改动的那个键**，不是整份覆盖，避免两个字段互相覆盖。
 */
function buildExtraEditor(
  it: ItemRow,
  data: {
    fields: { key: string; label: string; value: string }[];
    custom: Record<string, string>;
  },
): HTMLElement {
  const wrap = el('div', { class: 'extra-grid' });

  /** 提交单个键；值空串 = 清除 */
  const commit = async (key: string, value: string): Promise<void> => {
    try {
      await window.api.item.extraSave(state.wsId, it.uuid, { [key]: value });
      // 位置/规格/备注改了要反映到列表行的列上，所以重拉列表
      await refreshItems();
      render();
    } catch (err) {
      fail(err);
    }
  };

  const rowFor = (label: string, key: string, value: string, multiline: boolean): HTMLElement => {
    const row = el('div', { class: 'extra-field' });
    row.append(el('label', { class: 'extra-label', text: label }));

    const input = (
      multiline
        ? el('textarea', { name: `ex_${key}`, rows: '2' })
        : el('input', { type: 'text', name: `ex_${key}` })
    ) as HTMLInputElement | HTMLTextAreaElement;
    input.value = value;
    input.placeholder = multiline ? '随手记一笔…' : '（空）';

    // 失焦即存，且只在真的变了的时候发请求
    let last = value;
    input.addEventListener('blur', () => {
      if (input.value === last) return;
      last = input.value;
      void commit(key, input.value);
    });
    // 回车提交（多行框用 Ctrl+Enter）
    input.addEventListener('keydown', (ev) => {
      const isEnter = (ev as KeyboardEvent).key === 'Enter';
      if (!isEnter) return;
      if (multiline && !(ev as KeyboardEvent).ctrlKey) return;
      ev.preventDefault();
      input.blur();
    });

    row.append(input);

    // 有内容才给"清除"，空的时候放个按钮只是噪音
    if (value !== '') {
      const clear = el('button', { class: 'ghost small', type: 'button', text: '清除' });
      clear.title = '清空这一项';
      clear.addEventListener('click', () => {
        input.value = '';
        last = '';
        void commit(key, '');
      });
      row.append(clear);
    }

    return row;
  };

  // ── 固定三项：位置 / 规格 / 备注 ──
  for (const f of data.fields) {
    // 位置就是一个自由文本框（房间那一级取消了）
    if (f.key === 'location') {
      const row = el('div', { class: 'extra-field' });
      row.append(el('label', { class: 'extra-label', text: '位置' }));
      const inp = el('input', { type: 'text', name: 'ex_container' }) as HTMLInputElement;
      inp.value = it.container ?? '';
      inp.placeholder = '如 客厅药箱-上层';
      let last = inp.value;
      inp.addEventListener('blur', () => {
        if (inp.value === last) return;
        last = inp.value;
        void commit('container', inp.value);
      });
      // 列表行里已经带了 container，直接用，省一次请求
      row.append(inp);
      wrap.append(row);
      continue;
    }
    wrap.append(rowFor(f.label, f.key, f.value, f.key === 'notes'));
  }

  // ── 自定义字段 ──
  const customKeys = Object.keys(data.custom).sort((a, b) => a.localeCompare(b, 'zh'));
  if (customKeys.length > 0) {
    wrap.append(el('div', { class: 'extra-sep', text: '这件东西自己的字段' }));
    for (const k of customKeys) {
      const row = rowFor(k, k, data.custom[k] ?? '', (data.custom[k] ?? '').length > 60);
      row.classList.add('custom');
      // 自定义字段可以整条删掉（键也一起没）
      const del = el('button', { class: 'ghost small danger-text', type: 'button', text: '删除' });
      del.title = `删除字段「${k}」`;
      del.addEventListener('click', () => void commit(k, ''));
      row.append(del);
      wrap.append(row);
    }
  }

  // ── 加一个字段 ──
  const adder = el('div', { class: 'extra-add' });
  const keyInput = el('input', { type: 'text', name: 'newFieldKey', placeholder: '字段名，如 滤网型号' }) as HTMLInputElement;
  const valInput = el('input', { type: 'text', name: 'newFieldValue', placeholder: '值' }) as HTMLInputElement;
  const addBtn = el('button', { class: 'ghost small', type: 'button', text: '＋ 加一个字段' });

  const doAdd = (): void => {
    const key = keyInput.value.trim();
    const value = valInput.value;
    if (key === '') {
      keyInput.focus();
      return;
    }
    if (key === 'location' || key === 'spec' || key === 'notes' || key === 'container') {
      // 这几个是固定项，别让用户以为加了个新的
      toast('「位置」「规格」「备注」已经在上面了，换个字段名', 'warn');
      return;
    }
    keyInput.value = '';
    valInput.value = '';
    void commit(key, value === '' ? '（空）' : value);
  };

  addBtn.addEventListener('click', doAdd);
  valInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      ev.preventDefault();
      doAdd();
    }
  });
  keyInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') {
      ev.preventDefault();
      valInput.focus();
    }
  });

  adder.append(keyInput, valInput, addBtn);
  wrap.append(adder);
  wrap.append(
    el('div', {
      class: 'muted small extra-note',
      text: '改动在离开输入框时自动保存。自定义字段是这件东西独有的，不会影响别的物品。',
    }),
  );

  return wrap;
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

  const colBtn = el('button', { class: 'ghost', text: '列设置' });
  colBtn.title = '选择这张表显示哪些列。「物品」与「到期时间」必须显示。';
  colBtn.addEventListener('click', () => openColumnSettings());
  bar.append(colBtn);

  /*
   * 批量删除。
   *
   * 两步走：先点「批量删除」进入选择模式（每行前面冒出复选框），
   * 勾完再点一次（这时按钮已经变成「删除选中 (N)」）才真的删。
   *
   * 为什么不常驻复选框：常驻的话误点一下就直接进了删除流程；
   * 而删除不可撤销。让它需要"有意进入"这一步，代价很小。
   */
  const batchBtn = el('button', {
    class: state.batchMode ? 'danger' : 'ghost',
    text: state.batchMode
      ? state.batchSelected.size > 0
        ? `删除选中 (${state.batchSelected.size})`
        : '删除选中'
      : '批量删除',
  });

  if (!state.batchMode) {
    batchBtn.title = '进入选择模式，勾选多条后一起删除';
    batchBtn.addEventListener('click', () => {
      state.batchMode = true;
      state.batchSelected.clear();
      render();
    });
  } else {
    batchBtn.disabled = state.batchSelected.size === 0;
    batchBtn.title =
      state.batchSelected.size === 0 ? '先勾选要删除的物品' : `删除勾选的 ${state.batchSelected.size} 条`;
    batchBtn.addEventListener('click', () => confirmBatchDelete());
  }
  bar.append(batchBtn);

  if (state.batchMode) {
    const done = el('button', { class: 'ghost', text: '完成' });
    done.title = '退出选择模式，不改动任何数据';
    done.addEventListener('click', () => {
      exitBatchMode();
      render();
    });
    bar.append(done);

    const all = el('button', { class: 'ghost small', text: '全选' });
    all.title = '勾选当前列表里的全部物品（受搜索与分类筛选影响）';
    all.addEventListener('click', () => {
      for (const it of state.items) {
        state.batchSelected.add(it.uuid);
      }
      render();
    });
    const none = el('button', { class: 'ghost small', text: '全不选' });
    none.addEventListener('click', () => {
      state.batchSelected.clear();
      render();
    });
    bar.append(all, none);
  }

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
  if (state.batchMode) {
    // 表头这个复选框只管"全选/全不选"，不表示任何一条的状态
    const allBox = el('input', { type: 'checkbox', class: 'batch-box' }) as HTMLInputElement;
    const shownForAll = state.items;
    allBox.checked = shownForAll.length > 0 && shownForAll.every((i) => state.batchSelected.has(i.uuid));
    allBox.indeterminate =
      !allBox.checked && shownForAll.some((i) => state.batchSelected.has(i.uuid));
    allBox.title = allBox.checked ? '全不选' : '全选当前列表';
    allBox.addEventListener('change', () => {
      if (allBox.checked) for (const i of shownForAll) state.batchSelected.add(i.uuid);
      else state.batchSelected.clear();
      render();
    });
    head.append(el('th', { class: 'col-batch' }, allBox));
  } else {
    head.append(el('th', { class: 'col-extra', text: '' })); // 展开箭头
  }
  head.append(el('th', { class: 'col-dot', text: '' })); // 到期状态色点，固定列
  for (const c of cols) {
    head.append(el('th', { class: c.align === 'right' ? 'right' : '', text: c.head }));
  }
  head.append(el('th', { class: 'right', text: '' })); // 操作列，固定（值是 .ops，右对齐）
  t.append(el('thead', {}, head));

  // 展开行的 colspan：箭头 + 色点 + 配置列 + 操作
  const colSpan = cols.length + 3;

  const body = el('tbody');
  // 简明视图：本地筛选，不发请求
  const shown = state.items;
  for (const it of shown) {
    const tr = el('tr');
    if (it.lowStock) tr.classList.add('low-stock');
    const bulk = it.is_bulk === 'true';
    if (!bulk && it.remaining <= 0) tr.classList.add('spent');

    // 展开区：默认不占地方，点开才显示
    if (state.batchMode) {
      const checked = state.batchSelected.has(it.uuid);
      const box = el('input', { type: 'checkbox', class: 'batch-box' }) as HTMLInputElement;
      box.checked = checked;
      box.title = checked ? `取消勾选「${it.name}」` : `勾选「${it.name}」`;
      box.addEventListener('change', () => {
        if (box.checked) state.batchSelected.add(it.uuid);
        else state.batchSelected.delete(it.uuid);
        /*
         * 重画整张表，否则表头那个"全选"的选中/半选状态不会跟着变 ——
         * 它是在表头画的时候算一次的。只改这一格会留下一个说谎的表头。
         */
        render();
      });
      tr.append(el('td', { class: 'col-batch' }, box));
      if (checked) tr.classList.add('batch-on');
    } else {
      tr.append(el('td', { class: 'col-extra' }, extraToggle(it)));
    }

    // 第一列：到期状态色点，一眼扫出哪些要处理
    const worst = worstExpire(it);
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

    // ── 展开区：补充信息（位置/规格/备注 + 自定义字段）──
    // 按需拉数据，所以只有真的展开了才发请求
    if (state.extraOpen.has(it.uuid)) {
      body.append(extraPanel(it, colSpan));
    }

    // ── 嵌套行：批量物品配了「一组库存」时，紧跟着列出每一条 ──
    // 列数随配置变，所以用 colspan 撑一格而不是硬凑空 td
    if (bulk && it.stockCount > 1 && state.expanded.has(it.uuid)) {
      const sub = el('tr', { class: 'stock-sub' });
      sub.append(el('td', { class: 'col-extra' }));
      sub.append(el('td', { class: 'dot muted', text: '└' }));
      const info = el('td', { class: 'muted small' });
      info.colSpan = cols.length + 1;
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
      /*
       * "每个工作区是一个独立的 SQLite 文件"这句挪进悬停提示。
       *
       * 它是看两次就记住的东西，却和标题一样重地占着那一行 ——
       * 标题旁边应该只有"当前状态"，不是说明书。
       *
       * 提示用**自己画的浮层**（`.tip-text`），不用原生 `title`：
       * 原生提示是系统画的方角白框，跟这套纯黑主题不是一回事
       * （这条在 AGENTS.md 里记着）。
       */
      hoverTip('每个工作区是一个独立的 SQLite 文件，互相隔离'),
    ),
  );

  const head = el('div', { class: 'toolbar' });
  head.append(add, imp);
  scroll.append(head);

  const t = el('table');
  const hrow = el('tr');
  // 列的顺序必须与下面数据行 append 的顺序一致：
  // 当前标记 · 名称 · 说明 · 待办 · 物品 · 流水 · 来源 · 创建时间 · 大小 · 完整性 · 操作
  hrow.append(el('th', { text: '' })); // 当前标记
  hrow.append(el('th', { text: '名称' }));
  hrow.append(el('th', { text: '说明' }));
  /*
   * 数值列的表头与它的值同一边（右对齐）。
   * 表头贴左、值贴右的话，两者会各自贴住列的两端 ——
   * 列一宽就能差出几百像素，看起来像"列宽算错了"。
   * 详见 restockTable 上的说明。
   */
  for (const h of ['待办', '物品', '流水']) hrow.append(el('th', { class: 'right', text: h }));
  hrow.append(el('th', { text: '来源' }));
  hrow.append(el('th', { text: '创建时间' }));
  hrow.append(el('th', { class: 'right', text: '大小' }));
  // 「完整性」的值是 ✓ ok / ✖ 异常 居中显示，表头也就不右对齐
  hrow.append(el('th', { text: '完整性' }));
  // 空表头 + 空的 ops 单元格，这个 `right` 只是把"两边的对齐方式"写一致，
  // 免得以后有人给操作列加文字时又踩到表头贴左、内容贴右
  hrow.append(el('th', { class: 'right', text: '' }));
  t.append(el('thead', {}, hrow));

  const body = el('tbody');
  for (const w of state.wsList?.workspaces ?? []) {
    const tr = el('tr');
    if (w.active) tr.classList.add('selected');

    // 当前工作区用一个明显的圆点，其余留白
    tr.append(td(w.active ? '●' : '', w.active ? 'active-dot' : ''));

    // 名称整格可点：点一下即切过去，**并直接落到概览页**
    const nameCell = el('td', { class: 'clickable' });
    const nameWrap = el('div', { class: 'ws-name' });
    nameWrap.append(el('span', { class: 'link', text: w.name }));
    if (w.active) nameWrap.append(el('span', { class: 'tag ok-tag', text: '当前' }));
    nameCell.append(nameWrap);
    nameCell.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      /*
       * 点了名字就进那个工作区的概览页。
       *
       * 原来只切工作区、留在"工作区"这一页上 —— 于是点完只看到列表里
       * 那个圆点挪了一格，人还得自己再点一次「概览」。切工作区的意图
       * 本来就是"去看那个库"，落到概览页才是把这件事做完。
       * 悬停提示也去掉了：整格可点加上悬停变色已经说明了这件事，
       * 再挂一个原生 title 只会弹出一个方角白框。
       */
      void switchWorkspace(w.id, { goDashboard: true });
    });
    tr.append(nameCell);

    tr.append(td(w.notes ?? '', 'muted'));

    /*
     * 待办列。原来这里是「清理已用完 (N)」按钮 —— 那个只是把用完的东西
     * 从列表里扫掉，属于收拾；工作区列表真正该回答的是
     * "哪个工作区有东西要处理"。过期和临期才是要处理的事。
     */
    const pendingCell = el('td', { class: 'right' });
    if (w.pending === null) {
      pendingCell.append(el('span', { class: 'muted', text: '—' }));
    } else if (w.pending === 0) {
      pendingCell.append(el('span', { class: 'muted', text: '无' }));
    } else {
      const chip = el('span', { class: 'pending-chip', text: `存在待办 ${w.pending}` });
      chip.title = `${w.pending} 条已过期或 15 天内到期（长期物品不计入）`;
      pendingCell.append(chip);
    }
    tr.append(pendingCell);

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
    editBtn.title = '修改名称与说明';    editBtn.addEventListener('click', () => openEditWorkspace(w));

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
 * 数据目录不可用时的整页替身。
 *
 * 讲三件事：**为什么用不了**、**怎么办**、以及**数据没丢** ——
 * 最后一条最要紧：看到程序说"目录写不进去"，第一反应通常是"我的数据完了"。
 */
function blockedState(info: AppInfo): HTMLElement {
  const wrap = el('div', { class: 'blocked-state' });

  wrap.append(el('div', { class: 'bs-icon', text: '!' }));
  wrap.append(el('h2', { text: '数据目录不可用' }));

  wrap.append(
    el('p', {
      text: '程序所在的位置写不进去（装在 Program Files 这类受保护目录里就会这样），所以现在不能记录任何东西。',
    }),
  );

  const facts = el('div', { class: 'kv' });
  facts.append(
    el('span', { class: 'k', text: '当前目录' }),
    el('span', { class: 'v mono', text: info.dataDir }),
  );
  if (info.dataDirReason) {
    facts.append(
      el('span', { class: 'k', text: '原因' }),
      el('span', { class: 'v danger-text', text: info.dataDirReason }),
    );
  }
  facts.append(
    el('span', { class: 'k', text: '建议位置' }),
    el('span', { class: 'v mono', text: info.dataDirFallback }),
  );
  wrap.append(facts);

  const fix = el('button', { class: 'primary', text: '设置数据目录' });
  fix.addEventListener('click', () => openDataDirDialog());
  wrap.append(el('div', { class: 'bs-actions' }, fix));

  wrap.append(
    el('p', {
      class: 'muted small',
      text:
        '数据不会因为这一步丢失：换目录只是换一个存放位置，' +
        '选一个已有数据的目录就继续用那份数据。',
    }),
  );

  return wrap;
}

/**
 * 数据位置条：**固定在内容区底部**。
 * 之前它是页面里一个普通卡片，工作区一多就被挤到屏幕外 ——
 * 而「我的数据到底存在哪」是随时可能要看的信息。
 *
 * 数据目录不可用时，这条是整个界面**唯一还能操作的地方**，
 * 所以它要变醒目（`.df-blocked`）、把原因写清楚，并给出配置入口。
 */
function buildDataFooter(info: AppInfo | null): HTMLElement {
  const blocked = info !== null && info.dataDirWritable === false;
  const bar = el('div', { class: `data-footer${blocked ? ' df-blocked' : ''}` });

  const left = el('div', { class: 'df-left' });
  left.append(el('span', { class: 'df-label', text: blocked ? '数据目录（不可用）' : '数据目录' }));
  const path = el('code', { class: 'df-path', text: info?.dataDir ?? state.wsList?.dataDir ?? '—' });
  path.title = info?.dataDir ?? '';
  left.append(path);
  bar.append(left);

  const right = el('div', { class: 'df-right' });

  if (blocked) {
    // 写不进去的原因直接摊开：用户得知道是"权限"还是"盘只读"
    if (info?.dataDirReason) {
      right.append(el('span', { class: 'df-reason', text: info.dataDirReason }));
    }
    const fix = el('button', { class: 'primary small', text: '设置数据目录' });
    fix.addEventListener('click', () => openDataDirDialog());
    right.append(fix);
    bar.append(right);
    return bar;
  }

  if (info) {
    /*
     * 底栏去掉两样东西。
     *
     * 一是版本号（`v0.1.0 · 数据结构 v9 · Electron 44.5.1`）—— 它挪到窗口标题栏了。
     * 底栏这一行是拿来放"数据在哪、怎么打开"的，塞一串版本号只会把有用的挤掉。
     *
     * 二是两个按钮的边框：它们是这一行唯一的操作，做成描边按钮后
     * 视觉重量和左边的路径一样重，整条底栏显得又满又碎。
     * 改成"文字 + 悬停才出现的底色"（.df-link），安静下来之后
     * 真正的内容（路径）反而更清楚。
     */
    if (!info.dataDirConfigured) {
      const move = el('button', { class: 'df-link', text: '更改数据目录' });
      move.title = '当前用的是程序目录下的 data/；可以换到别处';
      move.addEventListener('click', () => openDataDirDialog());
      right.append(move);
    }
    const open = el('button', { class: 'df-link', text: '在资源管理器中打开' });
    open.addEventListener('click', () => void window.api.io.openPath(info.dataDir).catch(fail));
    right.append(open);
  }
  bar.append(right);

  return bar;
}

/**
 * 设置数据目录。
 *
 * 讲清楚**不会搬数据**：目标目录里已有数据就继续用，空的就当新起点。
 * 含糊其辞会让人以为原数据被迁走了，然后去找一个其实没动过的目录。
 */
function openDataDirDialog(): void {
  const info = state.info;
  const body = el('div', { class: 'form' });

  const current = el('div', { class: 'kv' });
  current.append(
    el('span', { class: 'k', text: '当前目录' }),
    el('span', { class: 'v mono', text: info?.dataDir ?? '—' }),
  );
  if (info?.dataDirWritable === false && info.dataDirReason) {
    current.append(
      el('span', { class: 'k', text: '不可用原因' }),
      el('span', { class: 'v danger-text', text: info.dataDirReason }),
    );
  }
  body.append(current);

  const picked = el('div', { class: 'muted small', text: '尚未选择新目录。' });
  body.append(picked);

  let chosen: string | null = null;

  const choose = el('button', { class: 'small', text: '浏览…' });
  choose.addEventListener('click', () => {
    void (async () => {
      try {
        const r = await window.api.app.pickDataDir();
        if (r.canceled || !r.dir) return;
        if (r.writable === false) {
          chosen = null;
          picked.className = 'small danger-text';
          picked.textContent = `这个目录写不进去：${r.reason ?? '未知原因'}`;
          save.disabled = true;
          return;
        }
        chosen = r.dir;
        picked.className = 'small ok-text';
        picked.textContent = `将使用：${r.dir}`;
        save.disabled = false;
      } catch (err) {
        fail(err);
      }
    })();
  });

  const save = el('button', { class: 'primary', text: '保存并重新加载' });
  save.disabled = true;
  save.addEventListener('click', () => {
    if (!chosen) return;
    void (async () => {
      try {
        await window.api.app.setDataDir(chosen);
        // 换了目录就等于换了一份数据，整页重载最稳 —— 免得残留上一个目录的状态
        window.location.reload();
      } catch (err) {
        fail(err);
      }
    })();
  });

  const reset = el('button', { class: 'ghost small', text: '回到默认位置' });
  reset.title = '默认是程序目录下的 data/';
  reset.addEventListener('click', () => {
    void (async () => {
      try {
        await window.api.app.resetDataDir();
        window.location.reload();
      } catch (err) {
        fail(err);
      }
    })();
  });

  body.append(
    el('p', {
      class: 'muted',
      text:
        '设置只记住"数据放在哪"，不会搬运或删除任何文件。' +
        '选一个已有数据的目录就继续用那份数据；选空目录就是从头开始。',
    }),
  );
  if (info?.dataDirFallback) {
    body.append(el('p', { class: 'muted', text: `建议：${info.dataDirFallback}` }));
  }
  if (info?.bootstrapPath) {
    body.append(el('p', { class: 'muted small', text: `这个设置记在：${info.bootstrapPath}` }));
  }

  openModal({
    title: '数据目录',
    body,
    actions: [],
    extraActions: [reset, choose, save],
  });
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
  add('存放位置', it.container ?? '—');
  add('状态', enumLabel('item_status', it.status));
  add('批量物品', bulk ? '是' : '否');
  add('到期', d.expiry.length === 0 ? '长期' : d.expiry.map((e) => e.expiresOn).join(' / '));
  add('入库日期', it.purchased_on ?? '');
  add('来源渠道', it.store ?? '');
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
    // 列顺序与下面的数据行一致。「数量」是数值列：表头与值都右对齐
    // （见 restockTable 上的说明 —— 分贴两端在宽列里能差出约 250px）
    sh.append(el('th', { text: '组' }));
    sh.append(el('th', { class: 'right', text: '数量' }));
    for (const h of ['到期', '剩余时间', '购买', '渠道']) sh.append(el('th', { text: h }));
    sh.append(el('th', { class: 'right', text: '' })); // 操作列（值是 .ops，右对齐）
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
    // 列顺序与下面的数据行一致。「变化」是数值列（+3 / -1），
    // 表头与值同边右对齐（见 restockTable 上的说明）
    mh.append(el('th', { text: '日期' }));
    mh.append(el('th', { class: 'right', text: '变化' }));
    for (const h of ['原因', '备注']) mh.append(el('th', { text: h }));
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

  body.append(field('入库日期', input('purchased_on', stock?.purchasedOn ?? '', 'date')));
  body.append(field('单价（元）', input('unitPriceYuan', stock?.unitPriceYuan ?? '', 'text', '如 2.50')));
  body.append(field('来源渠道', input('store', stock?.store ?? '', 'text', '如 山姆')));
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
  body.append(
    field(
      '位置',
      input('container', existing?.container ?? '', 'text', '如 客厅药箱-上层'),
      '写多细都行，不填也可以',
    ),
  );

  // ── 多少 ──
  // 默认不是批量物品：数量恒为 1，这里只是展示，不给改
  const bulkBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  bulkBox.checked = existing?.is_bulk === 'true';
  const bulkWrap = el('label', { class: 'check' });
  bulkWrap.append(bulkBox, el('span', { text: '批量物品（需要按个数管理，如抽纸 / 电池 / 口罩）' }));
  const bulkField = el('div', { class: 'field span-2' });
  bulkField.append(bulkWrap);
  /*
   * 这句说明挪进悬停提示。
   *
   * 它是"看一次就记住"的规则 —— 而且只在**第一次**勾这个框之前有用，
   * 却常驻占着一整行，把下面真正要填的「数量」推下去。
   * 挂在勾选框旁边那个 `?` 上，需要时悬停即得。
   *
   * 提示用 `hoverTip()` 自己画（不用原生 `title`）—— 见 AGENTS.md 那条规则。
   */
  bulkWrap.append(hoverTip('不开启时数量恒为 1，操作是「消耗」一次归零；开启后才能设数量、多次领用、设最低库存'));
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
  body.append(field('入库日期', input('purchased_on', existing?.purchased_on ?? new Date().toISOString().slice(0, 10), 'date')));
  body.append(field('来源渠道', input('store', existing?.store ?? '', 'text', '如 京东健康')));

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
  /*
   * 这里原来还有个「写入演示数据」勾选框（默认勾着）。
   *
   * 去掉的理由：新建工作区是**用户要装自己东西**的时刻，
   * 默认塞 17 件虚构物品进去，第一件事就变成"先删掉这些不认识的东西" ——
   * 而删的过程还要一件件确认，比空着难受得多。
   * 想看效果的人不缺入口：命令行 `inventory ws seed <工作区>` 专门做这件事，
   * 而且它要求工作区是空的，不会污染已有的数据。
   */
  /*
   * 那句"全新的空 SQLite 文件、与其它工作区隔离"从表单里挪到了操作栏前部。
   *
   * 它讲的是**这个弹窗整体**要做什么，不是"名称"这个字段怎么填 ——
   * 挂在输入框右边，读起来像是给名称的补充说明，而且把表单撑成两栏、
   * 整块显得很空。移到操作栏前部（半灰），正好在"要动手了"的位置再交代一次。
   */
  openModal({
    title: '新建工作区',
    body,
    hint: '新工作区是一个全新的空 SQLite 文件，与其它工作区完全隔离。',
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
          const res = await window.api.ws.create(v['name'].trim());
          toast(`工作区「${res.name}」已创建`);
          $('#modal-root').classList.add('hidden');
          state.wsId = res.id;
          await reloadAll();
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

/**
 * 切换工作区。
 *
 * `goDashboard` 用于「工作区」页里点了某个名字的场景：切完直接落到概览页。
 * 不带这个标志时（顶栏下拉框切换）停在当前页 —— 在那里换工作区
 * 常常是"换个库继续看物品页"，把人踢回概览反而打断了手头的事。
 */
async function switchWorkspace(id: string, opts?: { goDashboard?: boolean }): Promise<void> {
  try {
    await window.api.ws.use(id);
    state.wsId = id;
    state.filter = { search: '', category: '' };
    // 换工作区必须清空勾选：留着上一个库的 uuid 去删这个库的东西，
    // 用户会以为自己删的是眼前这些
    exitBatchMode();
    await reloadAll();
    if (opts?.goDashboard) setTab('dashboard');
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
  document.querySelectorAll('.tab:not(.hidden)').forEach((b) => {
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

    /*
     * 版本号进标题栏。
     *
     * 界面上原来在两处显示版本：左上角应用名旁边、以及底栏数据目录那条。
     * 两处都去掉了 —— 那些位置该留给工作区和操作。标题栏是唯一还合适的落点：
     * 它本来就写着应用名，宽度也够，用户要报版本号时第一眼就会看标题栏。
     *
     * 放在这里而不是主进程的 BrowserWindow 选项里，是因为**数据结构版本**
     * （schemaVersion）只有 core 知道，主进程那边只能写死应用版本。
     */
    document.title = `${state.info.name} ${state.info.version} · 数据结构 v${state.info.schemaVersion}`;

    /*
     * 数据目录不可用就**到此为止**，别再去读工作区。
     *
     * 只读目录下连 `ws.list()` 都会抛（打开数据库要写 `-shm`），
     * 那样异常会被下面的 catch 兜成一句"启动失败"，用户看到的是
     * 一个空白页加一行报错 —— 而真正该看到的是"去设置数据目录"。
     * 所以在这里早退，直接把降级态画出来。
     */
    if (state.info.dataDirWritable === false) {
      renderBanner();
      render();
      return;
    }

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
