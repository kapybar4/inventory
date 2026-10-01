/**
 * 分组、排序、拖动固定顺序。
 *
 * ── 三条互相独立的规则 ──
 *
 * 1. **分组**：按「分类 → 子类 → 标签」最多三层。一级分组默认开着且不能关。
 * 2. **排序**：默认关闭。关着时按 `sort_order`（用户拖动固定下来的顺序）排；
 *    开着时按选定字段排，并且**拖动被禁用** —— 否则拖完立刻被排序覆盖，看着像坏了。
 * 3. **分组顺序**：每个父级下各有一份顺序表，拖动了就存下来。
 *
 * 关键约束（来自需求）：
 *   - 排序**只影响组内物品的顺序**，不影响分组本身，也不影响组之间的顺序
 *   - 「未分类」组**永远置顶且不可拖动** —— 它是给用户的提示，不是给他整理的
 *
 * ── 为什么顺序表按「路径」存 ──
 * 三级分组下「药品 > 感冒药 > 常备」和「日用品 > 清洁 > 常备」是两个不同的组，
 * 但它们都可能叫「常备」。所以键必须是完整路径而不是组名。
 */
import type { Row } from './db';
import { ENUMS } from './fields';
import { SOON_DAYS, expiriesForItem } from './alerts';

/** 分类留空 = 未分类 */
export const UNCATEGORIZED = '';
/** 「未分类」组的显示名 */
export const UNCATEGORIZED_LABEL = '未分类';

/** 没有子类 / 没有标签时落到哪一组 */
export const NO_SUBCATEGORY = '';
export const NO_TAG = '';

// ─────────────────────────────────────────────────────────────
// 排序
// ─────────────────────────────────────────────────────────────

export type SortField =
  | 'manual'
  | 'expiry'
  | 'name'
  | 'purchased'
  | 'quantity'
  | 'remaining'
  | 'location'
  | 'price'
  | 'created';

export interface SortFieldDef {
  key: SortField;
  label: string;
  /** 排序方向：升序让「最先到期」在最上面，数量则让「剩得最多」在最上面 */
  desc: boolean;
  hint: string;
}

export const SORT_FIELDS: SortFieldDef[] = [
  { key: 'manual', label: '手动顺序', desc: false, hint: '按你拖动固定下来的顺序' },
  { key: 'expiry', label: '到期时间', desc: false, hint: '最先到期的排最前，长期在最后' },
  { key: 'name', label: '名称', desc: false, hint: '按拼音/笔画排' },
  { key: 'purchased', label: '购买日期', desc: true, hint: '最近买的排最前' },
  { key: 'quantity', label: '数量', desc: true, hint: '数量多的排最前' },
  { key: 'remaining', label: '剩余', desc: true, hint: '剩得多的排最前' },
  { key: 'location', label: '位置', desc: false, hint: '按房间 + 柜格排' },
  { key: 'price', label: '价格', desc: true, hint: '贵的排最前' },
  { key: 'created', label: '添加时间', desc: true, hint: '最近添加的排最前' },
];

export function sortFieldDef(field: SortField): SortFieldDef {
  return SORT_FIELDS.find((f) => f.key === field) ?? SORT_FIELDS[0]!;
}

/** 没有到期日的物品排在所有有到期日之后 */
const FAR_FUTURE = '9999-12-31';

/** 按选定字段给组内物品排序（纯函数，不改原数组） */
export function sortItems(items: Row[], field: SortField): Row[] {
  if (field === 'manual') return [...items].sort(byManual);

  const def = sortFieldDef(field);
  const sign = def.desc ? -1 : 1;

  const key = (r: Row): string | number => {
    switch (field) {
      case 'expiry':
        return r['expires_on'] ? String(r['expires_on']) : FAR_FUTURE;
      case 'name':
        return String(r['name'] ?? '');
      case 'purchased':
        return r['purchased_on'] ? String(r['purchased_on']) : '';
      case 'quantity':
        return Number(r['quantity'] ?? 0);
      case 'remaining':
        return Number(r['remaining'] ?? 0);
      case 'location':
        return [r['room'], r['container']].filter(Boolean).join(' / ');
      case 'price':
        return Number(r['unit_price_cents'] ?? 0);
      case 'created':
        return String(r['created_at'] ?? '');
      default:
        return '';
    }
  };

  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    let d: number;
    if (typeof ka === 'number' && typeof kb === 'number') d = ka - kb;
    else d = String(ka).localeCompare(String(kb), 'zh');
    if (d !== 0) return d * sign;
    // 同值时用手动顺序兜底，保证结果稳定、不会每次刷新都换位置
    return byManual(a, b);
  });
}

function byManual(a: Row, b: Row): number {
  const sa = Number(a['sort_order'] ?? 0);
  const sb = Number(b['sort_order'] ?? 0);
  if (sa !== sb) return sa - sb;
  return String(a['uuid'] ?? '').localeCompare(String(b['uuid'] ?? ''));
}

// ─────────────────────────────────────────────────────────────
// 分组树
// ─────────────────────────────────────────────────────────────

export interface GroupNode {
  /** 这一级的原始 key（'' = 未分类 / 无子类 / 无标签） */
  key: string;
  /** 显示名 */
  label: string;
  /** 完整路径，用来定位一份顺序表 */
  path: string[];
  /** 1 = 分类，2 = 子类，3 = 标签 */
  level: number;
  /** 直接挂在这一组下的物品（叶子组才有） */
  items: Row[];
  children: GroupNode[];
  /** 这棵子树里的物品总数 */
  count: number;
  /** 未分类组：置顶且不可拖动 */
  pinned: boolean;
  /** 这一组的到期统计，用来在标题上标一下 */
  expired: number;
  soon: number;
  longTerm: number;
  /**
   * 只有「质保期」到期的物品数。
   *
   * 单独一栏而不是并进 `expired`：过保的东西还能用，跟"不能吃了"不是一回事。
   * 它**不进顶部高亮**，只在组标题上标一下。
   */
  warranty: number;
}

export interface GroupTree {
  nodes: GroupNode[];
  /** 实际用到的最大层级（1~3） */
  maxLevel: number;
  total: number;
}

/** 分类的中文名；空值给「未分类」 */
export function categoryLabel(key: string): string {
  if (key === UNCATEGORIZED) return UNCATEGORIZED_LABEL;
  return ENUMS['item_category']?.find((e) => e.key === key)?.label ?? key;
}

/** 分类在界面上的固定顺序，保证没拖动过的组位置稳定 */
const CATEGORY_ORDER: string[] = (ENUMS['item_category'] ?? []).map((e) => e.key);

/** 从物品行里取第 n 级的 key */
function keyAt(item: Row, level: number): string {
  if (level === 1) {
    const c = item['category'] === null || item['category'] === undefined ? '' : String(item['category']);
    return c;
  }
  if (level === 2) {
    return item['subcategory'] === null || item['subcategory'] === undefined
      ? ''
      : String(item['subcategory']).trim();
  }
  // 三级：标签。tags 是逗号分隔的多值，所以下面要走特殊分支
  return '';
}

/** 一个物品在某一级上的全部 key（标签是一对多） */
function keysAt(item: Row, level: number): string[] {
  if (level !== 3) return [keyAt(item, level)];

  const raw = item['tags'];
  if (raw === null || raw === undefined) return [NO_TAG];
  const parts = String(raw)
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? [...new Set(parts)] : [NO_TAG];
}

function labelFor(level: number, key: string): string {
  if (level === 1) return categoryLabel(key);
  if (level === 2) return key === NO_SUBCATEGORY ? '未分子类' : key;
  return key === NO_TAG ? '无标签' : key;
}

/** 组在一级里的排序权重：未分类永远 0（最前），其余按枚举顺序，未知的排最后 */
function firstLevelRank(key: string): number {
  if (key === UNCATEGORIZED) return -1;
  const i = CATEGORY_ORDER.indexOf(key);
  return i < 0 ? 999 : i;
}

export interface GroupOptions {
  /** 展开到第几级，1~3 */
  levels: number;
  /** 排序字段；'manual' 表示手动顺序 */
  sort: SortField;
  /** 每个父路径下的自定义组顺序：path.join('\u0001') → 有序 key 列表 */
  order: Record<string, string[]>;
  /**
   * 以哪一天为「今天」算过期 / 快到期。
   *
   * 可注入是为了让测试不依赖真实时钟 —— 否则那些用固定日期的用例
   * 过一段时间就会自己变红，而且很难看出是"测试过期了"还是"代码坏了"。
   */
  now?: Date;
}

/**
 * 建树。
 *
 * 组的排序规则（优先级从高到低）：
 *   1. 未分类永远最前
 *   2. 用户拖动固定下来的顺序
 *   3. 枚举定义的固定顺序（没拖过时位置稳定）
 */
export function buildTree(items: Row[], opts: GroupOptions): GroupTree {
  const levels = Math.max(1, Math.min(3, opts.levels));
  const now = opts.now ?? new Date();

  interface Draft {
    key: string;
    label: string;
    path: string[];
    level: number;
    items: Row[];
    children: Map<string, Draft>;
    pinned: boolean;
  }

  const roots = new Map<string, Draft>();
  let maxLevel = 1;

  const makeDraft = (key: string, path: string[], level: number): Draft => ({
    key,
    label: labelFor(level, key),
    path,
    level,
    items: [],
    children: new Map(),
    pinned: level === 1 && key === UNCATEGORIZED,
  });

  for (const item of items) {
    // 一级：一定有一个 key（可能是空 = 未分类）
    const l1 = keysAt(item, 1);
    for (const k1 of l1) {
      let d1 = roots.get(k1);
      if (!d1) {
        d1 = makeDraft(k1, [k1], 1);
        roots.set(k1, d1);
      }

      // 二级、三级逐层展开；每一层都可能因为「一对多」（标签）而岔开
      let leaves: Draft[] = [d1];
      for (let lv = 2; lv <= levels; lv += 1) {
        const next: Draft[] = [];
        for (const parent of leaves) {
          for (const k of keysAt(item, lv)) {
            let child = parent.children.get(k);
            if (!child) {
              child = makeDraft(k, [...parent.path, k], lv);
              parent.children.set(k, child);
            }
            next.push(child);
          }
        }
        leaves = next;
        maxLevel = Math.max(maxLevel, lv);
      }

      for (const leaf of leaves) leaf.items.push(item);
    }
  }

  /** 递归收尾：排序、算计数、算到期统计 */
  const finalize = (draft: Draft, pathKey: string): GroupNode => {
    const order = opts.order[pathKey];
    const childKeys = [...draft.children.keys()];

    const rank = (k: string): number => {
      if (draft.level === 1 && k === UNCATEGORIZED) return -1;
      if (order) {
        const i = order.indexOf(k);
        if (i >= 0) return i;
      }
      if (draft.level === 1) return firstLevelRank(k);
      return 9999;
    };

    childKeys.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return labelFor(draft.level + 1, a).localeCompare(labelFor(draft.level + 1, b), 'zh');
    });

    const children = childKeys.map((k) =>
      finalize(draft.children.get(k)!, `${pathKey}\u0001${k}`),
    );

    // 叶子组才有直接物品；有子节点时物品都在子树里
    const ownItems = draft.children.size > 0 ? [] : sortItems(draft.items, opts.sort);

    let count = ownItems.length;
    let expired = 0;
    let soon = 0;
    let longTerm = 0;
    let warranty = 0;

    /**
     * 数一件物品属于哪一档。
     *
     * 只看「过期」那类来源（保质期 / 开封后有效期）：
     * 质保期到了算**过保**，单独数，不进 expired / soon。
     * 一件东西可能既有保质期又有质保期，取最坏的那条决定它算不算过期。
     */
    const tally = (r: Row): void => {
      const all = expiriesForItem(r, now);
      if (all.length === 0) {
        longTerm += 1;
        return;
      }
      // 有到期日但全是质保期 → 它在分组树里不算「长期」（确实有日期要记），
      // 也不进 alert 计数
      const expiring = all.filter((e) => e.alertKind === 'expire');
      if (expiring.length === 0) {
        warranty += 1;
        return;
      }
      if (expiring.some((e) => e.expired)) expired += 1;
      else if (expiring.some((e) => e.daysLeft <= SOON_DAYS)) soon += 1;
    };

    for (const r of ownItems) tally(r);
    for (const c of children) {
      count += c.count;
      expired += c.expired;
      soon += c.soon;
      longTerm += c.longTerm;
      warranty += c.warranty;
    }

    return {
      key: draft.key,
      label: draft.label,
      path: draft.path,
      level: draft.level,
      items: ownItems,
      children,
      count,
      pinned: draft.pinned,
      expired,
      soon,
      longTerm,
      warranty,
    };
  };

  const nodes = [...roots.keys()]
    .sort((a, b) => {
      // 一级：未分类永远置顶，然后看自定义顺序，最后看枚举顺序
      const ra = (() => {
        if (a === UNCATEGORIZED) return -1;
        const o = opts.order[''];
        if (o) {
          const i = o.indexOf(a);
          if (i >= 0) return i;
        }
        return firstLevelRank(a);
      })();
      const rb = (() => {
        if (b === UNCATEGORIZED) return -1;
        const o = opts.order[''];
        if (o) {
          const i = o.indexOf(b);
          if (i >= 0) return i;
        }
        return firstLevelRank(b);
      })();
      if (ra !== rb) return ra - rb;
      return categoryLabel(a).localeCompare(categoryLabel(b), 'zh');
    })
    .map((k) => finalize(roots.get(k)!, k));

  return { nodes, maxLevel, total: items.length };
}

/**
 * 把一棵子树里的物品按「组内顺序」拍平。
 * 用在需要一份有序清单的地方（概览页「最先到期的」、命令行输出）。
 */
export function flattenItems(nodes: GroupNode[]): Row[] {
  const out: Row[] = [];
  const walk = (ns: GroupNode[]): void => {
    for (const n of ns) {
      out.push(...n.items);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 未分类物品的数量（界面顶部提示用） */
export function uncategorizedCount(items: Row[]): number {
  return items.filter((r) => {
    const c = r['category'];
    return c === null || c === undefined || String(c) === '';
  }).length;
}
