/**
 * 批量物品的「一组库存」。
 *
 * ── 一句话 ──
 * 一件开启「批量」的物品，可以把数量拆成若干条**库存条目**，
 * 每条自带数量和到期日。不拆就是普通的一条（一个数量 + 一个到期日）。
 *
 * ── 为什么用子行而不是新表 ──
 * 库存条目就是 `items` 表里 `parent_uuid` 指向父项的那些行。这样：
 *   - 归档格式仍然只有 items + stock_moves 两张表，往返不变式不用改
 *   - 界面上的嵌套列就是天然的父子关系，不需要额外查询
 *   - 库存条目自己也能有购买日期、价格、渠道，语义上本来就是「一次买入」
 *
 * ── 父项的三个数字怎么来 ──
 * 有子行时，父项的 quantity / remaining / expires_on **全部由子行汇总**：
 *   quantity   = Σ 子行 quantity
 *   remaining  = Σ 子行 remaining
 *   expires_on = 子行里最早的非空到期日（用于列表排序与时间轴定位）
 * 没有子行时，父项自己那三个字段就是全部。
 *
 * ── 消耗顺序 ──
 * 先到期先出（FEFO）。这也是家里翻药箱的真实做法。
 */
import { insertRow, updateRow, deleteRow, selectWhere, selectOne, type Row } from './db';
import { centsToYuan } from './values';
import { daysUntil } from './dates';

type Db = Parameters<typeof selectWhere>[0];

/** 一个库存条目的对外形态 */
export interface BulkStock {
  uuid: string;
  /** 第几组，从 1 开始 */
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

export interface BulkTotals {
  quantity: number;
  remaining: number;
  /** 所有子行里最早的到期日；全都没有则为 null */
  expiresOn: string | null;
}

/** 排序用：没有到期日的排在最后 */
const FAR_FUTURE = '9999-12-31';

function sortByExpiry(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ae = a['expires_on'] ? String(a['expires_on']) : FAR_FUTURE;
    const be = b['expires_on'] ? String(b['expires_on']) : FAR_FUTURE;
    const byDate = ae.localeCompare(be);
    if (byDate !== 0) return byDate;
    return String(a['created_at'] ?? '').localeCompare(String(b['created_at'] ?? ''));
  });
}

/** 取某个物品的全部库存条目（未排序） */
export function stocksOf(db: Db, parentUuid: string): Row[] {
  return selectWhere(db, 'items', 'parent_uuid = ?', [parentUuid]);
}

/** 某个物品是否用了嵌套库存 */
export function hasStocks(db: Db, parentUuid: string): boolean {
  const row = db.prepare('SELECT 1 AS x FROM items WHERE parent_uuid = ? LIMIT 1').get(parentUuid);
  return Boolean(row);
}

/** 库存条目数（列表页用来决定要不要显示可展开的箭头） */
export function stockCounts(db: Db): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT parent_uuid, COUNT(*) AS n FROM items
       WHERE parent_uuid IS NOT NULL AND parent_uuid <> '' GROUP BY parent_uuid`,
    )
    .all() as { parent_uuid: string; n: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.parent_uuid), Number(r.n));
  return map;
}

/** 把库存条目整理成对外形态，并算出汇总 */
export function toBulkStocks(
  rows: Row[],
  now: Date = new Date(),
): { stocks: BulkStock[]; totals: BulkTotals } {
  const sorted = sortByExpiry(rows);

  let quantity = 0;
  let remaining = 0;
  let earliest: string | null = null;

  const stocks: BulkStock[] = sorted.map((r, i) => {
    const q = Number(r['quantity'] ?? 0);
    const rem = Number(r['remaining'] ?? 0);
    quantity += q;
    remaining += rem;

    const expiresOn = r['expires_on'] ? String(r['expires_on']) : null;
    // 父项的到期日只由**还有剩余**的组决定：
    // 一组已经用光的东西再报「快到期了」就是噪音。
    if (expiresOn && rem > 0 && (!earliest || expiresOn < earliest)) earliest = expiresOn;

    const daysLeft = expiresOn ? daysUntil(expiresOn, now) : null;
    return {
      uuid: String(r['uuid']),
      index: i + 1,
      quantity: q,
      remaining: rem,
      purchasedOn: r['purchased_on'] ? String(r['purchased_on']) : '',
      expiresOn,
      unitPriceYuan: centsToYuan(r['unit_price_cents'] as string | null),
      amountYuan: centsToYuan(r['amount_cents'] as string | null),
      store: r['store'] ? String(r['store']) : '',
      notes: r['notes'] ? String(r['notes']) : '',
      expired: daysLeft !== null && daysLeft < 0,
      daysLeft,
    };
  });

  return { stocks, totals: { quantity, remaining, expiresOn: earliest } };
}

/**
 * 用子行汇总刷新父项的数量与最早到期日。
 *
 * 父项的 expires_on 取子行里最早的那个 —— 这样列表排序、时间轴定位、
 * 「有没有过期」都不需要为父子关系写特例。
 */
export function refreshParentTotals(db: Db, parentUuid: string): void {
  const rows = stocksOf(db, parentUuid);
  if (rows.length === 0) return;

  const { totals } = toBulkStocks(rows);
  const allDone = totals.remaining <= 0;

  updateRow(db, 'items', parentUuid, {
    quantity: String(totals.quantity),
    remaining: String(totals.remaining),
    expires_on: totals.expiresOn,
    expires_ym: null,
    status: allDone ? 'consumed' : 'in_use',
  });
}

/**
 * 按 FEFO 从库存条目里扣减，返回实际的扣减分布。
 *
 * 数量不够时扣到 0 为止不报错 —— 「够不够」由调用方先判断。
 */
export function consumeFromStocks(db: Db, parentUuid: string, qty: number): { uuid: string; taken: number }[] {
  const taken: { uuid: string; taken: number }[] = [];
  let left = qty;

  for (const row of sortByExpiry(stocksOf(db, parentUuid))) {
    if (left <= 0) break;
    const rem = Number(row['remaining'] ?? 0);
    if (rem <= 0) continue;

    const take = Math.min(rem, left);
    const next = rem - take;
    updateRow(db, 'items', String(row['uuid']), {
      remaining: String(next),
      status: next === 0 ? 'consumed' : 'in_use',
    });
    taken.push({ uuid: String(row['uuid']), taken: take });
    left -= take;
  }

  return taken;
}

/** 分类前缀，给库存条目生成内部标识用 */
const CODE_PREFIX: Record<string, string> = {
  medicine: 'MED',
  supplement: 'SUP',
  daily: 'DAY',
  digital: 'DIG',
  food: 'FOO',
  cosmetic: 'COS',
  medical_device: 'DEV',
  document: 'DOC',
  other: 'GEN',
};

/**
 * 给库存条目生成一个内部标识。
 *
 * 编号在界面上已经取消，但它是 NOT NULL 的唯一列，而且命令行要靠它定位，
 * 所以子行也得有一个。格式是「父项标识-序号」，一眼能看出从属关系。
 */
function stockCode(db: Db, parent: Row): string {
  const parentCode = parent['code'] ? String(parent['code']) : null;
  const prefix = CODE_PREFIX[String(parent['category'] ?? 'other')] ?? 'GEN';

  for (let i = 1; i < 1000; i += 1) {
    const candidate = parentCode ? `${parentCode}-S${i}` : `${prefix}-S${i}`;
    const exists = db.prepare('SELECT 1 AS x FROM items WHERE code = ?').get(candidate);
    if (!exists) return candidate;
  }
  // 理论上到不了这里；真到了就用时间戳兜底，宁可难看也不能插入失败
  return `${prefix}-S${Date.now()}`;
}

/** 新增一条库存条目 */
export function addStock(db: Db, parent: Row, values: Record<string, string | null>): Row {
  const parentUuid = String(parent['uuid']);
  const quantity = values['quantity'] ?? '1';

  const row = insertRow(db, 'items', {
    // 子行继承父项的名称与分类，方便单独查询时也看得懂
    name: String(parent['name'] ?? ''),
    category: String(parent['category'] ?? 'other'),
    unit: parent['unit'] === null || parent['unit'] === undefined ? null : String(parent['unit']),
    container: parent['container'] === null || parent['container'] === undefined ? null : String(parent['container']),
    ...values,
    code: stockCode(db, parent),
    parent_uuid: parentUuid,
    is_bulk: 'false', // 子行自己不是批量物品，它就是一个数量段
    quantity,
    remaining: values['remaining'] ?? quantity,
  });

  refreshParentTotals(db, parentUuid);
  return row;
}

/** 删除一条库存条目，并刷新父项汇总 */
export function removeStock(db: Db, stockUuid: string): boolean {
  const row = selectOne(db, 'items', 'uuid = ?', [stockUuid], { includeInternal: true });
  if (!row) return false;
  const parentUuid = row['parent_uuid'] ? String(row['parent_uuid']) : '';
  const ok = deleteRow(db, 'items', stockUuid);
  if (ok && parentUuid) refreshParentTotals(db, parentUuid);
  return ok;
}
