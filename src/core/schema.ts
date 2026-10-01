/**
 * 由 fields.ts 派生 SQLite DDL。
 * 手写 DDL 会和字段定义漂移，所以这里完全生成。
 */
import { ENUMS, TABLES, type FieldDef } from './fields';

function sqlType(f: FieldDef): string {
  switch (f.kind) {
    case 'int':
    case 'money_cents':
      return 'INTEGER';
    case 'bool':
      return 'INTEGER'; // 0/1
    default:
      return 'TEXT';
  }
}

function columnClause(f: FieldDef): string {
  const parts = [f.name, sqlType(f)];
  if (f.name === 'uuid' || f.required) parts.push('NOT NULL');
  if (f.name === 'uuid') parts.push('PRIMARY KEY');
  if (f.kind === 'bool') parts.push('CHECK (' + f.name + ' IN (0,1))');
  if (f.enumName) {
    const keys = (ENUMS[f.enumName] ?? []).map((e) => `'${e.key}'`).join(',');
    if (f.required) {
      parts.push(`CHECK (${f.name} IN (${keys}))`);
    } else {
      // 可空枚举：允许 NULL，但非 NULL 时必须在集合内
      parts.push(`CHECK (${f.name} IS NULL OR ${f.name} IN (${keys}))`);
    }
  }
  return parts.join(' ');
}

function defaultClause(f: FieldDef): string | null {
  if (f.default === undefined) return null;
  if (typeof f.default === 'boolean') return `DEFAULT ${f.default ? 1 : 0}`;
  if (typeof f.default === 'number') return `DEFAULT ${f.default}`;
  return `DEFAULT '${String(f.default).replace(/'/g, "''")}'`;
}

/**
 * 单独一列的完整定义。
 *
 * **迁移与建表共用这一份** —— 迁移里重建表时如果另写一遍列定义，
 * 迟早会和这里漂移，而漂移的后果是「结构看着对、实际缺列」这种最难查的问题。
 */
export function columnDefinition(f: FieldDef): string {
  let c = columnClause(f);
  const d = defaultClause(f);
  if (d) c += ' ' + d;
  if (f.references) {
    // 父表被删时子表跟随删除；物品删了，流水留着没有意义
    c += ` REFERENCES ${f.references.table}(${f.references.column}) ON DELETE CASCADE`;
  }
  return c;
}

/** 一张表的 CREATE TABLE 语句 */
export function tableDdl(tableName: string, ifNotExists = true): string {
  const t = TABLES.find((x) => x.name === tableName);
  if (!t) throw new Error(`未知的表: ${tableName}`);
  return ddlFromFields(tableName, t.fields, ifNotExists);
}

/**
 * 用给定字段定义生成 CREATE TABLE。
 *
 * 迁移重建表时临时表叫 `items__rebuilt`，查不到表定义，
 * 所以这里接受字段数组而不是表名 —— 保证迁移建出来的结构与正式建表**逐字一致**。
 */
export function ddlFromFields(tableName: string, fields: FieldDef[], ifNotExists = true): string {
  const cols = fields.map((f) => '  ' + columnDefinition(f));
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (\n${cols.join(',\n')}\n)`;
}

export function buildDdl(): string[] {
  const stmts: string[] = [];

  for (const t of TABLES) {
    stmts.push(tableDdl(t.name));

    for (const idx of t.indexes ?? []) {
      const uniq = idx.unique ? 'UNIQUE ' : '';
      stmts.push(`CREATE ${uniq}INDEX IF NOT EXISTS ${idx.name} ON ${t.name}(${idx.columns.join(', ')})`);
    }
  }

  // updated_at 由触发器维护，避免忘记更新导致导入时判断失误
  for (const t of TABLES) {
    if (!t.fields.some((f) => f.name === 'updated_at')) continue;
    stmts.push(
      `CREATE TRIGGER IF NOT EXISTS trg_${t.name}_updated_at
AFTER UPDATE ON ${t.name}
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ${t.name} SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE uuid = NEW.uuid;
END`,
    );
  }

  return stmts;
}

/**
 * 当前结构版本。
 *   v1 = 有 batches 表
 *   v2 = 批次并入 items（一行 = 一件东西）
 *   v3 = 加 parent_uuid（批量物品的「一组库存」子行）、取消编号与到期类型
 *   v4 = 分类可留空（未分类）、加 sort_order（手动顺序）
 *   v5 = 加 model（型号，与 spec 规格分开）
 *   v6 = 加 extra_json（补充信息，扁平 JSON）
 *   v7 = 取消 alert_level（改成按日期来源自动分「过期 / 过保」）
 *   v8 = 加 code 的内部定位约束、sort_order 回填
 *   v9 = 取消 room（房间太细），位置只留 container 一个自由文本字段
 */
export const SCHEMA_VERSION = 9;
