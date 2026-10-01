/**
 * SQLite 访问层。基于 Electron / Node 24 内置的 `node:sqlite`，
 * 因此**没有任何原生模块**：不需要 @electron/rebuild，不需要 asarUnpack，
 * 也不存在 Electron ABI 升级导致的重新编译问题。
 *
 * 每个工作区 = 一个独立的 .db 文件（见 workspace.ts）。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildDdl, ddlFromFields, SCHEMA_VERSION } from './schema';
import { EXPORT_TABLE_ORDER, ENUMS, TABLES, fieldNames, tableDef, type FieldDef } from './fields';
import {
  fromSqlValue,
  toSqlValue,
  deriveExpiryColumns,
  normalizeBulkItem,
  normalizeExtra,
  validateFieldValue,
  type CellValue,
} from './values';
import { uuidv7 } from './ids';
import { nowIso } from './dates';

export type SqlValue = string | number | null;

export interface Row {
  [column: string]: CellValue;
}

export interface DbOptions {
  /** 只读打开（用于验证、导出、统计、快照，避免误写） */
  readOnly?: boolean;
  /**
   * 打开时跳过结构迁移。
   * 默认值 = readOnly —— 只读打开却去跑 DDL 必然报
   * "attempt to write a readonly database"，所以让默认值就正确，
   * 需要显式改写法的调用方必须自己传 false。
   */
  skipMigrate?: boolean;
}

/**
 * 打开并初始化一个工作区数据库。
 * 幂等：已存在的库会走迁移而不是重建。
 */
export function openDatabase(dbPath: string, opts: DbOptions = {}): DatabaseSync {
  const readOnly = opts.readOnly ?? false;
  const skipMigrate = opts.skipMigrate ?? readOnly;

  if (!readOnly) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath, { readOnly });

  // ── pragma：顺序有讲究 ──
  // journal_mode 必须最先设，且不能在事务里改
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
  }
  // WAL 下 NORMAL 是安全与性能的平衡点：崩溃不丢已提交事务，只可能丢最后几个未提交的
  db.exec('PRAGMA synchronous = NORMAL');
  // SQLite 默认外键是 OFF，忘了开就等于约束不存在
  db.exec('PRAGMA foreign_keys = ON');
  // CLI 与 GUI 可能同时访问，宁可等一下也不要立刻报 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -16000');
  if (!readOnly && !existsSync(dbPath.replace(/\.db$/, '.vacuumed'))) {
    // auto_vacuum 只能在建库时设置，之后修改需要整库 VACUUM；这里尽力而为
    try {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    } catch {
      /* 已存在的库会忽略此设置，无妨 */
    }
  }

  if (!skipMigrate) migrate(db);
  return db;
}

/** 结构全部由 fields.ts 生成，所以迁移就是「确保结构与当前定义一致」 */
export function migrate(db: DatabaseSync): void {
  /**
   * 重建期间**关掉外键强制**。
   *
   * 当初是怎么坏的：`rebuildTable` 用「建新表 → 搬 → DROP 原表 → 改名」，
   * 而 `stock_moves.item_uuid` 上有 `ON DELETE CASCADE` ——
   * `DROP TABLE items` 于是把所有流水**连带删光**。
   * 迁移看起来成功了（自检全过），数据却少了，这是最难发现的一类 bug：
   * 它只在"有子表引用被重建的表"时发生，而 schema 升级恰好经常要重建 items。
   *
   * 关掉之后重建仍是安全的：搬过去的主键一个没变，
   * 重建前后引用关系都成立；迁移末尾的 `verifyDatabase` 还会跑一次
   * `PRAGMA foreign_key_check`，真有孤儿行会被抓出来。
   *
   * 注意 pragma 必须在事务**外**设置（SQLite 不允许在事务里改它），
   * 所以放在 BEGIN 之前，出错路径也要恢复。
   */
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    try {
      const from = schemaVersionOf(db);
      const isV1 = from > 0 && from < SCHEMA_VERSION && tableExists(db, 'batches');

      if (isV1) {
        // v1 不能直接跑 DDL：`CREATE TABLE IF NOT EXISTS items` 会静默跳过，
        // 旧 items 保持 v1 的窄结构，后面搬数据就会报 no such column。
        migrateV1ToV2(db);
      }

      // 顺序很重要：**先**把结构对齐到当前定义，**再**建索引与触发器。
      // 反过来的话，`CREATE INDEX ... ON items(parent_uuid)` 会因为列还不存在而抛错，
      // 整个迁移就停在这里了。
      rebuildOutdatedTables(db);
      for (const stmt of buildDdl()) db.exec(stmt);
      backfillSortOrder(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 给还没有手动顺序的记录补上 sort_order。
 *
 * 旧库里的记录 sort_order 全是 NULL，补的时候按 rowid（≈ 插入顺序）依次编号，
 * 这样「升级完看起来还是原来的顺序」，不会因为加了个字段就全部打乱。
 */
function backfillSortOrder(db: DatabaseSync): void {
  if (!tableExists(db, 'items')) return;
  const cols = columnsOf(db, 'items');
  if (!cols.includes('sort_order')) return;

  const pending = db
    .prepare('SELECT uuid FROM items WHERE sort_order IS NULL ORDER BY rowid ASC')
    .all() as { uuid: string }[];
  if (pending.length === 0) return;

  const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM items').get() as { m: number };
  let next = Number(maxRow.m ?? 0);

  const stmt = db.prepare('UPDATE items SET sort_order = ? WHERE uuid = ?');
  for (const r of pending) {
    next += 1;
    stmt.run(next, r.uuid);
  }
}

/** 表是否存在 */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
  return Boolean(row);
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => String(r.name));
}

/**
 * 结构与当前定义不一致的表，整张重建。
 *
 * ── 为什么不是 ALTER TABLE ADD COLUMN ──
 * SQLite 的 ADD COLUMN **加不了 NOT NULL 列**（除非带非空默认值）。
 * 我们有好几列是 NOT NULL 且没有默认值（code、parent_uuid、status…），
 * 逐列 ALTER 时它们会被静默跳过 —— 而如果那个 catch 把错误吞掉，
 * 结果就是「表看着在、列其实缺」，之后任何查询都会 `no such column`。
 *
 * 重建走标准的「建新表 → 搬数据 → 换名」，一次把结构对齐到定义：
 *   - 缺的列：用定义的默认值，没有默认值就给 NULL
 *   - 多的列：丢掉（旧版本遗留的字段）
 *   - 数据：按列名逐个搬，不依赖列顺序
 */
function rebuildOutdatedTables(db: DatabaseSync): void {
  for (const table of TABLES) {
    if (!tableExists(db, table.name)) continue;

    const existing = columnsOf(db, table.name);
    const wanted = table.fields.map((f) => f.name);
    const existingSet = new Set(existing);
    const missing = wanted.filter((n) => !existingSet.has(n));
    const extra = existing.filter((n) => !wanted.includes(n));
    if (missing.length === 0 && extra.length === 0) continue;

    rebuildTable(db, table.name, existing);
  }
}

/** 把 table 重建到当前定义，尽量保留 existing 里的数据 */
function rebuildTable(db: DatabaseSync, name: string, existing: string[]): void {
  const tmp = `${name}__rebuilt`;
  const def = TABLES.find((t) => t.name === name)!;

  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(ddlFromFields(tmp, def.fields, false));

  const existingSet = new Set(existing);

  /**
   * 每一列搬什么。
   *
   * 几种情况都要照顾到：
   *   - 两边都有的列 → 直接搬
   *   - 只有新表有的列 → **必须给个值**：新表那一列是 NOT NULL，
   *     光省略会 `NOT NULL constraint failed`
   *   - 两边都有、但**旧数据里是 NULL** 而新表要求 NOT NULL → 也要兜底
   *     （旧版本允许为空，新版本收紧了，这种历史数据一定会遇到）
   *
   * 兜底顺序：定义的默认值 → 可空列给 NULL → 必填列给空串/0。
   * 目标是「重建一定完成」—— 迁移半路失败比留个空值糟得多。
   *
   * 可空列刻意给 NULL 而不是空串：后续步骤要靠 NULL 认出「这条还没处理」，
   * 比如 sort_order 先留 NULL，再由回填按插入顺序补号。
   */
  const fallback = (f: (typeof def.fields)[number]): string => {
    if (f.default !== undefined) {
      if (typeof f.default === 'boolean') return f.default ? '1' : '0';
      if (typeof f.default === 'number') return String(f.default);
      return `'${String(f.default).replace(/'/g, "''")}'`;
    }
    if (!f.required) return 'NULL';
    return f.kind === 'int' || f.kind === 'money_cents' || f.kind === 'bool' ? '0' : "''";
  };

  const pick = (f: (typeof def.fields)[number]): string => {
    const fb = fallback(f);
    if (existingSet.has(f.name)) {
      // 新表要求 NOT NULL 时，把旧数据里的 NULL 兜住
      return f.required ? `COALESCE(${f.name}, ${fb})` : f.name;
    }
    return fb;
  };

  const targets: string[] = [];
  const sources: string[] = [];
  for (const f of def.fields) {
    targets.push(f.name);
    sources.push(pick(f));
  }

  db.exec(`INSERT INTO ${tmp} (${targets.join(', ')}) SELECT ${sources.join(', ')} FROM ${name}`);

  // updated_at 的触发器跟着表走，先删掉旧的免得重建后指向错表
  db.exec(`DROP TRIGGER IF EXISTS trg_${name}_updated_at`);
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${name}`);
}

/**
 * v1 → v2：把「一个物品 + 多个批次」展开成「多条独立物品」。
 *
 * 旧结构下，同一种药分两次买是两个批次；新结构下它们就是两条物品记录。
 *
 * 走标准的「建新表 → 搬数据 → 换名」，而不是往旧表里插 ——
 * 旧 items 表结构是 v1 的，缺少 barcode / status / remaining 等列。
 */
function migrateV1ToV2(db: DatabaseSync): void {
  const oldBatchCols = new Set(columnsOf(db, 'batches'));

  const itemsDef = TABLES.find((t) => t.name === 'items')!;
  const columns = itemsDef.fields.map((f) => f.name);

  // 临时的 v2 结构
  const tmp = 'items__v2';
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  const colDefs = columns.map((name) => {
    const f = itemsDef.fields.find((x) => x.name === name)!;
    const type = f.kind === 'int' || f.kind === 'money_cents' || f.kind === 'bool' ? 'INTEGER' : 'TEXT';
    const parts = [`${name} ${type}`];
    if (name === 'uuid') parts.push('PRIMARY KEY');
    return parts.join(' ');
  });
  db.exec(`CREATE TABLE ${tmp} (\n  ${colDefs.join(',\n  ')}\n)`);

  // 从批次搬到物品的列
  const FROM_BATCH = [
    'quantity',
    'remaining',
    'unit_price_cents',
    'amount_cents',
    'purchased_on',
    'expires_on',
    'expires_ym',
    'expiry_precision',
    'opened_on',
    'status',
    'store',
    'serial_no',
    'warranty_until',
    'notes',
    'photo_path',
  ].filter((c) => oldBatchCols.has(c) && columns.includes(c));

  const oldItems = db.prepare('SELECT * FROM items').all() as Record<string, unknown>[];
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const it of oldItems) byUuid.set(String(it['uuid']), it);

  const batches = db
    .prepare(`SELECT * FROM batches ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];

  const insertSql = `INSERT INTO ${tmp} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const stmt = db.prepare(insertSql);
  const now = nowIso();
  const usedCodes = new Set<string>();
  let seq = 0;

  const rowFor = (parent: Record<string, unknown>, batch: Record<string, unknown> | null): unknown[] =>
    columns.map((c) => {
      if (c === 'uuid') return batch ? batch['uuid'] : parent['uuid'];
      if (c === 'created_at') return String(batch?.['created_at'] ?? parent['created_at'] ?? now);
      if (c === 'updated_at') return String(batch?.['updated_at'] ?? parent['updated_at'] ?? now);
      if (c === 'code') {
        const base = String(parent['code'] ?? 'ITEM');
        let code = base;
        // 一个物品展开成多条时，后面的加后缀避免撞唯一索引
        if (usedCodes.has(code)) {
          seq += 1;
          code = `${base}-${seq}`;
          while (usedCodes.has(code)) {
            seq += 1;
            code = `${base}-${seq}`;
          }
        }
        usedCodes.add(code);
        return code;
      }
      if (batch && FROM_BATCH.includes(c)) {
        const v = batch[c];
        return v === undefined ? null : v;
      }
      /**
       * v1 的位置是 `room` + `container` 两级；现在合成一个自由文本字段。
       *
       * 老数据不能只留一半 —— 单写「客厅」太笼统，丢掉房间又会让"东西在哪"变模糊。
       * 拼起来最接近用户当初填那个意思（「客厅」+「药箱-上层」→「客厅药箱-上层」）。
       */
      if (c === 'container' && parent['room'] !== undefined && parent['room'] !== null) {
        const merged = [parent['room'], parent['container']].filter(Boolean).join('');
        return merged === '' ? null : merged;
      }
      const v = parent[c];
      if (v !== undefined) return v;
      // 旧表没有的列 → 用当前定义的默认值
      const f = itemsDef.fields.find((x) => x.name === c)!;
      if (f.default === undefined) return null;
      if (typeof f.default === 'boolean') return f.default ? 1 : 0;
      return f.default;
    });

  /**
   * 搬一行过去。
   *
   * 搬之前要过一遍写入层归一（到期派生 + 批量不变量）——
   * 否则 v1 里「数量 2」的批次会原样留下一个数量为 2 的普通物品，
   * 与「非批量物品数量恒为 1」这条不变量冲突。
   */
  const moveRow = (parent: Record<string, unknown>, batch: Record<string, unknown> | null): void => {
    const raw = rowFor(parent, batch);
    const obj: Record<string, string | null> = {};
    columns.forEach((c, i) => {
      const v = raw[i];
      obj[c] = v === undefined || v === null ? null : String(v);
    });
    Object.assign(obj, deriveExpiryColumns(obj));
    Object.assign(obj, normalizeBulkItem(obj));
    stmt.run(...(columns.map((c) => obj[c] ?? null) as never[]));
  };

  for (const batch of batches) {
    const parent = byUuid.get(String(batch['item_uuid']));
    if (!parent) continue;
    moveRow(parent, batch);
  }

  // 没有对应批次的物品也要保留下来
  const batchItemUuids = new Set(batches.map((b) => String(b['item_uuid'])));
  for (const item of oldItems) {
    if (batchItemUuids.has(String(item['uuid']))) continue;
    moveRow(item, null);
  }

  db.exec('DROP TABLE IF EXISTS items');
  db.exec('ALTER TABLE ' + tmp + ' RENAME TO items');
  db.exec('DROP TABLE IF EXISTS batches');
}

// ─────────────────────────────────────────────────────────────
// 自检与备份
// ─────────────────────────────────────────────────────────────

export function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export interface VerifyResult {
  /** 数据本身是否健康。**结构版本落后不算不健康** —— 那只是还没迁移 */
  ok: boolean;
  integrity: string;
  foreignKeyViolations: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  /** 库里的结构版本比当前定义旧，下次以可写方式打开会自动升级 */
  outdated?: boolean;
  tableCounts: Record<string, number>;
  messages: string[];
}

/**
 * 一致性自检：integrity_check + 外键检查 + 结构版本 + 表计数。
 * 导出前、备份前、以及 `ws verify` 都走这里。
 */
export function verifyDatabase(db: DatabaseSync): VerifyResult {
  const messages: string[] = [];

  const integrityRow = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined;
  const integrity = String(integrityRow ? Object.values(integrityRow)[0] : 'unknown');

  const fkRows = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
  const fkViolations = fkRows.length;

  const schemaVersion = schemaVersionOf(db);

  const tableCounts: Record<string, number> = {};
  for (const name of EXPORT_TABLE_ORDER) {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number } | undefined;
    tableCounts[name] = Number(r?.n ?? 0);
  }

  if (integrity !== 'ok') messages.push(`完整性检查失败: ${integrity}`);
  if (fkViolations > 0) messages.push(`存在 ${fkViolations} 条外键悬空记录`);

  /**
   * 结构版本落后**不算损坏**，只作为备注。
   *
   * 当初是怎么坏的：这里把版本不一致也算进 `messages`，而 `messages` 非空
   * 就等于 `ok: false`；`ws verify` 又对 `ok: false` 的工作区自动隔离。
   * 于是每次升 schema（比如取消 room 列这次）之后，
   * **所有工作区一起被锁死**，而且 `item list` 之类也读不了（它们同样跳过迁移），
   * 用户被自己的安全机制挡在门外。
   *
   * 版本落后是**正常状态**：迁移是懒执行的，库会在第一次以可写方式打开时
   * 自动升级。真正代表"数据坏了"的只有上面两条 —— 完整性、外键。
   */
  const outdated = schemaVersion !== SCHEMA_VERSION;
  if (outdated) {
    messages.push(`结构版本落后: 库内 ${schemaVersion}，当前定义 ${SCHEMA_VERSION}（下次可写打开时自动升级）`);
  }

  return {
    ok: integrity === 'ok' && fkViolations === 0,
    integrity,
    foreignKeyViolations: fkViolations,
    schemaVersion,
    expectedSchemaVersion: SCHEMA_VERSION,
    outdated,
    tableCounts,
    messages,
  };
}

/**
 * 整库快照。
 *
 * ⚠️ 这里**刻意不用 `node:sqlite` 的 `backup()`**：
 * 实测在 Windows 上它会**泄漏源库的文件句柄**，导致 `close()` 之后源库
 * 依然处于被占用状态、永远删不掉（`EPERM`）。而"删除工作区前留一份快照"
 * 正是最需要随后能删掉源库的场景。
 *
 * 改用字节拷贝。前提是拷贝时**没有其他写者**：
 *   - 本函数与调用方都在同一进程内串行执行，且调用前已 close 连接
 *   - WAL 下的 checkpoint 由本进程负责，空闲时主库文件即为最新状态
 * 若将来出现多进程同时写入的场景，需要换成「先 checkpoint 再拷」的方案。
 */
export function backupTo(db: DatabaseSync, targetPath: string): void {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const source = db.location();
  if (typeof source !== 'string' || source === ':memory:' || source === '') {
    throw new Error('backupTo 只支持文件型数据库');
  }

  // 拷贝前把 WAL 内容并回主库，保证单文件即完整快照
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* 只读连接无法 checkpoint，此时主库已是最新（无未提交写入） */
  }

  copyFileSync(source, targetPath);
}

// ─────────────────────────────────────────────────────────────
// 通用行读写
// ─────────────────────────────────────────────────────────────

function selectList(table: string, includeInternal: boolean): string {
  return fieldNames(tableDef(table), { includeInternal }).join(', ');
}

/**
 * 读行：**一律读全列**。
 *
 * 字段定义上的 `internal` 只表示「不进导出包」，跟数据库读取无关。
 * 早先这里按 internal 裁列，结果 `code` / `parent_uuid` 这类列在默认查询里
 * 凭空消失 —— 调用方拿到一个缺字段的对象，比多几个字段危险得多。
 * 裁剪导出列是 export.ts 的职责，不是这里的。
 */
export function selectAll(db: DatabaseSync, table: string, _opts: { includeInternal?: boolean } = {}): Row[] {
  const cols = selectList(table, true);
  const rows = db.prepare(`SELECT ${cols} FROM ${table}`).all() as Record<string, unknown>[];
  return rows.map((r) => rowFromSql(table, r));
}

export function selectWhere(
  db: DatabaseSync,
  table: string,
  where: string,
  params: SqlValue[],
  _opts: { includeInternal?: boolean } = {},
): Row[] {
  const cols = selectList(table, true);
  const rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${where}`).all(...params) as Record<string, unknown>[];
  return rows.map((r) => rowFromSql(table, r));
}

export function selectOne(
  db: DatabaseSync,
  table: string,
  where: string,
  params: SqlValue[],
  opts: { includeInternal?: boolean } = {},
): Row | null {
  const rows = selectWhere(db, table, where, params, opts);
  return rows[0] ?? null;
}

export function countRows(db: DatabaseSync, table: string): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return Number(r?.n ?? 0);
}

function rowFromSql(table: string, raw: Record<string, unknown>): Row {
  const def = tableDef(table);
  const out: Row = {};
  for (const f of def.fields) {
    if (!(f.name in raw)) continue;
    out[f.name] = fromSqlValue(raw[f.name], f.kind);
  }
  return out;
}

/**
 * 写入前的字段校验。
 *
 * 放在这一层而不是各个入口，是为了让 CLI、界面、JSON 批量录入、导入
 * 走同一套规则 —— 少写一处校验，就等于留了一个能写脏数据的口子。
 */
function validateRow(table: string, values: Record<string, string | null>): void {
  const def = tableDef(table);
  for (const f of def.fields) {
    const v = values[f.name];
    if (v === undefined) continue;
    // 把字段定义里的 validation 一并传下去 —— 否则 min/max 写了也没人执行
    validateFieldValue(v, f.kind, f.label || f.name, f.enumName, ENUMS, f.validation);
    // 有些类型除了校验还要**归一**：JSON 要排好键序再存，
    // 否则同一份内容会因为键顺序不同而在往返比较里"看起来变了"
    if (f.kind === 'json') values[f.name] = normalizeExtra(v);
  }
}

/**
 * 插入一行。values 用「内存字符串模型」表达：
 *   null / undefined / '' = 空值（NULL），列被省略，走列默认值
 *
 * 空串与 null 等价是刻意的：CSV 只有一种「空」的表达方式，
 * 若在此处区分，导出再导入就不再是恒等变换。
 */
export function insertRow(
  db: DatabaseSync,
  table: string,
  values: Record<string, string | null>,
): Row {
  const def = tableDef(table);
  const prepared = { ...values };
  if (table === 'items') {
    Object.assign(prepared, deriveExpiryColumns(prepared));
    Object.assign(prepared, normalizeBulkItem(prepared));
  }

  // 写入前先校验一遍：非法日期、超范围整数、越界枚举都在这里拦住
  validateRow(table, prepared);

  if (!prepared['uuid']) prepared['uuid'] = uuidv7();
  // 手动顺序：没指定就排到末尾，这样新加的东西总是出现在列表最后
  if (table === 'items' && prepared['sort_order'] === undefined) {
    const m = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM items').get() as { m: number } | undefined;
    prepared['sort_order'] = String(Number(m?.m ?? 0) + 1);
  }

  const names: string[] = [];
  const placeholders: string[] = [];
  const params: SqlValue[] = [];

  for (const f of def.fields) {
    if (f.name === 'created_at' || f.name === 'updated_at') continue;
    if (!(f.name in prepared)) continue;
    const v = prepared[f.name];
    // 空串按空值处理，避免数据库里出现 'NULL 与空串' 两种空
    if (v === null || v === undefined || v === '') continue;
    names.push(f.name);
    placeholders.push('?');
    params.push(toSqlValue(v, f.kind));
  }

  // 时间列由应用注入，避免依赖数据库本地时区
  const ts = nowIso();
  if (def.fields.some((f) => f.name === 'created_at')) {
    names.push('created_at');
    placeholders.push('?');
    params.push(ts);
  }
  if (def.fields.some((f) => f.name === 'updated_at')) {
    names.push('updated_at');
    placeholders.push('?');
    params.push(ts);
  }

  const sql = `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${selectList(table, true)}`;
  const row = db.prepare(sql).get(...params) as Record<string, unknown>;
  return rowFromSql(table, row);
}

/**
 * 部分更新。
 *
 * 三种写法语义不同，别混：
 *   - 字段不存在 / `undefined` → **不动这一列**
 *   - `null`                    → **显式清空**（写成 SQL NULL）
 *   - `''`                      → 也清空（与 CSV 的「空」语义一致）
 *
 * `null = 清空` 是刻意的：调用方要清一个值的时候只能表达成 null
 * （比如「设为长期」要清掉到期日、「关闭批量」要清掉最低库存）。
 * 如果把它当成「不动」，这些操作会**静默失效** —— 界面和命令都报成功，
 * 数据却没变，是最难查的那类 bug。
 *
 * 插入路径（insertRow）里 null 表示「走列默认值」，两者不冲突：
 * 新增时没有「旧值」可言，清空等于用默认值。
 */
export function updateRow(
  db: DatabaseSync,
  table: string,
  uuid: string,
  values: Record<string, string | null>,
): Row | null {
  const def = tableDef(table);
  const prepared = { ...values };

  if (table === 'items') {
    // 取旧值：既给批量不变量用（判断这是不是子行 / 是不是批量物品），
    // 也给到期派生用（只知道新给的 expires_ym 而不知道旧的 expires_on 时，
    // 没法判断该不该重新折算）
    const prev = db
      .prepare(
        `SELECT ${selectList('items', true)} FROM items WHERE uuid = ?`,
      )
      .get(uuid) as Record<string, unknown> | undefined;

    if (prev) {
      const prevRow = rowFromSql('items', prev);

      /**
       * 到期派生要在「旧值 + 新值」合并后的**有效状态**上做。
       *
       * 直接用 prepared 会出事：只改 `expires_ym` 时 `expires_on` 不在
       * prepared 里，派生函数会以为「没有到期日」从而把 expires_on 清空。
       *
       * 另一个坑：`deriveExpiryColumns` 只在 `expires_on` **为空**时才从年月折算，
       * 所以「改年月」时要把旧的 `expires_on` 先当成空，否则新年月会被直接丢掉。
       * 规则说到底是「更新的那个字段说了算」——
       * 只给年月 → 年月底定，日清掉；只给日期 → 日说了算。
       */
      const asText = (v: unknown): string | null =>
        v === null || v === undefined ? null : String(v);

      const touchedOn = 'expires_on' in prepared;
      const touchedYm = 'expires_ym' in prepared;

      const effExpiresOn = touchedYm && !touchedOn
        ? null // 只动了年月 → 让年月重新折算
        : asText(touchedOn ? prepared['expires_on'] : prevRow['expires_on']);
      const effExpiresYm = asText(touchedYm ? prepared['expires_ym'] : prevRow['expires_ym']);

      const derived = deriveExpiryColumns({ expires_on: effExpiresOn, expires_ym: effExpiresYm });

      // 只回写调用方碰过的列，再加必然联动的 expires_on
      prepared['expires_on'] = derived['expires_on'] ?? null;
      if (touchedYm) prepared['expires_ym'] = derived['expires_ym'] ?? null;
      if ('expiry_precision' in prepared) {
        prepared['expiry_precision'] = derived['expiry_precision'] ?? null;
      }

      Object.assign(prepared, normalizeBulkItem(prepared, prevRow));
    }
  }

  // 写入前先校验一遍：非法日期、超范围整数、越界枚举都在这里拦住
  validateRow(table, prepared);

  const sets: string[] = [];
  const params: SqlValue[] = [];

  for (const f of def.fields) {
    if (f.name === 'uuid' || f.name === 'created_at' || f.name === 'updated_at') continue;
    const v = prepared[f.name];
    if (v === undefined) continue; // 不动这一列
    sets.push(`${f.name} = ?`);
    // null 与 '' 都写成 NULL；其余按类型转换
    params.push(v === null ? null : toSqlValue(v, f.kind));
  }

  if (def.fields.some((f) => f.name === 'updated_at')) {
    sets.push('updated_at = ?');
    params.push(nowIso());
  }
  if (sets.length === 0) return selectOne(db, table, 'uuid = ?', [uuid], { includeInternal: true });

  params.push(uuid);
  const row = db
    .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE uuid = ? RETURNING ${selectList(table, true)}`)
    .get(...params) as Record<string, unknown> | undefined;
  return row ? rowFromSql(table, row) : null;
}

export function deleteRow(db: DatabaseSync, table: string, uuid: string): boolean {
  const r = db.prepare(`DELETE FROM ${table} WHERE uuid = ?`).run(uuid);
  return Number(r.changes) > 0;
}

export function findRowByUuid(db: DatabaseSync, table: string, uuid: string): Row | null {
  return selectOne(db, table, 'uuid = ?', [uuid]);
}

/** 事务包装。返回回调的返回值；抛错则整体回滚。 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function prepare(db: DatabaseSync, sql: string): StatementSync {
  return db.prepare(sql);
}

// ─────────────────────────────────────────────────────────────
// 领域查询
// ─────────────────────────────────────────────────────────────

/**
 * 顶层物品行的 SQL 条件：排除「一组库存」的子行。
 *
 * 库存条目也是 items 里的行（parent_uuid 指向父项），但在界面上它们属于
 * 父项的嵌套列，不该单独出现在列表、统计、提醒里。
 * 这一条是所有列表查询的公共前提，写成常量以免漏加。
 */
export const TOP_LEVEL = `(parent_uuid IS NULL OR parent_uuid = '')`;

/**
 * 把一组物品的 sort_order 按给定顺序重写。
 *
 * 拖动固定顺序落库就靠它。用 10 的步长留出空隙，
 * 以后想往两条之间插一个不用整体重排。
 */
export function applyItemOrder(db: DatabaseSync, uuids: string[]): number {
  const stmt = db.prepare('UPDATE items SET sort_order = ? WHERE uuid = ?');
  let n = 0;
  transaction(db, () => {
    uuids.forEach((uuid, i) => {
      stmt.run((i + 1) * 10, uuid);
      n += 1;
    });
  });
  return n;
}

/** 还没排序号时给一个「排在最后」的值 */
export function nextSortOrder(db: DatabaseSync): number {
  const m = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM items').get() as { m: number } | undefined;
  return Number(m?.m ?? 0) + 10;
}

/** 分类 → 内部标识前缀 */
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

/**
 * 生成下一个可用的内部标识（如 `DAY-0007`）。
 *
 * ── 两个坑，都踩过 ──
 *
 * 1. **必须只认「正好是 PREFIX-数字」的标识**。库存子行的标识形如
 *    `DAY-0001-S1`，用 `LIKE 'DAY-%'` 会把它们一起捞进来；按字典序排
 *    `-S` 后缀反而更靠后，于是解析出 NaN、回落到 0001，直接撞号。
 * 2. **不能只 +1**。删除记录后序号会留下空洞，简单 +1 可能又撞上已有的。
 *    所以拿最大编号再往上找第一个真正没被占用的。
 *
 * 写在一处而不是每个入口各写一遍：这三份副本曾经同时存在，
 * 修了一份另两份还是坏的。
 */
export function nextItemCode(db: DatabaseSync, category: string): string {
  const prefix = CODE_PREFIX[category] ?? 'GEN';
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);

  const used = new Set<number>();
  const rows = db.prepare('SELECT code FROM items WHERE code LIKE ?').all(`${prefix}-%`) as {
    code: string;
  }[];
  for (const r of rows) {
    const m = pattern.exec(String(r.code ?? ''));
    if (m) used.add(Number(m[1]));
  }

  let n = 1;
  while (used.has(n)) n += 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

/**
 * 还在手上的顶层物品（在库 / 使用中）且剩余数量大于 0。
 * v2 取消了批次，v3 加了「一组库存」子行，所以这里要显式排除子行。
 */
export function listActiveItems(db: DatabaseSync): Row[] {
  const rows = db
    .prepare(
      `SELECT ${fieldNames(tableDef('items')).join(', ')}
       FROM items
       WHERE status IN ('in_stock','in_use') AND remaining > 0 AND ${TOP_LEVEL}`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => rowFromSql('items', r));
}

export function enumsSnapshot(): Record<string, { key: string; label: string }[]> {
  const out: Record<string, { key: string; label: string }[]> = {};
  for (const [k, v] of Object.entries(ENUMS)) out[k] = v.map((e) => ({ key: e.key, label: e.label }));
  return out;
}

export { TABLES, tableDef, type FieldDef };
