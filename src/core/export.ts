/**
 * 导出工作区 → 一个 zip 归档。
 *
 * 归档结构：
 *   manifest.json      机器可读的完整结构说明（由 fields.ts 派生）
 *   README.md          人可读的字段说明（由同一份 manifest 渲染）
 *   checksums.txt      每个文件的 sha256
 *   tables/*.csv       每张表一个 CSV
 *   attachments/       照片等附件（可选）
 *   import_report.json 该工作区当初是怎么来的（若是导入创建）
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { openDatabase, selectAll, countRows, verifyDatabase, backupTo } from './db';
import { TABLES } from './fields';
import { EXPORT_TABLE_ORDER } from './fields';
import { serializeCsv, rawToCell } from './csv';
import { buildManifest, manifestColumnsForExport, type Manifest } from './manifest';
import { workspaceDir, workspaceDbPath, type WorkspaceEntry } from './workspace';
import { nowIso } from './dates';
import { ensureDir, sha256File, walkFiles, copyInto } from './util';
import { zipDirectory, archiveToolAvailable, ZipError } from './zip';

export interface ExportResult {
  archivePath: string;
  bytes: number;
  workspace: { id: string; name: string };
  rowCounts: Record<string, number>;
  fileCount: number;
  exportedAt: string;
  files: string[];
}

export interface ExportOptions {
  /** 输出 zip 路径。默认 dataDir/exports/<name>-<时间戳>.zip */
  outPath?: string;
  /** 是否包含 attachments（默认 true） */
  includeAttachments?: boolean;
  /** 导出前先做一次库内一致性检查，失败则中止（默认 true） */
  verify?: boolean;
}

function defaultOutPath(dataDir: string, entry: WorkspaceEntry, at: Date): string {
  const safeName = entry.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || entry.id;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return join(dataDir, 'exports', `${safeName}-${stamp}.zip`);
}

export function exportWorkspace(
  dataDir: string,
  entry: WorkspaceEntry,
  opts: ExportOptions = {},
): ExportResult {
  if (!archiveToolAvailable()) {
    throw new ZipError('找不到 tar.exe，无法生成归档（见 src/core/zip.ts 的说明）');
  }

  const at = new Date();
  const exportedAt = nowIso(at);
  const archivePath = resolve(opts.outPath ?? defaultOutPath(dataDir, entry, at));

  const wsDir = workspaceDir(dataDir, entry);
  const dbPath = workspaceDbPath(dataDir, entry);
  if (!existsSync(dbPath)) {
    throw new Error(`工作区数据库不存在: ${dbPath}`);
  }

  // 暂存目录放在目标归档旁边，避免跨盘 rename
  const stage = join(dirname(archivePath), `.stage-${entry.id}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  ensureDir(stage);
  ensureDir(join(stage, 'tables'));

  const db = openDatabase(dbPath, { readOnly: true, skipMigrate: true });
  try {
    if (opts.verify !== false) {
      const v = verifyDatabase(db);
      if (!v.ok) {
        throw new Error(`导出前自检未通过，已中止：${v.messages.join('；')}`);
      }
    }

    const rowCounts: Record<string, number> = {};
    for (const t of EXPORT_TABLE_ORDER) rowCounts[t] = countRows(db, t);

    const wsInfo: Manifest['workspace'] = {
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
      source: entry.source,
    };
    if (entry.notes) wsInfo.notes = entry.notes;
    if (entry.sourceArchive) wsInfo.notes = [wsInfo.notes, `来源归档: ${entry.sourceArchive}`].filter(Boolean).join(' · ');

    const manifest = buildManifest({ workspace: wsInfo, rowCounts, exportedAt });

    // ── CSV ──
    for (const tableName of EXPORT_TABLE_ORDER) {
      const def = TABLES.find((t) => t.name === tableName);
      if (!def) continue;
      const cols = manifestColumnsForExport(tableName);
      const header = cols.map((c) => c.name);
      const rows = selectAll(db, tableName);
      const body = rows.map((row) => cols.map((c) => rawToCell(row[c.name] ?? null)));
      const csv = serializeCsv(header, body);
      writeFileSync(join(stage, 'tables', `${tableName}.csv`), csv, 'utf8');
    }

    // ── 附件 ──
    const attSrc = join(wsDir, 'attachments');
    if (opts.includeAttachments !== false && existsSync(attSrc)) {
      for (const rel of walkFiles(attSrc)) {
        copyInto(join(attSrc, rel), join(stage, 'attachments', rel));
      }
    }

    // ── 来源审计（若有）──
    const reportSrc = join(wsDir, 'import_report.json');
    if (existsSync(reportSrc)) {
      writeFileSync(join(stage, 'import_report.json'), readFileSync(reportSrc, 'utf8'), 'utf8');
    }

    // ── manifest / README ──
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    writeFileSync(join(stage, 'README.md'), renderReadme(manifest), 'utf8');

    // ── checksums（最后算，覆盖除自身以外的全部文件）──
    const files = walkFiles(stage);
    const checksumLines = files.map((rel) => `${sha256File(join(stage, rel))}  ${rel}`);
    writeFileSync(join(stage, 'checksums.txt'), checksumLines.join('\n') + '\n', 'utf8');

    const allFiles = walkFiles(stage);
    zipDirectory(stage, archivePath);
    rmSync(stage, { recursive: true, force: true });

    const bytes = existsSync(archivePath) ? readFileSync(archivePath).length : 0;

    return {
      archivePath,
      bytes,
      workspace: { id: entry.id, name: entry.name },
      rowCounts,
      fileCount: allFiles.length,
      exportedAt,
      files: allFiles,
    };
  } finally {
    db.close();
    rmSync(stage, { recursive: true, force: true });
  }
}

/** 把 manifest 渲染成人看的字段说明表 */
export function renderReadme(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push(`# ${manifest.workspace.name}`);
  lines.push('');
  lines.push('> 本文件由 DSH Inventory 自动生成。字段定义的权威来源是 `manifest.json`（机器可读），本文件是它的人可读渲染。');
  lines.push('');
  lines.push('## 归档概览');
  lines.push('');
  lines.push(`| 项 | 值 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 归档格式 | \`${manifest.format}\` v${manifest.formatVersion} |`);
  lines.push(`| 生成程序 | ${manifest.app} ${manifest.appVersion} |`);
  lines.push(`| 数据结构版本 | ${manifest.schemaVersion} |`);
  lines.push(`| 导出时间 | ${manifest.exportedAt} |`);
  lines.push(`| 工作区 id | \`${manifest.workspace.id}\` |`);
  lines.push(`| 工作区创建时间 | ${manifest.workspace.createdAt} |`);
  lines.push('');
  lines.push('### 行数');
  lines.push('');
  lines.push('| 表 | 说明 | 文件 | 行数 |');
  lines.push('| --- | --- | --- | --- |');
  for (const t of manifest.tables) {
    lines.push(`| \`${t.name}\` | ${t.label} | \`${t.file}\` | ${t.rowCountAtExport} |`);
  }
  lines.push('');
  lines.push('## CSV 约定');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 编码 | ${manifest.csv.encoding}${manifest.csv.bom ? '（带 BOM，Excel 打开中文不乱码）' : ''} |`);
  lines.push(`| 分隔符 | \`${manifest.csv.delimiter}\` |`);
  lines.push(`| 引号 | \`${manifest.csv.quote}\`（写出时所有字段均加引号） |`);
  lines.push(`| 换行 | ${manifest.csv.lineEnding} |`);
  lines.push(`| 空值哨兵 | \`${manifest.csv.nullLiteral}\` |`);
  lines.push('');
  lines.push(`> ${manifest.csv.note}`);
  lines.push('');
  lines.push('## 身份与隔离');
  lines.push('');
  lines.push(`- ${manifest.identity.note}`);
  lines.push('');
  for (const n of manifest.notes ?? []) lines.push(`- ${n}`);
  lines.push('');

  for (const t of manifest.tables) {
    lines.push(`## 表 \`${t.name}\` — ${t.label}`);
    lines.push('');
    if (t.naturalKey) lines.push(`业务唯一键：\`${t.naturalKey.join(', ')}\`　主键：\`${t.primaryKey}\``);
    else lines.push(`主键：\`${t.primaryKey}\``);
    lines.push('');
    lines.push('| 列名 | 类型 | 中文名 | 必填 | 约束/取值 | 示例 | 说明 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of t.columns) {
      const constraints: string[] = [];
      if (c.enum && c.enumValues) {
        constraints.push(c.enumValues.map((e) => `\`${e.key}\`=${e.label}`).join(' / '));
      }
      if (c.format) constraints.push(c.format);
      if (c.min !== undefined) constraints.push(`≥ ${c.min}`);
      if (c.max !== undefined) constraints.push(`≤ ${c.max}`);
      if (c.maxLength !== undefined) constraints.push(`≤ ${c.maxLength} 字符`);
      if (c.references) constraints.push(`→ \`${c.references.table}.${c.references.column}\``);
      if (c.default !== undefined && c.default !== null) constraints.push(`默认 ${String(c.default)}`);
      lines.push(
        `| \`${c.name}\` | ${c.type} | ${c.label} | ${c.required ? '是' : ''} | ${
          constraints.join('<br>') || ''
        } | ${c.example ?? ''} | ${c.description ?? ''} |`,
      );
    }
    lines.push('');
  }

  lines.push('## 重新导入');
  lines.push('');
  lines.push('```bash');
  lines.push(`dsh-inv import "${basename('<本归档>')}" --name "${manifest.workspace.name}"`);
  lines.push('```');
  lines.push('');
  lines.push('导入会**新建**一个工作区，不会修改任何已有工作区。');
  lines.push('');
  return lines.join('\n');
}

export { backupTo };
