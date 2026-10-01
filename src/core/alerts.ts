/**
 * 到期计算与分组排序。
 *
 * 这是整个系统存在的理由：把「快到期的」主动推到眼前。
 *
 * ── v3 的两个变化 ──
 *
 * 1. **取消分级**：不再有「紧急 / 临期 / 关注 / 待补货」这套档位。
 *    实测下来，分档的边界（21 天算紧急还是临期）对用户没有意义，
 *    真正有用的信息只有两条：**过没过期**、**还剩多少天**。
 *    所以现在只标记「已过期」，其余按到期时间排序，让顺序本身表达紧迫度。
 *
 * 2. **改为分组**：默认按分类分组，组内按到期日升序。
 *    没有到期日的「长期」物品排在每组最后 —— 它们不需要关注。
 *
 * 到期来源仍然是三类（保质期 / 质保期 / 开封后有效期），各自单独成条：
 * 同一件东西既可能「保质期还剩很久」又「开封后已过期」，后者才是要处理的。
 */
import { openDatabase, listActiveItems, type Row } from './db';
import type { WorkspaceEntry } from './workspace';
import { ENUMS, CATEGORY_LEAD_DAYS } from './fields';
import { formatDaysLeft, daysUntil, today, addDays } from './dates';

/** 一件物品的某个到期来源 */
export interface ExpiryEntry {
  item: Row;
  /** 保质期 / 质保期 / 开封后有效期 */
  kind: string;
  expiresOn: string;
  daysLeft: number;
  daysLeftText: string;
  expired: boolean;
}

/** 没有到期日、不需要关注的物品 */
export interface LongTermEntry {
  item: Row;
  /** 哪个来源把它归为长期；通常就是「保质期」留空 */
  kind: string;
}

export interface CategoryGroup {
  /** 分类 key */
  key: string;
  /** 分类中文名 */
  label: string;
  /** 该组内按到期日升序的条目 */
  entries: ExpiryEntry[];
  /** 该组内长期有效的物品 */
  longTerm: LongTermEntry[];
  counts: { total: number; expired: number; items: number };
}

export interface OverviewSummary {
  workspaceId: string;
  workspaceName: string;
  generatedAt: string;
  today: string;
  groups: CategoryGroup[];
  counts: {
    /** 全部在用的物品数 */
    items: number;
    /** 有到期日的条目数 */
    dated: number;
    expired: number;
    /** 30 天内到期（不含已过期） */
    soon: number;
    longTerm: number;
    /** 低于最低库存的批量物品数 */
    lowStock: number;
  };
  headline: string;
}

/** 所有到期来源。返回的 expiresOn 一律是确定的日期。 */
export function expirySources(item: Row): { expiresOn: string; kind: string }[] {
  const out: { expiresOn: string; kind: string }[] = [];

  const expiresOn = item['expires_on'] ? String(item['expires_on']) : '';
  if (expiresOn) out.push({ expiresOn, kind: '保质期' });

  const warranty = item['warranty_until'] ? String(item['warranty_until']) : '';
  if (warranty) out.push({ expiresOn: warranty, kind: '质保期' });

  const shelf = item['open_shelf_life_days'];
  const openedOn = item['opened_on'] ? String(item['opened_on']) : '';
  if (shelf && openedOn) {
    const days = Number(shelf);
    const derived = addDays(openedOn, days);
    if (derived) out.push({ expiresOn: derived, kind: '开封后有效期' });
  }

  return out;
}

/** 是不是「长期」——即完全没有到期日的物品 */
export function isLongTerm(item: Row): boolean {
  return expirySources(item).length === 0;
}

/**
 * 一件物品的全部到期条目。
 * 已达标的批量物品如果配了多组库存，由调用方先把库存展开成多条传入。
 */
export function expiriesForItem(item: Row, now: Date = new Date()): ExpiryEntry[] {
  return expirySources(item).map((src) => {
    const daysLeft = daysUntil(src.expiresOn, now) ?? 0;
    return {
      item,
      kind: src.kind,
      expiresOn: src.expiresOn,
      daysLeft,
      daysLeftText: formatDaysLeft(daysLeft),
      expired: daysLeft < 0,
    };
  });
}

/** 分类的中文名 */
export function categoryLabel(key: string): string {
  return ENUMS['item_category']?.find((e) => e.key === key)?.label ?? key;
}

/** 某个分类的提前提醒天数。仍然有用：给命令行和「还有多久要留意」当参考。 */
export function leadDaysFor(item: Row): number {
  const category = String(item['category'] ?? 'other');
  return CATEGORY_LEAD_DAYS[category] ?? CATEGORY_LEAD_DAYS['other'] ?? 45;
}

/** 分类在界面上的固定顺序，保证分组列表不会每次刷新都换位置 */
const CATEGORY_ORDER: string[] = (ENUMS['item_category'] ?? []).map((e) => e.key);

/**
 * 分组 + 排序。
 *
 * 分组键是分类；组内按到期日升序，长期物品沉到组尾。
 * 组之间按 enum 定义顺序排，而不是按数量 —— 位置稳定才能形成肌肉记忆。
 */
export function groupByCategory(items: Row[], now: Date = new Date()): CategoryGroup[] {
  const byKey = new Map<string, CategoryGroup>();

  for (const item of items) {
    const remaining = Number(item['remaining'] ?? 0);
    if (remaining <= 0) continue;

    const key = String(item['category'] ?? 'other');
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: categoryLabel(key),
        entries: [],
        longTerm: [],
        counts: { total: 0, expired: 0, items: 0 },
      };
      byKey.set(key, group);
    }
    group.counts.items += 1;

    const expiries = expiriesForItem(item, now);
    if (expiries.length === 0) {
      group.longTerm.push({ item, kind: '长期' });
      continue;
    }
    for (const e of expiries) {
      group.entries.push(e);
      group.counts.total += 1;
      if (e.expired) group.counts.expired += 1;
    }
  }

  for (const group of byKey.values()) {
    group.entries.sort((a, b) => {
      const byDate = a.expiresOn.localeCompare(b.expiresOn);
      if (byDate !== 0) return byDate;
      return String(a.item['name'] ?? '').localeCompare(String(b.item['name'] ?? ''), 'zh');
    });
    group.longTerm.sort((a, b) =>
      String(a.item['name'] ?? '').localeCompare(String(b.item['name'] ?? ''), 'zh'),
    );
  }

  const groups = [...byKey.values()];
  groups.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.key);
    const bi = CATEGORY_ORDER.indexOf(b.key);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  return groups;
}

/** 低于最低库存的批量物品 */
export function lowStockItems(items: Row[]): { item: Row; remaining: number; minStock: number; shortfall: number }[] {
  const out: { item: Row; remaining: number; minStock: number; shortfall: number }[] = [];
  for (const item of items) {
    const minStock = Number(item['min_stock'] ?? 0);
    if (minStock <= 0) continue;
    const remaining = Number(item['remaining'] ?? 0);
    if (remaining < minStock) out.push({ item, remaining, minStock, shortfall: minStock - remaining });
  }
  out.sort((a, b) => b.shortfall - a.shortfall);
  return out;
}

/** 从一批物品行算出完整概览（纯函数，不碰数据库） */
export function summarizeOverview(
  items: Row[],
  entry: { id: string; name: string },
  now: Date = new Date(),
): OverviewSummary {
  const groups = groupByCategory(items, now);

  let expired = 0;
  let dated = 0;
  let soon = 0;
  let longTerm = 0;
  let itemCount = 0;

  for (const g of groups) {
    itemCount += g.counts.items;
    expired += g.counts.expired;
    dated += g.counts.total;
    longTerm += g.longTerm.length;
    for (const e of g.entries) {
      if (!e.expired && e.daysLeft <= 30) soon += 1;
    }
  }

  const lowStock = lowStockItems(items).length;

  const counts = { items: itemCount, dated, expired, soon, longTerm, lowStock };

  const parts: string[] = [];
  if (expired) parts.push(`${expired} 项已过期`);
  if (soon) parts.push(`${soon} 项 30 天内到期`);
  if (lowStock) parts.push(`${lowStock} 项待补货`);
  const headline = parts.length ? parts.join(' · ') : `${itemCount} 项在用，没有需要马上处理的`;

  return {
    workspaceId: entry.id,
    workspaceName: entry.name,
    generatedAt: now.toISOString(),
    today: today(now),
    groups,
    counts,
    headline,
  };
}

export function computeOverview(entry: WorkspaceEntry, dbPath: string, now: Date = new Date()): OverviewSummary {
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    return summarizeOverview(listActiveItems(db), entry, now);
  } finally {
    db.close();
  }
}

/** 「N 天内到期」的通用查询 */
export function expiringWithin(
  dbPath: string,
  withinDays: number,
  now: Date = new Date(),
): { item: Row; expiresOn: string; kind: string; daysLeft: number | null }[] {
  const db = openDatabase(dbPath, { readOnly: true });
  try {
    const out: { item: Row; expiresOn: string; kind: string; daysLeft: number | null }[] = [];
    for (const item of listActiveItems(db)) {
      for (const src of expirySources(item)) {
        const left = daysUntil(src.expiresOn, now);
        if (left === null) continue;
        if (left <= withinDays) out.push({ item, expiresOn: src.expiresOn, kind: src.kind, daysLeft: left });
      }
    }
    out.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    return out;
  } finally {
    db.close();
  }
}
