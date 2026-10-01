/** 小工具：sha256、文件复制、目录树遍历 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** 递归列出目录下所有文件（相对路径，正斜杠分隔） */
export function walkFiles(root: string, sub = ''): string[] {
  const base = sub ? join(root, sub) : root;
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const name of readdirSync(base)) {
    const full = join(base, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(root, sub ? join(sub, name) : name));
    } else {
      const rel = relative(root, full).split(sep).join('/');
      out.push(rel);
    }
  }
  return out.sort();
}

export function copyInto(srcFile: string, destFile: string): void {
  mkdirSync(dirname(destFile), { recursive: true });
  copyFileSync(srcFile, destFile);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
