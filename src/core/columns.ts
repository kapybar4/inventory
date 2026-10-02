/**
 * 表格列配置。
 *
 * ── 需求 ──
 *
 * 用户自己决定物品表里显示哪些列，但**「物品」与「到期时间」必须显示**。
 * 这两条不是随手定的：
 *
 *   - 没有「物品」，「到期时间」是给谁到期的就不知道了
 *   - 没有「到期时间」，这张表就退化成一个普通清单，
 *     而这套东西存在的理由就是"快过期时主动告诉你"
 *
 * 所以这两列在 `lock` 上标死，解析配置时**永远补回来**：
 * 就算配置文件被手改成 `[]`，或者以后有人加了个"全不选"的按钮，
 * 结果里这两列照样在。约束放在解析函数里，不靠界面自觉。
 *
 * ── 「剩余时间」为什么不是一列 ──
 *
 * 它是**算出来的**（`到期日 - 今天`），不是存下来的。所以：
 *   - 不单独配置，它随「到期时间」一起出现
 *   - 会自己过期：今天看是"剩 7 个月"，明天就是"剩 6 个月 29 天"
 *   - 刷新时机：零点、打开程序、改了到期时间（见 main 进程的 date:changed 广播）
 *
 * 如果把它做成独立的列开关，就会出现"开着剩余时间却关掉了到期日"这种
 * 说不通的状态；把它绑在到期日上，这类状态根本不存在。
 *
 * ── 生效范围 ──
 *
 * 物品页、分组页、概览页的「最先到期」—— 这三处是同一份物品清单。
 * 概览页的「待补货」表**不**跟随：它只有 5 列且与到期无关，
 * 硬套一套跟它没关系的配置反而奇怪。
 */
import type { Row } from './db';
import { categoryLabel, UNCATEGORIZED_LABEL } from './ordering';

/** 一列的键。用字面量联合，写错会在编译期就报出来 */
export type ColumnKey =
  | 'name'
  | 'category'
  | 'brand'
  | 'model'
  | 'location'
  | 'quantity'
  | 'purchased'
  | 'expiry'
  | 'spec'
  | 'notes';

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** 表头提示 */
  hint: string;
  /**
   * 锁定：**永远显示，不可关闭**。
   * 解析配置时会被无条件补回，界面上的勾选框是禁用状态。
   */
  lock?: boolean;
  /** 默认是否显示 */
  defaultOn: boolean;
  /** 渲染时是否靠右（数字类） */
  align?: 'right';
  /**
   * 点这个列头时按哪个排序字段排（`SortField`）。
   *
   * 单独一个字段而不是直接用 `key`：列名和排序字段大部分同名，
   * 但有两处对不上 ——
   *   - 列 `expiry`（界面叫「到期时间」）实际要按**最紧迫的那条到期来源**排，
   *     排序字段是 `expiry`，语义比列名窄；
   *   - 列 `purchased` 的排序语义是「入库日期」，与列名同义但名字不同。
   * 显式写出来，比在渲染层里维护一张"列 → 字段"的映射表更难漂移：
   * 那张表加列时会忘（"内部标识生成"就是这么在三个文件里各写了一份的）。
   *
   * 不写 = 这一列不可排序（渲染层就不画箭头）。
   */
  sortKey?: string;
}

/**
 * 物品表的列，顺序就是显示顺序。
 *
 * ── 哪些列「默认关」 ──
 *
 * `room` / `container` / `spec` / `notes` 默认关着，但**仍然可以手动打开**。
 * 它们的信息量不小（位置一列能占掉 20 个字宽），可大多数时候你只想扫一眼
 * "什么东西、什么时候过期"。所以默认收进展开区（见 `extra` 列），
 * 真想拿它们当列用的人可以在列设置里打开 —— 只是不再默认占位。
 *
 * 刻意不包含：行首的展开箭头、拖动时的序号手柄、行尾的操作按钮。
 * 那些是**表格的机能**而不是"字段"，关掉表格就没法用了，所以不能配。
 */
export const ITEM_COLUMNS: ColumnDef[] = [
  {
    key: 'name',
    label: '物品',
    hint: '物品名称。必须显示 —— 否则不知道到期的是什么东西',
    lock: true,
    defaultOn: true,
    sortKey: 'name',
  },
  {
    key: 'expiry',
    label: '到期时间',
    hint: '到期日 + 剩余时间（自动计算，会随日期自己刷新）。必须显示',
    lock: true,
    defaultOn: true,
    sortKey: 'expiry',
  },
  {
    key: 'category',
    label: '分类',
    hint: '所属分类，未分类显示为「未分类」',
    defaultOn: true,
    sortKey: 'category',
  },
  { key: 'brand', label: '品牌', hint: '选填字段', defaultOn: true, sortKey: 'brand' },
  { key: 'model', label: '型号', hint: '选填字段，与规格不同', defaultOn: true, sortKey: 'model' },
  {
    key: 'quantity',
    label: '数量',
    hint: '批量物品显示「剩余/总数」',
    defaultOn: true,
    align: 'right',
    sortKey: 'quantity',
  },
  {
    key: 'purchased',
    label: '入库',
    hint: '这件东西从什么时候开始算：生产日期 / 购入时间 / 签发日期都填这里',
    defaultOn: true,
    sortKey: 'purchased',
  },
  {
    key: 'location',
    label: '位置',
    hint: '如 客厅药箱-上层。默认收在展开区里 —— 打开这列会明显占宽度',
    defaultOn: false,
    sortKey: 'location',
  },
  {
    key: 'spec',
    label: '规格',
    hint: '选填字段。默认收在展开区里',
    defaultOn: false,
    sortKey: 'spec',
  },
  {
    key: 'notes',
    label: '备注',
    hint: '默认收在展开区里。备注通常很长，当列显示会把表撑开',
    defaultOn: false,
    sortKey: 'notes',
  },
];

/**
 * 不占列、只在行首放一个箭头的控制器。
 *
 * 它不是"字段"而是"入口"，所以**不进 `ITEM_COLUMNS`**：
 * 一旦进去，用户就能把它关掉，然后永远看不到补充信息。
 */
export const EXTRA_COLUMN: { key: string; label: string; hint: string } = {
  key: 'extra',
  label: '补充信息',
  hint: '点开查看位置、规格、备注，以及这件东西额外的字段',
};

/**
 * 展开区里**固定展示**的字段：真实列名 → 显示名。
 *
 * 它们仍然是 items 里的真实字段（不是塞进 JSON 的），原因：
 *   - 位置要参与分组、规格要参与搜索、备注要参与导出
 *   - 变成 JSON 之后这些都要重写，而收益只有"少三列"
 *
 * 展开区只是它们统一的使用入口：默认不占列，点开就能看和改。
 */
export const EXTRA_REAL_FIELDS: { key: 'location' | 'spec' | 'notes'; label: string }[] = [
  { key: 'location', label: '位置' },
  { key: 'spec', label: '规格' },
  { key: 'notes', label: '备注' },
];

export const COLUMN_KEYS: ColumnKey[] = ITEM_COLUMNS.map((c) => c.key);

/** 不可关闭的列 */
export const LOCKED_COLUMNS: ColumnKey[] = ITEM_COLUMNS.filter((c) => c.lock).map((c) => c.key);

/** 默认显示的列 */
export const DEFAULT_COLUMNS: ColumnKey[] = ITEM_COLUMNS.filter((c) => c.defaultOn).map((c) => c.key);

export function columnDef(key: ColumnKey): ColumnDef {
  const d = ITEM_COLUMNS.find((c) => c.key === key);
  if (!d) throw new Error(`未知的列: ${key}`);
  return d;
}

export function isColumnKey(v: unknown): v is ColumnKey {
  return typeof v === 'string' && (COLUMN_KEYS as string[]).includes(v);
}

/**
 * 把一份（可能不完整、可能被手改坏的）配置解析成**可直接渲染的列清单**。
 *
 * 规则：
 *   1. 认不出来的键直接丢掉（旧版本留下的、手写错的）
 *   2. 去重
 *   3. 锁定列**无条件补回**，并回到 `ITEM_COLUMNS` 里的原始位置
 *   4. 非锁定列按 `ITEM_COLUMNS` 的顺序归一（保证列顺序稳定，不随用户勾选先后乱跳）
 *   5. 传 `null` / `undefined` / 空数组 → 回落到默认列
 *
 * 第 3 条是这个模块存在的意义：约束在数据层，不在界面层。
 */
export function resolveColumns(visible: unknown): ColumnKey[] {
  if (!Array.isArray(visible)) return [...DEFAULT_COLUMNS];

  const picked = new Set<ColumnKey>();
  for (const v of visible) {
    if (isColumnKey(v)) picked.add(v);
  }

  // 空数组当作"没配置过"，回落到默认 —— 否则用户会得到一个只有两列的表，
  // 而那不是他表达的意思（他大概率是把配置写坏了）
  if (picked.size === 0) return [...DEFAULT_COLUMNS];

  for (const key of LOCKED_COLUMNS) picked.add(key);

  // 按定义顺序输出，顺带完成去重
  return ITEM_COLUMNS.filter((c) => picked.has(c.key)).map((c) => c.key);
}

/** 解析结果里是否只剩锁定列（界面用来提示"你已经把能关的都关了"） */
export function isMinimal(visible: unknown): boolean {
  const cols = resolveColumns(visible);
  return cols.every((c) => LOCKED_COLUMNS.includes(c));
}

/**
 * 取某一列的值，统一成字符串。
 *
 * 放在 core 而不是渲染层，是为了让 CLI 的 `item list` 与界面走**同一份**取值逻辑 ——
 * 否则两边对"长期""未分类"的显示早晚会不一致。
 *
 * 空值一律返回空串，由渲染层决定显示成什么（界面用「—」，命令行用空白）。
 */
export function columnText(key: ColumnKey, row: Row): string {
  const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  switch (key) {
    case 'name':
      return s(row['name']);
    case 'category':
      return s(row['category']) === '' ? UNCATEGORIZED_LABEL : categoryLabel(s(row['category']));
    case 'brand':
      return s(row['brand']);
    case 'model':
      return s(row['model']);
    case 'location':
      // 位置现在只有一个自由文本字段（房间那一级取消了）
      return s(row['container']);
    case 'quantity':
      return s(row['remaining']);
    case 'purchased':
      return s(row['purchased_on']);
    case 'expiry':
      return s(row['expires_on']);
    case 'spec':
      return s(row['spec']);
    case 'notes':
      return s(row['notes']);
    default:
      return '';
  }
}

/** 分类 key → 中文；未分类给「未分类」。实现见 ordering.ts，这里只是转出去 */
export { categoryLabel };

/** 一列的宽度提示（渲染层用来防止「到期时间」被撑得过宽） */
export function columnWidthHint(key: ColumnKey): 'narrow' | 'normal' | 'wide' {
  switch (key) {
    case 'category':
    case 'brand':
    case 'model':
    case 'purchased':
      return 'narrow';
    case 'location':
    case 'notes':
      return 'wide';
    default:
      return 'normal';
  }
}
