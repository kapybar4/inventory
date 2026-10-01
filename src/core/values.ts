/**
 * 值转换：CSV 字符串 ↔ SQLite 绑定值 ↔ 内存值。
 *
 * 全部字段在内存与 CSV 中都是字符串模型（或 null），
 * 只有落库时才按 kind 转成 INTEGER。这样导入导出天然是对称的。
 */
import type { FieldKind } from './fields';
import { isDateString, isYearMonth, monthEnd } from './dates';
import { isUuid } from './ids';
import { rawToCell } from './csv';
export type CellValue = string | number | boolean | null;

export class FieldError extends Error {}

function parseBool(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', '是', '真'].includes(t)) return true;
  if (['0', 'false', 'no', 'n', '否', '假'].includes(t)) return false;
  return null;
}

export function formatBool(v: boolean): string {
  return v ? 'true' : 'false';
}

/**
 * CSV 字符串 → 标准化的字符串表示（仍非 SQLite 值）。
 * 返回 null 表示该字段为空（落库为 NULL）；空串按空值处理。
 * 校验失败抛 FieldError。
 */
export function normalizeFromCsv(raw: string | null, kind: FieldKind, fieldName: string): string | null {
  if (raw === null) return null;
  if (raw === '') return '';
  const t = raw.trim();
  return normalizeValue(t, kind, fieldName);
}

/**
 * 按字段类型规范化并校验一个值。
 *
 * 导入（normalizeFromCsv）与直接写入（insertRow / updateRow）共用这一份，
 * 这样命令行里打错一个日期也会被拦住，而不是把 `2027-02-30` 这种
 * 日历上不存在的日期写进库 —— 它会让后面所有到期计算都算出一个假的天数。
 *
 * 空串原样返回（表示「清空」），由写入层翻译成 NULL。
 */
export function normalizeValue(t: string, kind: FieldKind, fieldName: string): string {
  switch (kind) {
    case 'int':
    case 'money_cents': {
      const n = Number(t);
      if (!Number.isInteger(n)) {
        throw new FieldError(`${fieldName}: 期望整数，实际为 "${t}"`);
      }
      return String(n);
    }
    case 'bool': {
      const b = parseBool(t);
      if (b === null) throw new FieldError(`${fieldName}: 期望布尔值(true/false/1/0)，实际为 "${t}"`);
      return formatBool(b);
    }
    case 'date': {
      if (!isDateString(t)) throw new FieldError(`${fieldName}: 期望日期 YYYY-MM-DD，实际为 "${t}"`);
      return t;
    }
    case 'year_month': {
      if (!isYearMonth(t)) throw new FieldError(`${fieldName}: 期望年月 YYYY-MM，实际为 "${t}"`);
      return t;
    }
    case 'datetime': {
      if (Number.isNaN(Date.parse(t))) throw new FieldError(`${fieldName}: 期望 ISO 时间，实际为 "${t}"`);
      return new Date(t).toISOString();
    }
    case 'uuid': {
      const lower = t.toLowerCase();
      if (!isUuid(lower)) throw new FieldError(`${fieldName}: 期望 UUID，实际为 "${t}"`);
      return lower;
    }
    default:
      return t;
  }
}

/** 内存字符串表示 → SQLite 绑定值。空串按空值处理，与 CSV 语义保持一致。 */
export function toSqlValue(value: string | null, kind: FieldKind): string | number | null {
  if (value === null) return null;
  if (value === '') return null;
  switch (kind) {
    case 'int':
    case 'money_cents':
      return Number(value);
    case 'bool':
      return parseBool(value) ? 1 : 0;
    default:
      return value;
  }
}

/**
 * 写入前的字段校验：按字段定义检查类型与取值。
 *
 * `normalizeFromCsv` 一直在导入路径上做这件事，但命令行直接写库时绕过了它 ——
 * 结果 `--expires-on 2027-02-30` 会被原样收下，之后 `daysUntil` 算出一个
 * 凭空捏造的天数，提醒和时间轴都会跟着错。所以校验要放在写入层，
 * 让所有入口（CLI / 界面 / JSON 批量录入 / 导入）都拦得住。
 *
 * 校验失败抛 FieldError；空值与非字符串类型（布尔）跳过。
 */
export function validateFieldValue(
  value: string | null,
  kind: FieldKind,
  fieldName: string,
  enumName?: string,
  enums?: Record<string, { key: string }[]>,
): void {
  if (value === null || value === undefined || value === '') return;

  // 枚举：值必须在集合内
  if (enumName && enums) {
    const allowed = (enums[enumName] ?? []).map((e) => e.key);
    if (allowed.length > 0 && !allowed.includes(value)) {
      throw new FieldError(`${fieldName}: "${value}" 不在允许的取值里（${allowed.join(' / ')}）`);
    }
    return;
  }

  // 其余按 kind 的类型规则走，复用同一份规范化逻辑
  normalizeValue(value, kind, fieldName);
}

/** SQLite 值 → 内存字符串表示 */
export function fromSqlValue(value: unknown, kind: FieldKind): string | null {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'bool':
      return formatBool(value === 1 || value === true || value === '1' || value === 'true');
    case 'int':
    case 'money_cents':
      return String(value);
    default:
      return String(value);
  }
}

/** 内存字符串表示 → CSV 单元格（空值写空单元格） */
export function toCsvCell(value: string | null, _kind: FieldKind): string {
  return rawToCell(value);
}

/**
 * 派生列：写入前统一补齐。
 *
 * ── v3 的语义简化 ──
 * 不再有「到期类型」要用户选。只有两种状态：
 *   - 填了到期日 → 就是那一天
 *   - 没填       → 长期，不参与任何到期计算
 *
 * 但仍然要兼容旧数据里的年月：`expires_ym` 会被折算到当月最后一天
 * （宁可晚一天提示，也不误报「已经过期」），`expiry_precision`
 * 降级成内部字段，不再由用户选择。
 */
export function deriveExpiryColumns(
  values: Record<string, string | null>,
): Record<string, string | null> {
  const out = { ...values };
  const expiresOn = out['expires_on'];
  const expiresYm = out['expires_ym'];

  // 只给了年月 → 折算到当月最后一天
  if ((!expiresOn || expiresOn === '') && expiresYm && expiresYm !== '') {
    out['expires_on'] = monthEnd(expiresYm);
  }

  // 精度字段仍在库里（旧数据兼容），但只做归一，不再有业务含义
  out['expiry_precision'] = out['expires_on'] ? 'day' : 'none';

  if (!out['expires_on']) {
    out['expires_on'] = null;
    out['expires_ym'] = null;
  }

  return out;
}

/**
 * 「批量物品」不变量。
 *
 * 默认一件东西就是一件：非批量物品的数量恒为 1，剩余只可能是 1（在手上）
 * 或 0（已消耗）；最低库存对它没有意义，一并归零。
 *
 * **例外：「一组库存」的子行**。子行的 `is_bulk` 也是 false（它本身不是一个
 * 批量物品，而是一个数量段），但它的数量就是这一段的数量，必须原样保留。
 * 所以有 `parent_uuid` 时直接放行。
 *
 * 放在写入路径上强制，而不是只在界面上禁用输入 ——
 * 否则 CLI、导入、JSON 批量录入都能绕过这条规则，数据就不自洽了。
 *
 * `prev` 用于部分更新：没提交的字段沿用库里的值，避免把批量物品
 * 误判成非批量后把已设好的数量抹掉。
 */
export function normalizeBulkItem(
  values: Record<string, string | null>,
  prev?: Record<string, unknown> | null,
): Record<string, string | null> {
  const pick = (key: string): string | null => {
    const v = values[key];
    if (v !== undefined) return v;
    const p = prev?.[key];
    if (p === null || p === undefined) return null;
    return String(p);
  };

  // 库存子行：数量就是这一段的数量，不做任何钳制
  const parent = pick('parent_uuid');
  if (parent !== null && parent !== '') return values;

  const isBulk = (() => {
    const v = pick('is_bulk');
    if (v === null) return false; // 默认非批量
    return v === 'true' || v === '1';
  })();

  if (isBulk) {
    // 批量物品：数量缺省 1，剩余缺省等于数量
    if (pick('quantity') === null) values['quantity'] = '1';
    if (values['remaining'] === undefined && prev?.['remaining'] === undefined) {
      values['remaining'] = pick('quantity') ?? '1';
    }
    return values;
  }

  // 非批量：钉死为「一件」
  values['quantity'] = '1';
  const remaining = pick('remaining');
  const n = Number(remaining ?? '1');
  values['remaining'] = String(Number.isFinite(n) && n > 0 ? 1 : 0);
  values['min_stock'] = '0';
  return values;
}

/** 非批量物品是否算「已消耗完」——一键清理就是按这个筛的 */
export function isSpentNonBulk(row: Record<string, unknown>): boolean {
  const bulk = row['is_bulk'] === 'true' || row['is_bulk'] === 1 || row['is_bulk'] === true;
  if (bulk) return false;
  return Number(row['remaining'] ?? 0) <= 0;
}

/** 金额展示：整数分 → 元字符串 */
export function centsToYuan(cents: number | string | null): string {
  if (cents === null || cents === '') return '';
  const n = typeof cents === 'string' ? Number(cents) : cents;
  if (!Number.isFinite(n)) return '';
  return (n / 100).toFixed(2);
}

/** 元字符串 → 整数分 */
export function yuanToCents(yuan: string | number | null): number | null {
  if (yuan === null || yuan === '') return null;
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
