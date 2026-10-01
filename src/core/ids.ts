/**
 * UUIDv7 —— 时间有序的全局唯一主键。
 * 前 48 位是毫秒时间戳，所以字典序 == 创建序，索引局部性好，
 * 并且跨工作区、跨导入导出碰撞概率可忽略。
 */
import { randomBytes } from 'node:crypto';

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48 位毫秒时间戳（big-endian）
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // 版本 7
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // variant 10xx
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** 从 v7 UUID 里取回毫秒时间戳；非 v7 返回 null */
export function uuidv7Time(uuid: string): number | null {
  if (!isUuid(uuid)) return null;
  const hex = uuid.replace(/-/g, '');
  if (hex[12] !== '7') return null;
  return parseInt(hex.slice(0, 12), 16);
}

/** 工作区 id：短、可读、按创建时间有序 */
export function workspaceId(now: number = Date.now()): string {
  const ts = now.toString(36);
  const rand = randomBytes(3).toString('hex');
  return `ws_${ts}${rand}`;
}
