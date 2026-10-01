/**
 * 导出包格式（manifest.json 的生成与校验）。
 *
 * 这是本系统的**公共接口**：人类可读、机器可解析、长期可解析。
 * 关键约束：manifest 里的表结构与 src/core/fields.ts 是同一份数据派生出来的，
 * 所以「代码里的表结构」和「导出包里的字段说明」在物理上不可能不一致。
 */
import { ENUMS, EXPORT_TABLE_ORDER, TABLES, exportedFields, type FieldDef, type FieldKind } from './fields';
import { SCHEMA_VERSION } from './schema';
import { APP_FORMAT, APP_FORMAT_VERSION, APP_NAME, APP_VERSION } from './meta';

/** manifest 里 csv 段的固定约定 */
export const CSV_CONVENTION = {
  encoding: 'UTF-8',
  bom: true,
  delimiter: ',',
  quote: '"',
  lineEnding: 'CRLF',
  /** 空单元格 = 空值（NULL）。\N 仅作兼容解析，不会写出 */
  nullLiteral: '\\N',
  /** 读时容忍空单元格，写时所有非空字段加引号（防 Excel 吃掉前导零、把 2027-03 当日期） */
  note:
    '空单元格表示该字段为空值。所有非空字段写出时都加双引号，以防 Excel 把 2027-03 当日期、把 0012345 的前导零吃掉。' +
    '\\N 会被解析为空值，但导出时不会写出它。',
} as const;

export interface ManifestColumn {
  name: string;
  type: FieldKind;
  label: string;
  description?: string;
  required: boolean;
  /** 是否参与导入导出。false 表示仅数据库内部使用（如 created_at） */
  exported: boolean;
  default?: string | number | boolean | null;
  enum?: string;
  enumValues?: { key: string; label: string }[];
  format?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  references?: { table: string; column: string };
  example?: string;
}

export interface ManifestTable {
  name: string;
  label: string;
  file: string;
  columns: ManifestColumn[];
  primaryKey: string;
  naturalKey?: string[];
  /** 导出时的行数，仅供人核对；导入时不作为校验依据 */
  rowCountAtExport: number;
}

export interface Manifest {
  format: string;
  formatVersion: number;
  app: string;
  appVersion: string;
  schemaVersion: number;
  exportedAt: string;
  workspace: {
    id: string;
    name: string;
    createdAt: string;
    source: string;
    notes?: string;
  };
  csv: typeof CSV_CONVENTION;
  identity: {
    primaryKey: 'uuid';
    note: string;
  };
  enums: Record<string, { key: string; label: string }[]>;
  tables: ManifestTable[];
  integrity: { algo: 'sha256'; file: string };
  /** 人类可读的字段说明，同时也会单独渲染成 README.md */
  notes?: string[];
}

function fieldFormat(f: FieldDef): string | undefined {
  switch (f.kind) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'year_month':
      return 'YYYY-MM';
    case 'datetime':
      return 'ISO-8601 (UTC)';
    case 'uuid':
      return 'UUIDv7';
    case 'path':
      return '相对工作区根的路径';
    case 'money_cents':
      return '整数，单位为「分」';
    default:
      return undefined;
  }
}

function fieldExample(f: FieldDef): string | undefined {
  switch (f.name) {
    case 'code':
      return 'MED-0001';
    case 'name':
      return '布洛芬缓释胶囊';
    case 'category':
      return 'medicine';
    case 'brand':
      return '芬必得';
    case 'spec':
      return '0.25g×24粒';
    case 'unit':
      return '盒';
    case 'barcode':
      return '6901234567892';
    case 'room':
      return '客厅';
    case 'container':
      return '药箱-上层';
    case 'expires_ym':
      return '2027-03';
    case 'expires_on':
      return '2027-03-31';
    case 'unit_price_cents':
      return '1930';
    case 'amount_cents':
      return '3860';
    case 'status':
      return 'in_stock';
    case 'is_bulk':
      return 'true';
    case 'parent_uuid':
      return '0190f0aa-0000-7000-8000-000000000000';
    default:
      return undefined;
  }
}

export function buildManifest(params: {
  workspace: { id: string; name: string; createdAt: string; source: string; notes?: string };
  rowCounts: Record<string, number>;
  exportedAt: string;
}): Manifest {
  const tables: ManifestTable[] = [];

  for (const tableName of EXPORT_TABLE_ORDER) {
    const def = TABLES.find((t) => t.name === tableName);
    if (!def) continue;

    const columns: ManifestColumn[] = def.fields.map((f) => {
      const col: ManifestColumn = {
        name: f.name,
        type: f.kind,
        label: f.label,
        required: Boolean(f.required),
        exported: !f.internal,
      };
      if (f.description) col.description = f.description;
      if (f.default !== undefined) col.default = f.default;
      if (f.enumName) {
        col.enum = f.enumName;
        col.enumValues = (ENUMS[f.enumName] ?? []).map((e) => ({ key: e.key, label: e.label }));
      }
      const fmt = fieldFormat(f);
      if (fmt) col.format = fmt;
      if (f.validation?.maxLength !== undefined) col.maxLength = f.validation.maxLength;
      if (f.validation?.min !== undefined) col.min = f.validation.min;
      if (f.validation?.max !== undefined) col.max = f.validation.max;
      if (f.references) col.references = f.references;
      const ex = fieldExample(f);
      if (ex) col.example = ex;
      return col;
    });

    const t: ManifestTable = {
      name: def.name,
      label: def.label,
      file: `tables/${def.name}.csv`,
      columns,
      primaryKey: 'uuid',
      rowCountAtExport: params.rowCounts[def.name] ?? 0,
    };
    if (def.naturalKey) t.naturalKey = def.naturalKey;
    tables.push(t);
  }

  const ws: Manifest['workspace'] = {
    id: params.workspace.id,
    name: params.workspace.name,
    createdAt: params.workspace.createdAt,
    source: params.workspace.source,
  };
  if (params.workspace.notes) ws.notes = params.workspace.notes;

  const enums: Record<string, { key: string; label: string }[]> = {};
  for (const [k, v] of Object.entries(ENUMS)) enums[k] = v.map((e) => ({ key: e.key, label: e.label }));

  return {
    format: APP_FORMAT,
    formatVersion: APP_FORMAT_VERSION,
    app: APP_NAME,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: params.exportedAt,
    workspace: ws,
    csv: CSV_CONVENTION,
    identity: {
      primaryKey: 'uuid',
      note: '主键在导出后不可变。导入时一律新建工作区，因此不需要按主键做冲突合并；uuid 仅用于包内的父子引用。',
    },
    enums,
    tables,
    integrity: { algo: 'sha256', file: 'checksums.txt' },
    notes: [
      '一个工作区一个 SQLite 文件，工作区之间完全隔离、互不感知。',
      '导入的单位是工作区：导入操作会新建一个工作区，绝不修改已有工作区。',
      '同一件物品同时登记在多个工作区中是允许的，不会产生任何冲突。',
      'expires_on 是唯一用于到期计算的列；expiry_precision=month 时它等于 expires_ym 当月的最后一天。',
      '金额一律以整数「分」存储，避免浮点误差。',
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// 校验与兼容性
// ─────────────────────────────────────────────────────────────

export interface ManifestValidation {
  ok: boolean
  errors: string[];
  warnings: string[];
  manifest?: Manifest;
}

/** 判断归档里的 manifest 能否被当前版本导入 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['manifest.json 不是一个 JSON 对象'], warnings };
  }
  const m = raw as Partial<Manifest>;

  if (m.format !== APP_FORMAT) {
    errors.push(`format 不匹配：期望 "${APP_FORMAT}"，实际 "${String(m.format)}"`);
  }
  if (typeof m.formatVersion !== 'number') {
    errors.push('缺少 formatVersion');
  } else if (m.formatVersion > APP_FORMAT_VERSION) {
    errors.push(
      `归档格式版本 ${m.formatVersion} 高于当前支持版本 ${APP_FORMAT_VERSION}，请升级应用后再导入`,
    );
  } else if (m.formatVersion < APP_FORMAT_VERSION) {
    warnings.push(`归档格式版本 ${m.formatVersion} 低于当前版本 ${APP_FORMAT_VERSION}，将按兼容模式导入`);
  }

  if (typeof m.schemaVersion === 'number' && m.schemaVersion !== SCHEMA_VERSION) {
    warnings.push(`归档数据版本 ${m.schemaVersion} 与当前 ${SCHEMA_VERSION} 不同，导入时会套用当前结构`);
  }

  if (!Array.isArray(m.tables) || m.tables.length === 0) {
    errors.push('manifest.json 缺少 tables 数组');
  } else {
    const names = new Set(m.tables.map((t) => t.name));
    for (const required of EXPORT_TABLE_ORDER) {
      if (!names.has(required)) {
        // items 是核心，缺了就没意义；stock_moves 可以缺
        if (required === 'stock_moves') warnings.push(`归档不含 ${required} 表，该表将为空`);
        else errors.push(`归档缺少必需的表: ${required}`);
      }
    }
    for (const t of m.tables) {
      if (!t.file) errors.push(`表 ${t.name} 未声明 file`);
      if (!Array.isArray(t.columns) || t.columns.length === 0) {
        errors.push(`表 ${t.name} 未声明 columns`);
      }
    }
  }

  if (!m.workspace || typeof m.workspace.name !== 'string') {
    warnings.push('manifest.json 缺少 workspace.name，导入时将使用归档文件名作为工作区名');
  }

  return { ok: errors.length === 0, errors, warnings, ...(errors.length === 0 ? { manifest: m as Manifest } : {}) };
}

/** 校验 CSV 表头是否覆盖 manifest 声明的列 */
export function checkHeaderAgainstManifest(
  table: ManifestTable,
  header: string[],
): { missing: string[]; unknown: string[] } {
  const declared = new Set(table.columns.filter((c) => c.exported).map((c) => c.name));
  const actual = new Set(header);
  const missing = [...declared].filter((c) => !actual.has(c));
  const unknown = header.filter((h) => h !== '' && !declared.has(h));
  return { missing, unknown };
}

/** 导出时每行由哪些列组成（顺序固定，避免 diff 噪音） */
export function manifestColumnsForExport(tableName: string): FieldDef[] {
  const def = TABLES.find((t) => t.name === tableName);
  if (!def) throw new Error(`未知的表: ${tableName}`);
  return exportedFields(def);
}
