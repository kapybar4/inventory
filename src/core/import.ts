/**
 * 导入归档 → **新建**工作区。
 *
 * 这是整个设计的支点：因为导入永远是「新建」，所以
 *   - 不存在合并冲突、不存在「谁的 updated_at 更新」
 *   - 不需要半途回滚：任何一步失败就删掉刚建的目录，等于什么都没发生
 *   - 不会破坏任何已有工作区（物理隔离在不同目录里）
 *
 * 校验与落库分两阶段：先全量校验（不写库），通过后才真正写入。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { ENUMS, EXPORT_TABLE_ORDER, TABLES, tableDef, type FieldDef } from './fields';
import { cellToRaw, parseCsv, serializeCsv, rawToCell } from './csv';
import { FieldError, deriveExpiryColumns, normalizeFromCsv } from './values';
import { validateManifest, type Manifest, type ManifestTable } from './manifest';
import { openDatabase, insertRow, countRows, transaction, nextItemCode, verifyDatabase } from './db';
import {
  prepareImportedWorkspace,
  discardWorkspaceDir,
  registerWorkspace,
  workspaceDbPath,
  readRegistry,
  removeWorkspace,
  markImporting,
  quarantineWorkspace,
  unquarantineWorkspace,
} from './workspace';
import { nowIso, isDateString, monthEnd } from './dates';
import { readJson, sha256File } from './util';
import { unzipTo, zipDirectory, ZipError } from './zip';
import { APP_VERSION } from './meta';
import { uuidv7 } from './ids';

export interface ImportIssue {
  table: string;
  /** CSV 文件中的行号（含表头，1-based）；0 表示整表/整包级别 */
  line: number;
  level: 'error' | 'warning';
  message: string;
}

export interface TablePreview {
  table: string;
  rows: number;
  errors: number;
  warnings: number;
}

export interface ImportPreview {
  sourcePath: string;
  manifest: Manifest;
  workspaceName: string;
  tables: TablePreview[];
  issues: ImportIssue[];
  errorCount: number;
  warningCount: number;
  totalRows: number;
  checksumVerified: boolean;
}

export interface ImportOptions {
  dataDir: string;
  /** 覆盖工作区名；默认取 manifest.workspace.name */
  name?: string;
  /** 只校验不落库 */
  dryRun?: boolean;
  /** 固定工作区 id，便于测试 */
  id?: string;
  /** 导入后是否登记进注册表（默认 true） */
  register?: boolean;
  /** 临时解包根目录，默认系统 temp */
  tempRoot?: string;
}

export interface ImportResult {
  ok: boolean;
  workspaceId: string | null;
  workspaceName: string;
  dbPath: string | null;
  rowCounts: Record<string, number>;
  preview: ImportPreview;
  reportPath: string | null;
  tookMs: number;
  /** 导入后自检没过，已被隔离 */
  quarantined?: boolean;
  quarantineReason?: string;
}

/** 多工作区包导入的结果：每个子工作区一条 */
export interface MultiImportItem {
  /** 归档里的子目录名 */
  dir: string;
  name: string;
  ok: boolean;
  workspaceId: string | null;
  rowCounts: Record<string, number>;
  /** 失败原因（`ok: false` 时有） */
  error?: string;
}

export interface MultiImportResult {
  ok: boolean;
  /** 是不是多工作区包（false 表示按单工作区处理了） */
  multi: boolean;
  items: MultiImportItem[];
  total: number;
  succeeded: number;
  failed: number;
  tookMs: number;
}

// ─────────────────────────────────────────────────────────────
// 解析层
// ─────────────────────────────────────────────────────────────

interface ParsedTable {
  manifestTable: ManifestTable;
  header: string[];
  /** 每行已规范化为字符串模型（null = 未提供） */
  rows: Record<string, string | null>[];
  /** 原始行号（1-based，含表头） */
  lineNumbers: number[];
}

interface LoadedArchive {
  tables: ParsedTable[];
  manifest: Manifest;
  checksumsOk: boolean;
  issues: ImportIssue[];
}

function loadArchiveInto(stage: string): LoadedArchive {
  const issues: ImportIssue[] = [];

  const manifestPath = join(stage, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('归档中缺少 manifest.json —— 这不是一个有效的导出包');
  }

  const validation = validateManifest(readJson<unknown>(manifestPath));
  for (const e of validation.errors) issues.push({ table: '-', line: 0, level: 'error', message: e });
  for (const w of validation.warnings) issues.push({ table: '-', line: 0, level: 'warning', message: w });
  if (!validation.ok || !validation.manifest) {
    return { tables: [], manifest: {} as Manifest, checksumsOk: false, issues };
  }
  const manifest = validation.manifest;

  // ── checksums ──
  let checksumsOk = false;
  const checksumPath = join(stage, manifest.integrity?.file ?? 'checksums.txt');
  if (existsSync(checksumPath)) {
    try {
      checksumsOk = verifyChecksums(stage, checksumPath, issues);
    } catch (err) {
      issues.push({
        table: '-',
        line: 0,
        level: 'warning',
        message: `校验和验证失败: ${(err as Error).message}`,
      });
    }
  } else {
    issues.push({ table: '-', line: 0, level: 'warning', message: '归档缺少 checksums.txt，跳过完整性校验' });
  }

  // ── 按表解析 ──
  const tables: ParsedTable[] = [];
  for (const mt of manifest.tables) {
    const def = TABLES.find((t) => t.name === mt.name);
    if (!def) {
      issues.push({ table: mt.name, line: 0, level: 'warning', message: `当前版本不认识表 ${mt.name}，已跳过` });
      continue;
    }
    const csvPath = join(stage, mt.file);
    if (!existsSync(csvPath)) {
      if (mt.name === 'stock_moves') {
        issues.push({ table: mt.name, line: 0, level: 'warning', message: `${mt.file} 不存在，该表将为空` });
        tables.push({ manifestTable: mt, header: [], rows: [], lineNumbers: [] });
        continue;
      }
      issues.push({ table: mt.name, line: 0, level: 'error', message: `缺少数据文件 ${mt.file}` });
      continue;
    }

    tables.push(parseTableCsv(mt, def.fields, readFileSync(csvPath, 'utf8'), issues));
  }

  return { tables, manifest, checksumsOk, issues };
}

function verifyChecksums(stage: string, checksumPath: string, issues: ImportIssue[]): boolean {
  const text = readFileSync(checksumPath, 'utf8');
  let checked = 0;
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(t);
    if (!m) continue;
    const expected = m[1]!;
    const rel = m[2]!;
    const file = join(stage, rel);
    if (!existsSync(file)) {
      issues.push({ table: '-', line: 0, level: 'warning', message: `校验和清单里的文件缺失: ${rel}` });
      bad += 1;
      continue;
    }
    if (sha256File(file) !== expected) {
      issues.push({
        table: '-',
        line: 0,
        level: 'error',
        message: `文件校验和不匹配（可能被修改或损坏）: ${rel}`,
      });
      bad += 1;
    }
    checked += 1;
  }
  return bad === 0 && checked > 0;
}

function parseTableCsv(
  mt: ManifestTable,
  fields: FieldDef[],
  text: string,
  issues: ImportIssue[],
): ParsedTable {
  const parsed = parseCsv(text);
  for (const iss of parsed.issues) {
    issues.push({ table: mt.name, line: iss.line, level: 'warning', message: iss.message });
  }

  const header = parsed.header;
  const declared = new Map(fields.filter((f) => !f.internal).map((f) => [f.name, f]));

  const colIndex = new Map<string, number>();
  for (let i = 0; i < header.length; i += 1) {
    const name = header[i]!;
    if (declared.has(name)) colIndex.set(name, i);
    else if (name !== '') {
      issues.push({ table: mt.name, line: 1, level: 'warning', message: `忽略未知列 "${name}"` });
    }
  }

  const required = fields.filter((f) => f.required && !f.internal && f.name !== 'uuid');
  for (const f of required) {
    if (!colIndex.has(f.name)) {
      issues.push({
        table: mt.name,
        line: 1,
        level: 'error',
        message: `缺少必需列 "${f.name}"（${f.label}）`,
      });
    }
  }

  const rows: Record<string, string | null>[] = [];
  const lineNumbers: number[] = [];

  for (let r = 0; r < parsed.rows.length; r += 1) {
    const raw = parsed.rows[r]!;
    const lineNo = r + 2; // +1 表头，+1 转 1-based
    const out: Record<string, string | null> = {};
    let rowOk = true;

    for (const [name, idx] of colIndex) {
      const f = declared.get(name)!;
      try {
        out[name] = normalizeFromCsv(cellToRaw(raw[idx]), f.kind, `${mt.name}.${name}`);
      } catch (err) {
        rowOk = false;
        issues.push({
          table: mt.name,
          line: lineNo,
          level: 'error',
          message: err instanceof FieldError ? err.message : String(err),
        });
      }
    }
    if (!rowOk) continue;

    for (const f of required) {
      const v = out[f.name];
      if (v === null || v === undefined || v === '') {
        rowOk = false;
        issues.push({
          table: mt.name,
          line: lineNo,
          level: 'error',
          message: `必填列 "${f.name}"（${f.label}）为空`,
        });
      }
    }
    if (!rowOk) continue;

    for (const [name, value] of Object.entries(out)) {
      const f = declared.get(name);
      if (!f) continue;
      if (f.enumName && value !== null && value !== '') {
        const allowed = (ENUMS[f.enumName] ?? []).map((e) => e.key);
        if (!allowed.includes(value)) {
          rowOk = false;
          issues.push({
            table: mt.name,
            line: lineNo,
            level: 'error',
            message: `列 "${name}" 取值 "${value}" 不在允许集合内: ${allowed.join(', ')}`,
          });
        }
      }
      if (f.kind === 'date' && value !== null && value !== '' && !isDateString(value)) {
        rowOk = false;
        issues.push({
          table: mt.name,
          line: lineNo,
          level: 'error',
          message: `列 "${name}" 不是合法日期: "${value}"`,
        });
      }
    }
    if (!rowOk) continue;

    // 派生：remaining 缺省等于 quantity；到期列统一补齐
    if (mt.name === 'items') {
      if (!out['quantity']) out['quantity'] = '1';
      if (out['remaining'] === null || out['remaining'] === undefined || out['remaining'] === '') {
        out['remaining'] = out['quantity'];
      }
      Object.assign(out, deriveExpiryColumns(out));
      const eo = out['expires_on'];
      const ym = out['expires_ym'];
      if ((eo === null || eo === undefined || eo === '') && ym) {
        out['expires_on'] = monthEnd(ym);
      }
    }

    rows.push(out);
    lineNumbers.push(lineNo);
  }

  return { manifestTable: mt, header, rows, lineNumbers };
}

// ─────────────────────────────────────────────────────────────
// 引用与唯一性检查（写库前做，报错比 SQLite 的约束异常清楚得多）
// ─────────────────────────────────────────────────────────────

function checkReferences(tables: ParsedTable[], issues: ImportIssue[]): void {
  const byName = new Map(tables.map((t) => [t.manifestTable.name, t]));

  for (const t of tables) {
    const mt = t.manifestTable;
    const def = tableDef(mt.name);
    const fkFields = def.fields.filter((f) => f.references && !f.internal);

    for (const fk of fkFields) {
      const parentName = fk.references!.table;
      const parent = byName.get(parentName);
      if (!parent) continue;
      if (!t.header.includes(fk.name)) continue;

      const pkName = fk.references!.column;
      const parentCol = parent.manifestTable.columns.find((c) => c.name === pkName);
      if (!parentCol?.exported) continue; // 父表键未导出，交给数据库层

      const known = new Set<string>();
      for (const row of parent.rows) {
        const v = row[pkName];
        if (v) known.add(v);
      }

      for (let r = 0; r < t.rows.length; r += 1) {
        const v = t.rows[r]![fk.name];
        if (v === null || v === undefined || v === '') continue;
        if (!known.has(v)) {
          issues.push({
            table: mt.name,
            line: t.lineNumbers[r] ?? r + 2,
            level: 'error',
            message: `引用不存在: ${fk.name} = "${v}" 在 ${parentName} 中找不到`,
          });
        }
      }
    }
  }
}

function checkUniqueCodes(tables: ParsedTable[], issues: ImportIssue[]): void {
  const items = tables.find((t) => t.manifestTable.name === 'items');
  if (!items) return;
  const seen = new Map<string, number>();
  for (let r = 0; r < items.rows.length; r += 1) {
    const code = items.rows[r]!['code'];
    if (!code) continue;
    const lineNo = items.lineNumbers[r] ?? r + 2;
    const prev = seen.get(code);
    if (prev !== undefined) {
      issues.push({
        table: 'items',
        line: lineNo,
        level: 'error',
        message: `物品编码重复: "${code}"（首次出现于第 ${prev} 行）`,
      });
    } else {
      seen.set(code, lineNo);
    }
  }
}

function buildPreview(
  src: string,
  manifest: Manifest,
  tables: ParsedTable[],
  issues: ImportIssue[],
  checksumsOk: boolean,
  workspaceName: string,
): ImportPreview {
  return {
    sourcePath: src,
    manifest,
    workspaceName,
    tables: tables.map((t) => ({
      table: t.manifestTable.name,
      rows: t.rows.length,
      errors: issues.filter(
        (i) => i.table === t.manifestTable.name && i.level === 'error' && i.line > 1,
      ).length,
      warnings: issues.filter((i) => i.table === t.manifestTable.name && i.level === 'warning').length,
    })),
    issues,
    errorCount: issues.filter((i) => i.level === 'error').length,
    warningCount: issues.filter((i) => i.level === 'warning').length,
    totalRows: tables.reduce((n, t) => n + t.rows.length, 0),
    checksumVerified: checksumsOk,
  };
}

// ─────────────────────────────────────────────────────────────
// 预览与执行
// ─────────────────────────────────────────────────────────────

/** 只读预演：完全不落库，用于 `--dry-run` 与 UI 的导入确认 */
export function previewArchive(
  archivePath: string,
  opts: { tempRoot?: string; name?: string } = {},
): ImportPreview {
  const src = resolve(archivePath);
  if (!existsSync(src)) throw new Error(`归档不存在: ${src}`);

  const tempBase = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'dsh-inv-preview-'));
  const stage = join(tempBase, 'unpacked');
  try {
    unzipTo(src, stage);
    const { tables, manifest, checksumsOk, issues } = loadArchiveInto(stage);
    checkReferences(tables, issues);
    checkUniqueCodes(tables, issues);
    const fallback = manifest.workspace?.name ?? basename(src).replace(/\.zip$/i, '');
    return buildPreview(src, manifest, tables, issues, checksumsOk, opts.name?.trim() || fallback);
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
}

export function importArchive(archivePath: string, opts: ImportOptions): ImportResult {
  const started = Date.now();
  const src = resolve(archivePath);
  if (!existsSync(src)) throw new Error(`归档不存在: ${src}`);

  const tempBase = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'dsh-inv-import-'));
  const stage = join(tempBase, 'unpacked');

  let created: ReturnType<typeof prepareImportedWorkspace> | null = null;

  try {
    unzipTo(src, stage);
    const { tables, manifest, checksumsOk, issues } = loadArchiveInto(stage);
    checkReferences(tables, issues);
    checkUniqueCodes(tables, issues);

    const workspaceName =
      opts.name?.trim() || manifest.workspace?.name || basename(src).replace(/\.zip$/i, '');
    const preview = buildPreview(src, manifest, tables, issues, checksumsOk, workspaceName);

    // 有错误就停在这里，绝不落库
    if (preview.errorCount > 0) {
      return {
        ok: false,
        workspaceId: null,
        workspaceName,
        dbPath: null,
        rowCounts: {},
        preview,
        reportPath: null,
        tookMs: Date.now() - started,
      };
    }

    if (opts.dryRun) {
      return {
        ok: true,
        workspaceId: null,
        workspaceName,
        dbPath: null,
        rowCounts: {},
        preview,
        reportPath: null,
        tookMs: Date.now() - started,
      };
    }

    // ── 建新工作区 ──
    //
    // 注册表登记**先标 importing**，全部写完并自检通过后才置回 ok。
    // 这一条是"宕机后能识别出坏工作区"的全部依据：中途崩了、断电了、
    // 被强杀了，注册表里就留着 `importing`，下次打开就能看到它有问题。
    //
    // 只靠 integrity_check 是不够的 —— SQLite 本身完全健康，但数据可能只写了一半
    // （附件拷贝、报告写入都在事务之外）。
    const prepareOpts: { name: string; sourceArchive: string; id?: string } = {
      name: workspaceName,
      sourceArchive: basename(src),
    };
    if (opts.id) prepareOpts.id = opts.id;
    created = prepareImportedWorkspace(opts.dataDir, prepareOpts);
    if (opts.register !== false) {
      registerWorkspace(opts.dataDir, created.entry, false);
      markImporting(opts.dataDir, created.entry.id);
    }

    const dbPath = workspaceDbPath(opts.dataDir, created.entry);
    const db = openDatabase(dbPath);
    const rowCounts: Record<string, number> = {};

    try {
      transaction(db, () => {
        // 内部标识按分类前缀重新生成：导出包里已经没有它了，
        // 但命令行要靠它定位，所以导入时必须补一个唯一的。
        // 生成规则委托给 core 的 nextItemCode —— 只留一份实现
        const nextCode = (category: string): string => nextItemCode(db, category);

        for (const tableName of EXPORT_TABLE_ORDER) {
          const t = tables.find((x) => x.manifestTable.name === tableName);
          if (!t) continue;
          const def = tableDef(tableName);
          const fieldByName = new Map(def.fields.map((f) => [f.name, f]));

          for (const row of t.rows) {
            const values: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(row)) {
              const f = fieldByName.get(k);
              if (!f) continue;
              // parent_uuid 虽然标了 internal，但它是**结构**不是元数据，
              // 必须原样带过去，否则「一组库存」的父子关系会在导入后断掉
              if (f.internal && k !== 'parent_uuid') continue;
              values[k] = v;
            }
            // 保证 uuid 存在且被保留：包内的父子引用依赖它
            if (!values['uuid']) values['uuid'] = uuidv7();
            if (tableName === 'items' && !values['code']) {
              values['code'] = nextCode(values['category'] ?? 'other');
            }
            insertRow(db, tableName, values);
          }
          rowCounts[tableName] = countRows(db, tableName);
        }
      });
    } finally {
      db.close();
    }

    // ── 附件一并搬进工作区 ──
    const attSrc = join(stage, 'attachments');
    if (existsSync(attSrc)) {
      cpSync(attSrc, join(created.dir, 'attachments'), { recursive: true });
    }

    // ── 落 import_report.json，留审计线索 ──
    const report = {
      importedAt: nowIso(),
      appVersion: APP_VERSION,
      sourceArchive: src,
      sourceArchiveSha256: sha256File(src),
      workspaceId: created.entry.id,
      workspaceName,
      manifestFormatVersion: manifest.formatVersion,
      schemaVersion: manifest.schemaVersion,
      checksumVerified: checksumsOk,
      rowCounts,
      warnings: issues
        .filter((i) => i.level === 'warning')
        .map((i) => ({ table: i.table, line: i.line, message: i.message })),
    };
    const reportPath = join(created.dir, 'import_report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    // ── 数据自检：通过才解除 importing ──
    //
    // 写完了不等于写对了。这里真开一次库做完整性 + 外键 + 结构版本检查，
    // 不过就直接隔离并如实返回失败 —— 宁可让用户看到一个明确坏掉的工作区，
    // 也不要让他以为导入成功了、用几天才发现数据是缺的。
    const vdb = openDatabase(dbPath, { readOnly: true, skipMigrate: true });
    let verified: ReturnType<typeof verifyDatabase>;
    try {
      verified = verifyDatabase(vdb);
    } finally {
      vdb.close();
    }

    if (!verified.ok) {
      const reason = `导入后自检未通过：${verified.messages.join('；')}`;
      if (opts.register !== false) quarantineWorkspace(opts.dataDir, created.entry.id, reason);
      return {
        ok: false,
        workspaceId: created.entry.id,
        workspaceName,
        dbPath,
        rowCounts,
        preview,
        reportPath,
        tookMs: Date.now() - started,
        quarantined: true,
        quarantineReason: reason,
      };
    }

    if (opts.register !== false) {
      unquarantineWorkspace(opts.dataDir, created.entry.id);
    }

    return {
      ok: true,
      workspaceId: created.entry.id,
      workspaceName,
      dbPath,
      rowCounts,
      preview,
      reportPath,
      tookMs: Date.now() - started,
    };
  } catch (err) {
    // 失败即彻底清理：注册表里那条也要去掉，磁盘上不留半个工作区。
    // 用了 forgetOnly —— 数据本来就是残缺的，没必要为它留快照。
    if (created) {
      try {
        if (opts.register !== false) {
          const reg = readRegistry(opts.dataDir);
          if (reg.workspaces.some((w) => w.id === created!.entry.id)) {
            removeWorkspace(opts.dataDir, created.entry.id, { snapshot: false, forgetOnly: true });
          }
        }
        discardWorkspaceDir(opts.dataDir, created.dir);
      } catch {
        /* 清理失败不应掩盖原始错误 */
      }
    }
    if (err instanceof ZipError) throw err;
    throw err;
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
}

/**
 * 探测一个归档是不是多工作区包。
 *
 * 判据是**总 manifest 里的 `kind === 'multi'`**，不是"里面有几个目录"——
 * 靠目录数猜会在"单工作区恰好有个同名目录"时判错，而且以后加结构也没法扩展。
 */
export function detectMultiArchive(archivePath: string, tempRoot?: string): {
  multi: boolean;
  workspaces: { dir: string; name: string }[];
} {
  const src = resolve(archivePath);
  if (!existsSync(src)) throw new Error(`归档不存在: ${src}`);

  const tempBase = mkdtempSync(join(tempRoot ?? tmpdir(), 'dsh-inv-detect-'));
  const stage = join(tempBase, 'unpacked');
  try {
    unzipTo(src, stage);
    const manifestPath = join(stage, 'manifest.json');
    if (!existsSync(manifestPath)) return { multi: false, workspaces: [] };

    let raw: { kind?: unknown; workspaces?: unknown };
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof raw;
    } catch {
      return { multi: false, workspaces: [] };
    }
    if (raw.kind !== 'multi' || !Array.isArray(raw.workspaces)) {
      return { multi: false, workspaces: [] };
    }

    const workspaces: { dir: string; name: string }[] = [];
    for (const w of raw.workspaces as { dir?: unknown; name?: unknown }[]) {
      const dir = typeof w.dir === 'string' ? w.dir : '';
      // 目录名必须存在且不能往上跳，否则一个手改过的包能读到暂存目录之外
      if (dir === '' || dir.includes('..') || dir.includes('/') || dir.includes('\\')) continue;
      if (!existsSync(join(stage, 'workspaces', dir, 'manifest.json'))) continue;
      workspaces.push({ dir, name: typeof w.name === 'string' ? w.name : dir });
    }
    return { multi: true, workspaces };
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
}

/**
 * 导入归档 —— 单工作区与多工作区**走同一个入口**，自动识别。
 *
 * 多工作区包会分别建成多个独立工作区，一个失败不影响其它：
 * 每个子工作区各自建目录、各自标状态，失败的会被隔离并在结果里如实报出来。
 * 这样"导入一半宕机"留下的不是一团乱，而是若干个明确可辨的工作区。
 */
export function importAnything(archivePath: string, opts: ImportOptions): MultiImportResult {
  const started = Date.now();
  const detected = detectMultiArchive(archivePath, opts.tempRoot);

  if (!detected.multi) {
    const one = importArchive(archivePath, opts);
    return {
      ok: one.ok,
      multi: false,
      items: [
        {
          dir: '',
          name: one.workspaceName,
          ok: one.ok,
          workspaceId: one.workspaceId,
          rowCounts: one.rowCounts,
          error: one.ok ? undefined : one.quarantineReason ?? '导入未通过校验',
        },
      ],
      total: 1,
      succeeded: one.ok ? 1 : 0,
      failed: one.ok ? 0 : 1,
      tookMs: Date.now() - started,
    };
  }

  // 多工作区：逐个解包一次。每个子目录都是一个合法的单工作区归档，
  // 所以直接把子目录压成临时 zip 复用现成的 importArchive —— 不再写第二套写入逻辑。
  const tempBase = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'dsh-inv-multi-'));
  const stage = join(tempBase, 'unpacked');
  const items: MultiImportItem[] = [];

  try {
    unzipTo(resolve(archivePath), stage);

    for (const w of detected.workspaces) {
      const sub = join(stage, 'workspaces', w.dir);
      const subZip = join(tempBase, `${w.dir}.zip`);
      try {
        zipDirectory(sub, subZip);
        const r = importArchive(subZip, { ...opts, name: opts.name ? `${opts.name}-${w.name}` : w.name });
        items.push({
          dir: w.dir,
          name: w.name,
          ok: r.ok,
          workspaceId: r.workspaceId,
          rowCounts: r.rowCounts,
          error: r.ok ? undefined : r.quarantineReason ?? '导入未通过校验',
        });
      } catch (err) {
        // 一个坏了不影响其余 —— 已经建好的工作区保持原样
        items.push({
          dir: w.dir,
          name: w.name,
          ok: false,
          workspaceId: null,
          rowCounts: {},
          error: (err as Error).message,
        });
      }
    }
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }

  const succeeded = items.filter((i) => i.ok).length;
  return {
    ok: succeeded === items.length && items.length > 0,
    multi: true,
    items,
    total: items.length,
    succeeded,
    failed: items.length - succeeded,
    tookMs: Date.now() - started,
  };
}

/** 供测试与导出复用：把「字符串模型行」序列化成 CSV 文本 */
export function rowsToCsv(tableName: string, rows: Record<string, string | null>[]): string {
  const def = tableDef(tableName);
  const cols = def.fields.filter((f) => !f.internal);
  return serializeCsv(
    cols.map((c) => c.name),
    rows.map((r) => cols.map((c) => rawToCell(r[c.name] ?? null))),
  );
}
