/**
 * 日期与到期计算。
 *
 * 设计要点：
 *  - 全部用本地日期字符串（YYYY-MM-DD），不用 Date 对象做存储，避免时区漂移。
 *  - 「只到月份」的到期日统一取该月最后一天 —— 宁可晚一天提示，也不提前误报。
 *  - 天数差按「日历日」计算，不受时分秒影响。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const YM_RE = /^\d{4}-\d{2}$/;

export function isDateString(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  return toDate(v) !== null;
}

export function isYearMonth(v: string): boolean {
  if (!YM_RE.test(v)) return false;
  const m = Number(v.slice(5, 7));
  return m >= 1 && m <= 12;
}

/** 'YYYY-MM-DD' → 本地零点的 Date；非法返回 null */
export function toDate(v: string): Date | null {
  if (!DATE_RE.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  const dt = new Date(y, m - 1, d);
  // 反向校验，拦掉 2026-02-30 这类
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function fmtDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function today(now: Date = new Date()): string {
  return fmtDate(now);
}

/** 某年某月的天数 */
export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

/** 'YYYY-MM' → 该月最后一天 'YYYY-MM-DD' */
export function monthEnd(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = daysInMonth(y, m);
  return `${ym}-${String(last).padStart(2, '0')}`;
}

/**
 * 到期日的唯一计算入口。
 * 优先级：显式 expires_on > expires_ym（取月末）> null
 */
export function resolveExpiresOn(
  expiresOn: string | null | undefined,
  expiresYm: string | null | undefined,
  precision: string | null | undefined,
): string | null {
  if (expiresOn && isDateString(expiresOn)) return expiresOn;
  if (expiresYm && isYearMonth(expiresYm)) return monthEnd(expiresYm);
  if (precision === 'none') return null;
  return null;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 目标日 − 参考日，单位「天」。2026-01-01 到 2026-01-02 = 1 */
export function daysBetween(from: string, to: string): number | null {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

/** 距今天还有多少天（负数表示已过期） */
export function daysUntil(target: string, now: Date = new Date()): number | null {
  return daysBetween(today(now), target);
}

export function addDays(date: string, n: number): string | null {
  const d = toDate(date);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function addMonths(date: string, n: number): string | null {
  const d = toDate(date);
  if (!d) return null;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = daysInMonth(d.getFullYear(), d.getMonth() + 1);
  d.setDate(Math.min(day, last));
  return fmtDate(d);
}

/** 当前时间的 ISO 串（UTC，毫秒精度），与 strftime('%Y-%m-%dT%H:%M:%fZ') 同构 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export interface AlertLevel {
  level: 'ok' | 'watch' | 'warn' | 'urgent' | 'expired';
  label: string;
  /** 预警窗口（天） */
  leadDays: number;
  daysLeft: number | null;
}

/**
 * 分级规则：
 *   expired  已过期
 *   urgent   剩余 ≤ lead/3
 *   warn     剩余 ≤ lead
 *   watch    剩余 ≤ lead*2（提前量，便于安排采购而非紧急处理）
 *   ok       其余
 */
export function classifyExpiry(
  expiresOn: string | null,
  leadDays: number,
  now: Date = new Date(),
): AlertLevel {
  if (!expiresOn) {
    return { level: 'ok', label: '无到期', leadDays, daysLeft: null };
  }
  const left = daysUntil(expiresOn, now);
  if (left === null) {
    return { level: 'ok', label: '无到期', leadDays, daysLeft: null };
  }
  if (left < 0) return { level: 'expired', label: '已过期', leadDays, daysLeft: left };
  if (left <= Math.max(1, Math.floor(leadDays / 3))) {
    return { level: 'urgent', label: '紧急', leadDays, daysLeft: left };
  }
  if (left <= leadDays) return { level: 'warn', label: '临期', leadDays, daysLeft: left };
  if (left <= leadDays * 2) return { level: 'watch', label: '关注', leadDays, daysLeft: left };
  return { level: 'ok', label: '正常', leadDays, daysLeft: left };
}

export function formatDaysLeft(daysLeft: number | null): string {
  if (daysLeft === null) return '—';
  if (daysLeft < 0) return `已过期 ${-daysLeft} 天`;
  if (daysLeft === 0) return '今天到期';
  if (daysLeft < 30) return `剩 ${daysLeft} 天`;
  if (daysLeft < 365) return `剩 ${Math.floor(daysLeft / 30)} 个月`;
  return `剩 ${(daysLeft / 365).toFixed(1)} 年`;
}
