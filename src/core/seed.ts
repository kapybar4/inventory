/**
 * 演示 / 引导数据。
 *
 * 刻意覆盖各种边界情况，方便一眼看出分组与排序是否算对：
 *   - 已过期、30 天内到期、长期 三种状态都有
 *   - 只到月份的到期日（折算成当月最后一天）
 *   - 质保期（数码设备）、开封后有效期（眼药水 / 奶粉）
 *   - **一组库存**：批量物品拆成多条「数量 + 到期日」
 *   - 低于最低库存的待补货项
 *   - **同一种东西买两次 = 两条独立记录**（v2 取消了批次）
 *   - 长期物品：护照、移动电源这类不需要关注到期的东西
 */
import { openDatabase, insertRow, transaction, countRows } from './db';
import { addDays, addMonths, monthEnd, today } from './dates';
import { workspaceDbPath, type WorkspaceEntry } from './workspace';

/** 一次「买入」：v3 里它直接是一条物品记录，或者是批量物品的一条库存条目 */
interface SeedPurchase {
  /** 这一条是否开启「批量」（需要按个数管理） */
  bulk?: boolean;
  quantity: number;
  remaining?: number;
  /** 相对今天的天数，负数表示已过期 */
  expiresInDays?: number;
  /** 只到月份时用这个（相对今天的月数），会折算成当月最后一天 */
  expiresInMonths?: number;
  /** 长期有效：不填到期日，不参与任何到期计算 */
  longTerm?: boolean;
  /** 元 */
  unitPriceYuan?: number;
  purchasedDaysAgo?: number;
  openedDaysAgo?: number;
  status?: string;
  store?: string;
  serialNo?: string;
  /** 质保到期：相对今天的天数 */
  warrantyInDays?: number;
}

interface SeedThing {
  name: string;
  category: string;
  brand?: string;
  /**
   * 型号：这东西是哪一款（MX Master 3S / Pro H）。
   * 和 spec 不是一回事 —— spec 说的是「这一份有多大」（0.3g×20粒 / 20000mAh）。
   */
  model?: string;
  spec?: string;
  unit?: string;
  barcode?: string;
  room?: string;
  container?: string;
  minStock?: number;
  warrantyMonths?: number;
  openShelfLifeDays?: number;
  prescription?: boolean;
  notes?: string;
  tags?: string;
  purchases: SeedPurchase[];
}

const SEED: SeedThing[] = [
  {
    name: '布洛芬缓释胶囊',
    category: 'medicine',
    brand: '芬必得',
    spec: '0.3g×20粒',
    unit: '盒',
    barcode: '6901234567892',
    room: '客厅',
    container: '药箱-上层',
    notes: '退烧镇痛，24 小时内不超过 2 粒',
    purchases: [
      // 同一件药买了两次 —— 新结构下这是两条记录，各自算自己的到期
      { quantity: 1, expiresInMonths: -3, unitPriceYuan: 19.3, purchasedDaysAgo: 500, store: '京东健康' },
      { quantity: 1, expiresInDays: 14, unitPriceYuan: 21.8, purchasedDaysAgo: 700, store: '老百姓大药房' },
    ],
  },
  {
    name: '对乙酰氨基酚口服混悬液（儿童）',
    category: 'medicine',
    brand: '泰诺林',
    spec: '100ml',
    unit: '瓶',
    room: '客厅',
    container: '药箱-上层',
    openShelfLifeDays: 30,
    notes: '开封后 30 天内有效，儿童用药',
    purchases: [
      { quantity: 1, expiresInDays: 210, unitPriceYuan: 28.5, purchasedDaysAgo: 120, openedDaysAgo: 40, store: '医院药房' },
    ],
  },
  {
    name: '左氧氟沙星滴眼液',
    category: 'medicine',
    brand: '可乐必妥',
    spec: '5ml',
    unit: '支',
    room: '卧室',
    container: '床头柜抽屉',
    prescription: true,
    openShelfLifeDays: 28,
    notes: '处方药，开封后 28 天必须丢弃',
    purchases: [
      { quantity: 1, expiresInDays: 400, unitPriceYuan: 42.0, purchasedDaysAgo: 60, openedDaysAgo: 40, store: '医院药房' },
    ],
  },
  {
    name: '碘伏消毒棉签',
    category: 'medical_device',
    brand: '海氏海诺',
    spec: '100支/盒',
    unit: '盒',
    room: '客厅',
    container: '药箱-下层',
    minStock: 1,
    purchases: [
      { bulk: true, quantity: 2, remaining: 1, expiresInMonths: 14, unitPriceYuan: 15.9, purchasedDaysAgo: 90, store: '天猫超市' },
    ],
  },
  {
    name: '维生素D3滴剂',
    category: 'supplement',
    brand: 'Ddrops',
    spec: '2.5ml',
    unit: '瓶',
    room: '厨房',
    container: '调味架',
    purchases: [
      { quantity: 1, expiresInDays: 55, unitPriceYuan: 128.0, purchasedDaysAgo: 200, store: 'iHerb' },
    ],
  },
  {
    name: '抽纸巾',
    category: 'daily',
    brand: '维达',
    spec: '3层×120抽',
    unit: '包',
    room: '储物间',
    container: '货架-A',
    minStock: 6,
    notes: '一箱 24 包，分两批买的，到期日不同',
    // ── 一组库存：这批抽纸拆成三条，各自管自己的数量与到期日 ──
    purchases: [
      { bulk: true, quantity: 10, remaining: 6, expiresInMonths: 30, unitPriceYuan: 2.5, purchasedDaysAgo: 200, store: '山姆' },
      { bulk: true, quantity: 8, remaining: 8, expiresInMonths: 42, unitPriceYuan: 2.6, purchasedDaysAgo: 90, store: '山姆' },
      { bulk: true, quantity: 6, remaining: 6, longTerm: true, unitPriceYuan: 2.4, purchasedDaysAgo: 20, store: '京东' },
    ],
  },
  {
    name: '洗衣凝珠',
    category: 'daily',
    brand: '立白',
    spec: '52颗/盒',
    unit: '盒',
    room: '阳台',
    container: '洗衣机上方',
    minStock: 2,
    purchases: [
      { bulk: true, quantity: 2, remaining: 1, expiresInDays: 150, unitPriceYuan: 45.0, purchasedDaysAgo: 200, store: '永辉超市' },
    ],
  },
  {
    name: '5号碱性电池',
    category: 'daily',
    brand: '南孚',
    spec: '8粒装',
    unit: '板',
    room: '储物间',
    container: '货架-B',
    minStock: 2,
    purchases: [
      { bulk: true, quantity: 3, remaining: 1, expiresInDays: 900, unitPriceYuan: 19.9, purchasedDaysAgo: 120, store: '京东' },
    ],
  },
  {
    name: '空气净化器滤芯',
    category: 'digital',
    brand: '小米',
    model: 'M8R-FLP',
    spec: '适配 Pro H',
    unit: '个',
    room: '客厅',
    container: '净化器旁',
    notes: '建议 6-12 个月更换',
    purchases: [
      { quantity: 1, expiresInDays: 75, unitPriceYuan: 299.0, purchasedDaysAgo: 300, warrantyInDays: 60, store: '小米商城' },
    ],
  },
  {
    name: '移动电源',
    category: 'digital',
    brand: 'Anker',
    model: 'A1287',
    spec: '20000mAh',
    unit: '个',
    room: '书房',
    container: '抽屉-2',
    warrantyMonths: 24,
    // 本体长期有效，只有质保期需要盯
    purchases: [
      {
        quantity: 1,
        longTerm: true,
        unitPriceYuan: 399.0,
        purchasedDaysAgo: 400,
        warrantyInDays: 330,
        serialNo: 'AK2024XXXXXX',
        store: '天猫 Anker 旗舰店',
      },
    ],
  },
  {
    name: '无线鼠标',
    category: 'digital',
    brand: '罗技',
    model: 'MX Master 3S',
    spec: '蓝牙 + 2.4G 双模',
    unit: '个',
    room: '书房',
    container: '桌面',
    warrantyMonths: 12,
    purchases: [
      {
        quantity: 1,
        longTerm: true,
        unitPriceYuan: 649.0,
        purchasedDaysAgo: 30,
        warrantyInDays: 335,
        serialNo: 'LG-3S-0001',
        store: '京东自营',
      },
    ],
  },
  {
    name: '婴儿配方奶粉',
    category: 'food',
    brand: '爱他美',
    spec: '800g',
    unit: '罐',
    room: '厨房',
    container: '吊柜',
    minStock: 2,
    openShelfLifeDays: 28,
    notes: '开封后 4 周内用完',
    purchases: [
      // 一罐已开封、一罐未开封 —— 两条记录，各自算到期
      { quantity: 1, expiresInDays: 20, unitPriceYuan: 268.0, purchasedDaysAgo: 100, openedDaysAgo: 25, store: '网易考拉' },
      { quantity: 1, expiresInDays: 260, unitPriceYuan: 258.0, purchasedDaysAgo: 30, store: '网易考拉' },
    ],
  },
  {
    name: '意式浓缩咖啡豆',
    category: 'food',
    brand: 'Lavazza',
    spec: '1kg',
    unit: '袋',
    room: '厨房',
    container: '咖啡角',
    openShelfLifeDays: 45,
    purchases: [
      { bulk: true, quantity: 2, remaining: 1, expiresInMonths: 9, unitPriceYuan: 168.0, purchasedDaysAgo: 20, openedDaysAgo: 38, store: '山姆' },
    ],
  },
  {
    name: '保湿面霜',
    category: 'cosmetic',
    brand: '珂润',
    spec: '40g',
    unit: '罐',
    room: '卫生间',
    container: '镜柜',
    openShelfLifeDays: 365,
    purchases: [
      { quantity: 1, expiresInDays: 500, unitPriceYuan: 189.0, purchasedDaysAgo: 150, openedDaysAgo: 150, store: '屈臣氏' },
    ],
  },
  {
    name: '防晒霜',
    category: 'cosmetic',
    brand: '安热沙',
    spec: '60ml',
    unit: '瓶',
    room: '玄关',
    container: '出门篮',
    minStock: 1,
    purchases: [
      { quantity: 1, expiresInMonths: 11, unitPriceYuan: 219.0, purchasedDaysAgo: 120, store: '天猫国际' },
    ],
  },
  {
    name: '车辆交强险保单',
    category: 'document',
    brand: '平安保险',
    unit: '份',
    room: '书房',
    container: '文件柜-车务',
    notes: '到期前需续保，否则无法上路',
    purchases: [{ quantity: 1, expiresInDays: 45, purchasedDaysAgo: 320, store: '平安好车主' }],
  },
  {
    name: '护照',
    category: 'document',
    unit: '本',
    room: '书房',
    container: '文件柜-证件',
    purchases: [{ quantity: 1, expiresInDays: 1000, purchasedDaysAgo: 900, store: '出入境管理局' }],
  },
  {
    name: '雨伞',
    category: 'other',
    unit: '把',
    room: '玄关',
    container: '伞架',
    purchases: [{ quantity: 1, longTerm: true, unitPriceYuan: 79.0, purchasedDaysAgo: 60, store: '无印良品' }],
  },
];

export interface SeedResult {
  items: number;
  moves: number;
  /** 其中有多少条是「一组库存」的子行 */
  stocks: number;
}

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

/** 往一个空工作区里写入演示数据。已有数据时抛错，避免重复灌入。 */
export function seedWorkspace(dataDir: string, entry: WorkspaceEntry, now: Date = new Date()): SeedResult {
  const dbPath = workspaceDbPath(dataDir, entry);
  const db = openDatabase(dbPath);
  try {
    if (countRows(db, 'items') > 0) {
      throw new Error(`工作区「${entry.name}」中已有物品数据，拒绝重复写入演示数据`);
    }

    let itemCount = 0;
    let moveCount = 0;
    let stockCount = 0;
    const codeSeq = new Map<string, number>();

    const nextCode = (category: string, derived = 0): string => {
      const prefix = CODE_PREFIX[category] ?? 'GEN';
      const n = (codeSeq.get(prefix) ?? 0) + 1;
      codeSeq.set(prefix, n);
      return derived > 0
        ? `${prefix}-${String(n).padStart(4, '0')}-${derived}`
        : `${prefix}-${String(n).padStart(4, '0')}`;
    };

    transaction(db, () => {
      for (const thing of SEED) {
        const bulk = thing.purchases.some((p) => p.bulk);
        /**
         * 只有**多次买入**的批量物品才拆成「一组库存」。
         *
         * 单次买入的批量物品（洗衣凝珠、电池）直接用自己的数量与到期日就够了 ——
         * 硬拆成一条子行只会让界面多出一个「1 组」和一张单行表格，没有信息量。
         * 需要分开管到期日时再拆（抽纸巾那三条就是）。
         */
        const asStocks = bulk && thing.purchases.length > 1;

        let parentUuid: string | null = null;
        if (asStocks) {
          const parent = insertRow(db, 'items', {
            code: nextCode(thing.category),
            name: thing.name,
            category: thing.category,
            brand: thing.brand ?? null,
            model: thing.model ?? null,
            spec: thing.spec ?? null,
            unit: thing.unit ?? '件',
            barcode: thing.barcode ?? null,
            room: thing.room ?? null,
            container: thing.container ?? null,
            is_bulk: 'true',
            quantity: '0', // 马上由子行汇总覆盖
            remaining: '0',
            min_stock: thing.minStock !== undefined ? String(thing.minStock) : null,
            status: 'in_stock',
            notes: thing.notes ?? null,
            tags: thing.tags ?? null,
          });
          parentUuid = String(parent['uuid']);
          itemCount += 1;
        }

        for (const p of thing.purchases) {
          let expiresOn: string | null = null;
          let expiresYm: string | null = null;
          if (p.longTerm) {
            expiresOn = null;
          } else if (p.expiresInDays !== undefined) {
            expiresOn = addDays(today(now), p.expiresInDays);
          } else if (p.expiresInMonths !== undefined) {
            const target = addMonths(today(now), p.expiresInMonths);
            // 只到月份 → 折算成当月最后一天
            expiresYm = target ? target.slice(0, 7) : null;
            expiresOn = expiresYm ? monthEnd(expiresYm) : null;
          }

          const purchasedOn = p.purchasedDaysAgo !== undefined ? addDays(today(now), -p.purchasedDaysAgo) : null;
          const openedOn = p.openedDaysAgo !== undefined ? addDays(today(now), -p.openedDaysAgo) : null;
          const warrantyUntil = p.warrantyInDays !== undefined ? addDays(today(now), p.warrantyInDays) : null;
          const remaining = p.remaining ?? p.quantity;

          const unitPriceCents = p.unitPriceYuan !== undefined ? Math.round(p.unitPriceYuan * 100) : null;
          const amountCents = unitPriceCents !== null ? unitPriceCents * p.quantity : null;

          const row = insertRow(db, 'items', {
            // 子行的编号由父项派生，只用于内部定位
            code: parentUuid ? nextCode(thing.category, itemCount) : nextCode(thing.category),
            parent_uuid: parentUuid,
            name: thing.name,
            category: thing.category,
            brand: thing.brand ?? null,
            model: thing.model ?? null,
            spec: thing.spec ?? null,
            unit: thing.unit ?? '件',
            barcode: thing.barcode ?? null,
            room: thing.room ?? null,
            container: thing.container ?? null,
            // 没有拆成一组库存时，这一行自己就代表那个批量物品
            is_bulk: parentUuid ? 'false' : bulk ? 'true' : 'false',
            quantity: String(p.quantity),
            remaining: String(remaining),
            min_stock: parentUuid || !bulk ? null : thing.minStock !== undefined ? String(thing.minStock) : null,
            purchased_on: purchasedOn,
            unit_price_cents: unitPriceCents !== null ? String(unitPriceCents) : null,
            amount_cents: amountCents !== null ? String(amountCents) : null,
            store: p.store ?? null,
            expires_on: expiresOn,
            expires_ym: expiresYm,
            opened_on: openedOn,
            warranty_months: thing.warrantyMonths !== undefined ? String(thing.warrantyMonths) : null,
            warranty_until: warrantyUntil,
            status: p.status ?? (remaining === 0 ? 'consumed' : 'in_stock'),
            is_prescription: thing.prescription ? 'true' : 'false',
            open_shelf_life_days:
              thing.openShelfLifeDays !== undefined ? String(thing.openShelfLifeDays) : null,
            serial_no: p.serialNo ?? null,
            notes: parentUuid ? null : (thing.notes ?? null),
            tags: parentUuid ? null : (thing.tags ?? null),
          });

          if (parentUuid) stockCount += 1;
          else itemCount += 1;

          if (purchasedOn) {
            insertRow(db, 'stock_moves', {
              item_uuid: String(row['uuid']),
              moved_on: purchasedOn,
              qty_delta: String(p.quantity),
              reason: 'purchase',
              notes: p.store ? `购自 ${p.store}` : null,
            });
            moveCount += 1;
          }

          const consumed = p.quantity - remaining;
          if (consumed > 0) {
            insertRow(db, 'stock_moves', {
              item_uuid: String(row['uuid']),
              moved_on: addDays(today(now), -7) ?? today(now),
              qty_delta: String(-consumed),
              reason: 'consume',
              notes: null,
            });
            moveCount += 1;
          }
        }

        // 父项的数量与最早到期日由子行汇总
        if (parentUuid) {
          const rows = db
            .prepare('SELECT * FROM items WHERE parent_uuid = ?')
            .all(parentUuid) as Record<string, unknown>[];
          let qty = 0;
          let rem = 0;
          let earliest: string | null = null;
          for (const r of rows) {
            qty += Number(r['quantity'] ?? 0);
            rem += Number(r['remaining'] ?? 0);
            const e = r['expires_on'] ? String(r['expires_on']) : null;
            if (e && (!earliest || e < earliest)) earliest = e;
          }
          db.prepare(
            'UPDATE items SET quantity = ?, remaining = ?, expires_on = ?, expires_ym = NULL WHERE uuid = ?',
          ).run(String(qty), String(rem), earliest, parentUuid);
        }
      }
    });

    return { items: itemCount, moves: moveCount, stocks: stockCount };
  } finally {
    db.close();
  }
}

export const SEED_ITEM_COUNT = SEED.length;
