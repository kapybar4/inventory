/**
 * 字段定义 —— 全系统唯一真相（Single Source of Truth）
 *
 * 以下三处产物全部由本文件派生，不允许各自手写：
 *   1. SQLite DDL          → src/core/schema.ts  的 buildDdl()
 *   2. 导出包的 manifest.json → src/core/manifest.ts
 *   3. 桌面端表单 / 表格列    → renderer 通过 IPC 拿 schema 渲染
 *
 * 因此「表结构」和「导入导出的格式说明」在物理上不可能漂移。
 *
 * ── v2：取消批次 ──
 * 家庭场景没有「批次」这个概念。同一件东西买两次，就是**两条独立记录**，
 * 各自带自己的购买日期、到期日与价格。所以原来 batches 表上的字段
 * （购买日期 / 到期日 / 价格 / 开封日 / 序列号 / 状态 / 剩余数量）
 * 全部并入 items。好处不只是少一张表：
 *   - 界面上一行就是一件看得见摸得着的东西，不用再「展开看批次」
 *   - 提醒直接按物品算，不需要先聚合再判断
 *   - 导入导出少一张表、少一层外键
 */

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** CSV 里能承载的原子类型。日期统一用字符串约定格式，避免时区与浮点误差。 */
export type FieldKind =
  | 'string'
  | 'text'
  | 'int'
  | 'money_cents'
  | 'bool'
  | 'date'
  | 'datetime'
  | 'year_month'
  | 'uuid'
  | 'path'
  /**
   * 扁平 JSON 对象（键值都是字符串，不嵌套），在库里存成 TEXT。
   *
   * 用它而不是真开一批列：每件东西要记的附加信息各不相同
   * （空调记滤网型号、保单记保单号），为这个去 ALTER TABLE 不划算。
   * 代价是不能用它排序或建索引 —— 所以它只用来"看"，不用来"筛"。
   */
  | 'json';

export interface EnumDef {
  key: string;
  label: string;
  /** 可选语义补充，会写进 manifest 供导入方理解 */
  semantics?: string;
}

export interface FieldDef {
  /** 列名 / CSV 表头 / manifest 里的键 —— 全系统统一使用该英文名 */
  name: string;
  kind: FieldKind;
  label: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean | null;
  /** 引用 enums 表的枚举名 */
  enumName?: string;
  /** 外键：引用另一张表的列 */
  references?: { table: string; column: string };
  validation?: { min?: number; max?: number; maxLength?: number; pattern?: string };
  /** 仅存在于数据库、不参与导入导出的列（如 created_at） */
  internal?: boolean;
}

export interface TableDef {
  name: string;
  label: string;
  /** 业务唯一键 */
  naturalKey?: string[];
  fields: FieldDef[];
  indexes?: { name: string; columns: string[]; unique?: boolean }[];
}

// ─────────────────────────────────────────────────────────────
// 枚举
// ─────────────────────────────────────────────────────────────

export const ENUMS: Record<string, EnumDef[]> = {
  item_category: [
    { key: 'medicine', label: '药品' },
    { key: 'supplement', label: '保健品' },
    { key: 'daily', label: '日用品' },
    { key: 'digital', label: '数码设备' },
    { key: 'food', label: '食品' },
    { key: 'cosmetic', label: '化妆品' },
    { key: 'medical_device', label: '医疗器械' },
    { key: 'document', label: '证件票据' },
    { key: 'other', label: '其他' },
  ],
  expiry_precision: [
    { key: 'day', label: '精确到日' },
    { key: 'month', label: '仅到月份', semantics: '到期日按该月最后一天计算' },
    { key: 'none', label: '长期有效 / 无到期' },
  ],
  item_status: [
    { key: 'in_stock', label: '在库' },
    { key: 'in_use', label: '使用中' },
    { key: 'consumed', label: '已用完' },
    { key: 'discarded', label: '已丢弃' },
    { key: 'expired_disposed', label: '过期已处理' },
  ],
  move_reason: [
    { key: 'purchase', label: '购入' },
    { key: 'consume', label: '领用' },
    { key: 'discard', label: '丢弃' },
    { key: 'expired_dispose', label: '过期处理' },
    { key: 'gift_in', label: '受赠' },
    { key: 'gift_out', label: '赠出' },
    { key: 'adjust', label: '盘点调整' },
    { key: 'loss', label: '遗失' },
  ],
  // 提醒分级已取消（见 README「取消提醒分级」一节）。
  // 早先这里还有 alert_level: ok/watch/warn/urgent/expired，实测档位边界
  // （21 天算紧急还是临期）对用户没有意义，只留「已过期」一个标记，
  // 其余交给分组 + 排序表达。枚举一并删掉，免得有人以为它还有用。
  /** 工作区是怎么来的 —— 界面显示中文，manifest 里仍存 key 以便程序判断 */
  workspace_source: [
    { key: 'blank', label: '新建' },
    { key: 'demo', label: '示例' },
    { key: 'import', label: '导入' },
  ],
};

/**
 * 分类 → 提前预警天数。
 *
 * 这套数值刻意收得比较紧：提醒的价值取决于「看到了就会行动」，
 * 提前量一旦过大（比如保单提前半年就报紧急），列表会被噪音填满，
 * 用户三周内就会无视它 —— 那样整个系统就白做了。
 */
export const CATEGORY_LEAD_DAYS: Record<string, number> = {
  medicine: 60, // 药品：家里翻药箱的周期长，值得早提醒
  supplement: 60,
  food: 15, // 食品：提前太多没有意义，反而是「还剩多少天」更有用
  daily: 45, // 日用品：够时间在下次采购时补上
  cosmetic: 45,
  digital: 60, // 数码：质保到期前需要留出送修时间
  medical_device: 60,
  document: 45, // 证件票据：续保/换证要预约，45 天足够
  other: 45,
};

/** 物品的可选状态中，哪些算「还在手上」 */
export const ACTIVE_STATUSES = ['in_stock', 'in_use'] as const;

// ─────────────────────────────────────────────────────────────
// 通用列
// ─────────────────────────────────────────────────────────────

const COL_UUID: FieldDef = {
  name: 'uuid',
  kind: 'uuid',
  label: '主键',
  required: true,
  description: 'UUIDv7，含时间信息且字典序即时间序。导出后不可变。',
};

const COL_CREATED_AT: FieldDef = {
  name: 'created_at',
  kind: 'datetime',
  label: '创建时间',
  internal: true,
};

const COL_UPDATED_AT: FieldDef = {
  name: 'updated_at',
  kind: 'datetime',
  label: '更新时间',
  internal: true,
  description: '由触发器维护。导入时用它与库中已有值比较，决定保留哪一侧。',
};

// ─────────────────────────────────────────────────────────────
// 表定义
// ─────────────────────────────────────────────────────────────

export const TABLES: TableDef[] = [
  {
    name: 'items',
    label: '物品（一行 = 一件实际存在的东西）',
    naturalKey: ['code'],
    fields: [
      COL_UUID,
      {
        name: 'code',
        kind: 'string',
        label: '内部标识',
        required: true,
        internal: true,
        validation: { maxLength: 64 },
        description:
          '界面上不显示、导出包里也没有。仅在内部保留，让命令行能用它定位一条记录' +
          '（如 `item show MED-0001`）；导入时按分类前缀重新生成，所以两个工作区相同物品的编号可能不同。',
      },
      {
        name: 'parent_uuid',
        kind: 'string',
        label: '所属物品',
        validation: { maxLength: 36 },
        description:
          '批量物品的「一组库存」条目：指向它所属的批量物品（写对方的 uuid）。' +
          '留空 = 这条本身就是一个独立物品。库存条目自己带数量与到期日。' +
          '**必须导出**：它是结构而不是元数据，丢了父子关系就断了。',
      },
      { name: 'name', kind: 'string', label: '名称', required: true, validation: { maxLength: 120 } },
      {
        name: 'category',
        kind: 'string',
        label: '分类',
        // 可以留空 = 未分类。这是个**刻意的**空值语义：
        // 「还没想好放哪类」应该被看见并推动去填，而不是塞进「其他」蒙混过去。
        enumName: 'item_category',
        description: '留空即「未分类」，在分组页永远置顶且不可拖动 —— 目的是推着你去分类。',
      },
      {
        name: 'sort_order',
        kind: 'int',
        label: '手动顺序',
        validation: { min: 0 },
        description:
          '默认状态下的排列顺序。拖动时改的就是它；开启排序后它被忽略但保留，' +
          '所以随时关掉排序都能回到你手工摆好的样子。',
      },
      { name: 'subcategory', kind: 'string', label: '子类', validation: { maxLength: 60 }, description: '二级分组' },
      { name: 'brand', kind: 'string', label: '品牌', validation: { maxLength: 80 }, description: '选填，如 芬必得 / Anker' },
      {
        name: 'model',
        kind: 'string',
        label: '型号',
        validation: { maxLength: 120 },
        description:
          '选填。**和规格不是一回事**：规格说的是这盒药有多少粒（0.25g×24粒），' +
          '型号说的是这台东西是哪一款（MX Master 3S / Pro H）。数码、家电、耗材最用得上。',
      },
      {
        name: 'spec',
        kind: 'string',
        label: '规格',
        validation: { maxLength: 120 },
        description: '选填，如 0.25g×24粒 / 3层×120抽',
      },
      { name: 'unit', kind: 'string', label: '单位', default: '件', validation: { maxLength: 20 } },
      { name: 'barcode', kind: 'string', label: '条码', validation: { maxLength: 64 } },
      { name: 'room', kind: 'string', label: '房间', validation: { maxLength: 60 }, description: '存放位置第一级' },
      {
        name: 'container',
        kind: 'string',
        label: '容器/柜格',
        validation: { maxLength: 60 },
        description: '存放位置第二级，如 客厅药箱-上层',
      },

      // ── 数量 ──
      {
        name: 'is_bulk',
        kind: 'bool',
        label: '批量物品',
        default: false,
        description:
          '默认关闭：数量恒为 1，操作是「消耗」一次归零。' +
          '只有需要按个数管理的物品（抽纸、电池、口罩）才开启 —— 开启后数量可设、可多次领用、可设最低库存。',
      },
      {
        name: 'quantity',
        kind: 'int',
        label: '数量',
        default: 1,
        validation: { min: 0 },
        description: '买入时多少个。**非批量物品恒为 1**，界面上不可编辑。',
      },
      {
        name: 'remaining',
        kind: 'int',
        label: '剩余数量',
        default: 1,
        validation: { min: 0 },
        description: '当前还剩多少。**非批量物品只可能是 1（在手上）或 0（已消耗）**。',
      },
      {
        name: 'min_stock',
        kind: 'int',
        label: '最低库存',
        default: 0,
        validation: { min: 0 },
        description: '剩余低于此值时进入待补货清单。只对批量物品有意义。',
      },

      // ── 购买与价格 ──
      { name: 'purchased_on', kind: 'date', label: '购买日期' },
      { name: 'unit_price_cents', kind: 'money_cents', label: '单价（分）', validation: { min: 0 }, description: '以整数分存储，避免浮点误差' },
      { name: 'amount_cents', kind: 'money_cents', label: '总价（分）', validation: { min: 0 } },
      { name: 'store', kind: 'string', label: '购买渠道', validation: { maxLength: 80 } },

      // ── 到期 ──
      // 只保留「一个到期日，或者干脆没有」两种状态。
      // 不再有「精确到日 / 只到月份 / 无到期」这种要用户选的东西：
      // 填了就是那一天，不填就是长期。
      {
        name: 'expires_on',
        kind: 'date',
        label: '到期日',
        description:
          '留空 = 长期，不参与任何到期计算。' +
          '包装只印到月份时，直接填那个月的最后一天（如 2027-03-31）。' +
          '批量物品配置了「一组库存」时，这里由最早的库存条目派生。',
      },
      {
        name: 'expires_ym',
        kind: 'year_month',
        label: '到期年月',
        internal: true,
        description: '旧数据兼容用。界面与导出都不再出现，导入时原样往返以免丢信息。',
      },
      {
        name: 'expiry_precision',
        kind: 'string',
        label: '到期精度',
        required: true,
        enumName: 'expiry_precision',
        default: 'none',
        internal: true,
        description: '旧数据兼容用。新增记录一律为 none，不再由用户选择。',
      },
      {
        name: 'opened_on',
        kind: 'date',
        label: '开封日期',
        description: '与 open_shelf_life_days 结合可算出开封后到期日',
      },
      { name: 'warranty_months', kind: 'int', label: '质保月数', validation: { min: 0, max: 600 } },
      { name: 'warranty_until', kind: 'date', label: '质保到期日' },

      // ── 属性与状态 ──
      {
        name: 'status',
        kind: 'string',
        label: '状态',
        required: true,
        enumName: 'item_status',
        default: 'in_stock',
      },
      { name: 'is_prescription', kind: 'bool', label: '处方药', default: false },
      { name: 'open_shelf_life_days', kind: 'int', label: '开封后可用天数', validation: { min: 0, max: 3650 } },
      { name: 'serial_no', kind: 'string', label: '序列号', validation: { maxLength: 120 } },
      { name: 'photo_path', kind: 'path', label: '照片', description: '相对工作区根的 attachments/ 路径' },
      { name: 'notes', kind: 'text', label: '备注' },
      {
        name: 'extra_json',
        kind: 'json',
        label: '补充信息',
        description:
          '一个**扁平**的 JSON 对象，键值都是字符串，**不允许嵌套**。' +
          '存每件东西额外想记的东西（滤网型号、保单号、报修电话…）。' +
          '界面上不占列，点行首的展开箭头才显示。默认列为空时写 NULL 而不是 {}。',
      },
      { name: 'tags', kind: 'string', label: '标签', description: '逗号分隔' },
      COL_CREATED_AT,
      COL_UPDATED_AT,
    ],
    indexes: [
      { name: 'idx_items_code', columns: ['code'], unique: true },
      { name: 'idx_items_parent', columns: ['parent_uuid'] },
      { name: 'idx_items_category', columns: ['category'] },
      { name: 'idx_items_name', columns: ['name'] },
      { name: 'idx_items_barcode', columns: ['barcode'] },
      { name: 'idx_items_expires', columns: ['expires_on'] },
      { name: 'idx_items_status', columns: ['status'] },
      { name: 'idx_items_sort', columns: ['sort_order'] },
    ],
  },

  {
    name: 'stock_moves',
    label: '出入库流水',
    fields: [
      COL_UUID,
      { name: 'item_uuid', kind: 'uuid', label: '物品', required: true, references: { table: 'items', column: 'uuid' } },
      { name: 'moved_on', kind: 'date', label: '发生日期', required: true },
      { name: 'qty_delta', kind: 'int', label: '数量变化', required: true, description: '购入为正，领用/丢弃为负' },
      { name: 'reason', kind: 'string', label: '原因', enumName: 'move_reason', default: 'adjust' },
      { name: 'notes', kind: 'text', label: '备注' },
      COL_CREATED_AT,
    ],
    indexes: [
      { name: 'idx_moves_item', columns: ['item_uuid'] },
      { name: 'idx_moves_date', columns: ['moved_on'] },
    ],
  },
];

export const TABLE_BY_NAME: Record<string, TableDef> = Object.fromEntries(TABLES.map((t) => [t.name, t]));

/** 参与导入导出的表，按依赖顺序排列（父表在前，保证外键可满足） */
export const EXPORT_TABLE_ORDER: string[] = ['items', 'stock_moves'];

export function tableDef(name: string): TableDef {
  const t = TABLE_BY_NAME[name];
  if (!t) throw new Error(`未知的表: ${name}`);
  return t;
}

export function exportedFields(t: TableDef): FieldDef[] {
  return t.fields.filter((f) => !f.internal);
}

export function fieldNames(t: TableDef, opts: { includeInternal?: boolean } = {}): string[] {
  const fs = opts.includeInternal ? t.fields : exportedFields(t);
  return fs.map((f) => f.name);
}
