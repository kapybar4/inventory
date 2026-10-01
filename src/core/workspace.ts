/**
 * 工作区管理。
 *
 * 语义（已确认）：工作区是**完全隔离的存储空间**，互不感知、互不影响。
 *  - 一个工作区 = 一个目录 = 一个独立 SQLite 文件
 *  - 导入的单位是工作区：导入 = **新建**一个工作区
 *  - 导出 = 把某个工作区整体打包
 *  - 同一件物品出现在两个工作区里也没有任何问题，因为它们之间没有引用关系
 *
 * 因此这里**没有**任何 workspace_id 外键、没有任何跨工作区聚合。
 * 隔离是靠文件系统做到的，不是靠 WHERE 条件——不会因为漏写条件而串数据。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

import { readBootstrap } from './bootstrap';

import { workspaceId as newWorkspaceId } from './ids';
import { nowIso } from './dates';
import { resolveColumns } from './columns';
import { openDatabase, backupTo, verifyDatabase, countRows, type VerifyResult } from './db';
import { EXPORT_TABLE_ORDER } from './fields';
import { SCHEMA_VERSION } from './schema';

export const REGISTRY_FORMAT = 'dsh-inventory-registry';
export const REGISTRY_VERSION = 1;

/**
 * 工作区可用状态。
 *
 *   - `ok`          正常
 *   - `importing`   正在导入。**进程没走到最后一步就把这个状态留在了注册表里**，
 *                   所以它就是"上次导入没跑完"的证据（宕机、断电、被强杀）。
 *   - `quarantined` 已隔离。数据被判定坏了，**禁止一切读写**。
 *
 * 为什么要单独一个状态而不是"发现了再说"：
 * 半途中断的导入可能留下一半的行，而 SQLite 本身完全健康（transaction 只覆盖
 * 写库那一段，附件拷贝、报告写入都在事务外）。光靠 integrity_check 查不出来，
 * 必须有一个持久化的标记来说明"这件事没做完"。
 */
export type WorkspaceStatus = 'ok' | 'importing' | 'quarantined';

export interface WorkspaceEntry {
  id: string;
  name: string;
  /** 目录名，通常等于 id */
  dir: string;
  createdAt: string;
  /** 'blank' | 'import' | 'demo' */
  source: string;
  /** 来源归档文件名（导入时记录） */
  sourceArchive?: string;
  schemaVersion: number;
  archived?: boolean;
  notes?: string;
  /**
   * 可用状态。缺省视为 `ok`（老注册表里没有这个字段）。
   *
   * 一旦不是 `ok`，`withDb` 会拒绝一切读写 —— 只有一个例外：**导出**。
   * 因为恢复路径就是"导出备份 → 重建 → 删掉坏的"，把导出也堵上等于把人锁在门外。
   */
  status?: WorkspaceStatus;
  /** 为什么被标为异常。给人看的，会显示在界面和 `ws list` 上。 */
  statusReason?: string;
  /** 什么时候标的 */
  statusAt?: string;

  /**
   * 分组顺序：父路径 → 该父级下的有序 key 列表。
   *
   * 存在注册表（工作区级元数据）而不是物品行里 —— 它描述的是「组」的顺序，
   * 不是任何一件物品的属性。路径用 \u0001 连接，避免组名里带分隔符时冲突。
   */
  groupOrder?: Record<string, string[]>;
  /** 分组展开到第几级（1~3） */
  groupLevels?: number;
  /** 排序字段；'manual' 表示排序关闭，按手动顺序 */
  sortField?: string;
  /** 哪些分组路径是收起的 */
  collapsed?: string[];
  /**
   * 物品表显示哪些列（`ColumnKey[]`）。
   *
   * 与分组/排序偏好放一起，理由相同：它描述的是**怎么看这张表**，
   * 不是任何一件物品的属性，所以不进导出包、不进 `items` 表。
   *
   * 存原样，**不在这里做校验** —— 解析交给 `resolveColumns()`，
   * 它会无条件把「物品」「到期时间」补回来。这样即使有人手改坏了注册表，
   * 读出来也一定是合法的。
   */
  columns?: string[];
}

export interface Registry {
  format: typeof REGISTRY_FORMAT;
  formatVersion: number;
  /** GUI 默认打开的工作区 */
  activeWorkspaceId: string | null;
  workspaces: WorkspaceEntry[];
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────
// 路径解析
// ─────────────────────────────────────────────────────────────

/** 本应用在 package.json 里的 name —— 认出"哪个 package.json 才是我的" */
const APP_PACKAGE_NAME = 'dsh-inventory';

/**
 * 程序运行目录。数据就放在它下面的 `data/`。
 *
 * 之所以要"往上找 package.json"而不是直接用 `process.cwd()`：
 * 双击图标启动时 cwd 可能是 `C:\Windows\System32`，跟着它走数据就散到系统目录里了。
 * 而这个函数也可能被 `dist/cli/main.js`（两层深）调用，所以要循环往上找，
 * 不能写死层数。
 *
 * 找的过程里会先撞上 `node_modules/electron/package.json` —— 那不是我们的，
 * 靠 `name` 字段排除掉。找不到就退回 cwd，总比抛错强。
 */
export function programDir(): string {
  /*
   * 打包后代码在 app.asar 里，`dirname(__dirname)` 会得到
   * `…\resources\app.asar` 这种**不可写**的路径。这时数据要放在 exe 旁边，
   * 所以用 `process.execPath` 的目录（Electron 主进程与 Electron 版 Node 都适用）。
   */
  if (__dirname.includes('.asar')) return dirname(process.execPath);

  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === APP_PACKAGE_NAME) return dir;
      } catch {
        /* package.json 坏了就继续往上找 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * 默认数据根目录：**程序运行目录下的 `data/`**。
 *
 * 一个工作区 = `data/workspaces/<id>/` 一个子目录（每个目录一套
 * `data.db` + `meta.json` + `attachments/`），互不影响，拷贝即迁移。
 *
 * 优先级（越靠前越优先）：
 *   1. `DSH_INVENTORY_HOME` —— 测试与"临时换一套数据"用
 *   2. 启动配置里用户指定的目录 —— 程序目录写不进去时的出路
 *   3. `<程序目录>/data` —— 默认
 *
 * 之所以要有第 2 条：程序若装在 `Program Files` 这类受保护目录里，
 * 第 3 条会写不进去。那时不能只是"报个错就算了" —— 用户得有条出路，
 * 而配置这件事本身必须存在数据目录**之外**（见 core/bootstrap.ts）。
 */
export function defaultDataDir(): string {
  const env = process.env['DSH_INVENTORY_HOME'];
  if (env && env.trim()) return resolve(env.trim());
  const configured = readBootstrap().dataDir;
  if (configured) return resolve(configured);
  return join(programDir(), 'data');
}

/** 数据目录是不是"用户显式配的"（环境变量或启动配置） */
export function isDataDirConfigured(): boolean {
  const env = process.env['DSH_INVENTORY_HOME'];
  if (env && env.trim()) return true;
  return Boolean(readBootstrap().dataDir);
}

/**
 * 目录能不能写。
 *
 * 真去写一个探测文件再删掉，而不是看权限位 —— Windows 上的
 * `Program Files`、被组策略管的目录、只读挂载盘，光看 ACL 很容易判错。
 * 只读检查会短暂创建 `.dsh-write-probe`，随即删除。
 */
export function isDirWritable(dir: string): { ok: boolean; reason: string } {
  const probe = join(dir, '.dsh-write-probe');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'probe', 'utf8');
    unlinkSync(probe);
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** 数据目录当前是否可用（能建能写） */
export function dataDirStatus(): {
  dir: string;
  writable: boolean;
  reason: string;
  configured: boolean;
  fallbackDir: string;
} {
  const dir = defaultDataDir();
  const w = isDirWritable(dir);
  return {
    dir,
    writable: w.ok,
    reason: w.reason,
    configured: isDataDirConfigured(),
    // 程序目录写不进去时，"换个地方"该往哪指 —— 给用户一个现成的建议
    fallbackDir: suggestedDataDir(),
  };
}

/** 建议的数据目录：用户主目录下一个明确的位置 */
export function suggestedDataDir(): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir();
  return join(home, 'DSH-Inventory-Data');
}

export function registryPath(dataDir: string): string {
  return join(dataDir, 'registry.json');
}

export function workspaceDir(dataDir: string, entry: { id: string; dir?: string }): string {
  return join(dataDir, 'workspaces', entry.dir ?? entry.id);
}

export function workspaceDbPath(dataDir: string, entry: { id: string; dir?: string }): string {
  return join(workspaceDir(dataDir, entry), 'data.db');
}

/** 保证路径确实落在工作区目录内，防止 `../` 逃逸 */
export function assertInsideWorkspace(wsDir: string, candidate: string): string {
  const root = resolve(wsDir);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界，拒绝访问工作区之外的文件: ${candidate}`);
  }
  return target;
}

// ─────────────────────────────────────────────────────────────
// 注册表读写（原子替换）
// ─────────────────────────────────────────────────────────────

export function emptyRegistry(): Registry {
  return {
    format: REGISTRY_FORMAT,
    formatVersion: REGISTRY_VERSION,
    activeWorkspaceId: null,
    workspaces: [],
    updatedAt: nowIso(),
  };
}

export function readRegistry(dataDir: string): Registry {
  const p = registryPath(dataDir);
  if (!existsSync(p)) return emptyRegistry();
  const raw = readFileSync(p, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`registry.json 解析失败（${p}）: ${(err as Error).message}`);
  }
  const reg = parsed as Partial<Registry>;
  if (reg.format !== REGISTRY_FORMAT) {
    throw new Error(`registry.json 格式不匹配: 期望 ${REGISTRY_FORMAT}，实际 ${String(reg.format)}`);
  }
  return {
    format: REGISTRY_FORMAT,
    formatVersion: reg.formatVersion ?? 1,
    activeWorkspaceId: reg.activeWorkspaceId ?? null,
    workspaces: Array.isArray(reg.workspaces) ? reg.workspaces : [],
    updatedAt: reg.updatedAt ?? nowIso(),
  };
}

/**
 * 原子写入：先写临时文件再 rename。
 * 直接覆写 registry.json 一旦断电就会丢掉整个工作区索引。
 */
export function writeRegistry(dataDir: string, reg: Registry): void {
  const p = registryPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  reg.updatedAt = nowIso();
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8');
  renameSync(tmp, p);
}

export function listWorkspaces(dataDir: string): WorkspaceEntry[] {
  return readRegistry(dataDir).workspaces.filter((w) => !w.archived);
}

export function findWorkspace(dataDir: string, idOrName: string): WorkspaceEntry | null {
  const reg = readRegistry(dataDir);
  const exact = reg.workspaces.find((w) => w.id === idOrName);
  if (exact) return exact;
  const byName = reg.workspaces.filter((w) => w.name === idOrName);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`工作区名称 "${idOrName}" 不唯一，请改用 id。候选: ${byName.map((w) => w.id).join(', ')}`);
  }
  // 前缀匹配，方便手敲
  const byPrefix = reg.workspaces.filter((w) => w.id.startsWith(idOrName));
  if (byPrefix.length === 1) return byPrefix[0]!;
  if (byPrefix.length > 1) {
    throw new Error(`工作区 id 前缀 "${idOrName}" 不唯一: ${byPrefix.map((w) => w.id).join(', ')}`);
  }
  return null;
}

export function requireWorkspace(dataDir: string, idOrName: string): WorkspaceEntry {
  const ws = findWorkspace(dataDir, idOrName);
  if (!ws) throw new WorkspaceNotFoundError(idOrName);
  return ws;
}

export class WorkspaceNotFoundError extends Error {
  constructor(public readonly query: string) {
    super(`工作区不存在: ${query}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * 工作区被隔离，禁止读写。
 *
 * 单独一个错误类型是为了让调用方能区分"找不到"和"坏了" ——
 * 界面要显示的是后者，而且要给出一条出路（导出备份 → 重建 → 删除）。
 */
export class WorkspaceUnusableError extends Error {
  constructor(
    public readonly workspaceId: string,
    public readonly workspaceName: string,
    public readonly status: Exclude<WorkspaceStatus, 'ok'>,
    public readonly reason: string,
  ) {
    super(
      status === 'importing'
        ? `工作区「${workspaceName}」上次导入没有完成，已锁定以免写入残缺数据。` +
            `请重新导入，或导出后删除重建。原因: ${reason}`
        : `工作区「${workspaceName}」已被标记为异常，禁止读写。` +
            `请先导出备份，然后删除它并重新导入。原因: ${reason}`,
    );
    this.name = 'WorkspaceUnusableError';
  }
}

/** 这个工作区是不是可用（缺省字段一律视为可用） */
export function workspaceStatus(entry: WorkspaceEntry): WorkspaceStatus {
  return entry.status ?? 'ok';
}

export function isUsable(entry: WorkspaceEntry): boolean {
  return workspaceStatus(entry) === 'ok';
}

/**
 * 读写前的一道闸：不可用就抛。
 *
 * **不在这里挡导出** —— 导出是自己的调用点，它会显式跳过这个检查。
 * 把"允许导出"写成参数而不是默认放行，是为了让"哪些操作能在坏工作区上做"
 * 这件事只有一个答案，不用去猜每条路径的意图。
 */
export function assertUsable(entry: WorkspaceEntry): void {
  const st = workspaceStatus(entry);
  if (st === 'ok') return;
  throw new WorkspaceUnusableError(
    entry.id,
    entry.name,
    st,
    entry.statusReason ?? '未记录原因',
  );
}

/** 标记为隔离 */
export function quarantineWorkspace(
  dataDir: string,
  id: string,
  reason: string,
): WorkspaceEntry {
  return setWorkspaceStatus(dataDir, id, 'quarantined', reason);
}

/** 解除隔离（用户确认数据没问题时用；正常恢复路径是重建） */
export function unquarantineWorkspace(dataDir: string, id: string): WorkspaceEntry {
  return setWorkspaceStatus(dataDir, id, 'ok', '');
}

/** 标记为"正在导入"。导入成功后才置回 ok */
export function markImporting(dataDir: string, id: string): WorkspaceEntry {
  return setWorkspaceStatus(dataDir, id, 'importing', '导入尚未完成');
}

export function setWorkspaceStatus(
  dataDir: string,
  id: string,
  status: WorkspaceStatus,
  reason: string,
): WorkspaceEntry {
  const reg = readRegistry(dataDir);
  const entry = reg.workspaces.find((w) => w.id === id);
  if (!entry) throw new WorkspaceNotFoundError(id);

  if (status === 'ok') {
    delete entry.status;
    delete entry.statusReason;
    delete entry.statusAt;
  } else {
    entry.status = status;
    entry.statusReason = reason;
    entry.statusAt = nowIso();
  }

  writeRegistry(dataDir, reg);
  return entry;
}

/**
 * 未指定时用 active，再退回唯一的一个，或第一个。
 *
 * **默认会拒绝不可用的工作区** —— 闸门放在这里而不是各个调用点，是因为
 * 这里有几十个调用者，靠"每个都记得加一句检查"迟早会漏。真需要绕过
 * （导出、删除、解除隔离）就显式传 `allowUnusable`，让"哪些操作能在坏工作区上做"
 * 这件事在代码里一眼可数。
 */
export function resolveWorkspace(
  dataDir: string,
  idOrName?: string | null,
  opts: { allowUnusable?: boolean } = {},
): WorkspaceEntry {
  const entry = pickWorkspace(dataDir, idOrName);
  if (!opts.allowUnusable) assertUsable(entry);
  return entry;
}

/** 只挑选、不检查可用性。给"必须能在坏工作区上做"的操作用 */
export function pickWorkspace(dataDir: string, idOrName?: string | null): WorkspaceEntry {
  if (idOrName) return requireWorkspace(dataDir, idOrName);
  const reg = readRegistry(dataDir);
  if (reg.activeWorkspaceId) {
    const active = reg.workspaces.find((w) => w.id === reg.activeWorkspaceId);
    if (active) return active;
  }
  const live = reg.workspaces.filter((w) => !w.archived);
  if (live.length === 0) throw new Error('尚未创建任何工作区。用 `ws create` 或 `import` 创建一个。');
  if (live.length === 1) return live[0]!;
  throw new Error(
    `存在多个工作区，且没有设置默认工作区。请用 --ws 指定，或先执行 \`ws use <id>\`。\n可用: ${live
      .map((w) => `${w.id} (${w.name})`)
      .join(', ')}`,
  );
}

export function setActiveWorkspace(dataDir: string, id: string): void {
  const reg = readRegistry(dataDir);
  if (!reg.workspaces.some((w) => w.id === id)) throw new WorkspaceNotFoundError(id);
  reg.activeWorkspaceId = id;
  writeRegistry(dataDir, reg);
}

// ─────────────────────────────────────────────────────────────
// 创建 / 删除
// ─────────────────────────────────────────────────────────────

export interface CreateWorkspaceOptions {
  name: string;
  source?: string;
  sourceArchive?: string;
  /** 使用给定的 id（导入时用于保持确定性，便于测试） */
  id?: string;
  notes?: string;
}

export interface CreatedWorkspace {
  entry: WorkspaceEntry;
  dbPath: string;
  dir: string;
}

/**
 * 建立工作区目录并初始化空库。
 * 不写注册表——调用方决定何时登记，这样导入失败时可以整目录删除，注册表不受污染。
 */
export function createWorkspaceDir(dataDir: string, opts: CreateWorkspaceOptions): CreatedWorkspace {
  const id = opts.id ?? newWorkspaceId();
  const dir = join(dataDir, 'workspaces', id);

  if (existsSync(dir)) throw new Error(`工作区目录已存在: ${dir}`);
  mkdirSync(join(dir, 'attachments'), { recursive: true });
  mkdirSync(join(dir, 'backups'), { recursive: true });

  const dbPath = join(dir, 'data.db');
  const db = openDatabase(dbPath);
  db.close();

  const entry: WorkspaceEntry = {
    id,
    name: opts.name,
    dir: id,
    createdAt: nowIso(),
    source: opts.source ?? 'blank',
    schemaVersion: SCHEMA_VERSION,
  };
  if (opts.sourceArchive) entry.sourceArchive = opts.sourceArchive;
  if (opts.notes) entry.notes = opts.notes;

  const meta = {
    workspaceId: id,
    name: opts.name,
    createdAt: entry.createdAt,
    source: entry.source,
    app: 'dsh-inventory',
    schemaVersion: SCHEMA_VERSION,
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  return { entry, dbPath, dir };
}

export function registerWorkspace(dataDir: string, entry: WorkspaceEntry, makeActive = false): void {
  const reg = readRegistry(dataDir);
  const idx = reg.workspaces.findIndex((w) => w.id === entry.id);
  if (idx >= 0) reg.workspaces[idx] = entry;
  else reg.workspaces.push(entry);
  if (makeActive || reg.activeWorkspaceId === null) reg.activeWorkspaceId = entry.id;
  writeRegistry(dataDir, reg);
}

/**
 * 一步到位：建目录 + 初始化库 + 登记。
 *
 * `makeActive` 默认 **false** —— 新建一个工作区不该悄悄改掉「默认工作区」。
 * 这个默认值是有代价换来的教训：早先固定传 true，于是
 * `ws create --name 父母家` 之后，所有不带 `--ws` 的命令都突然落到那个
 * **还是空的**新工作区上，看起来就像「我的东西全没了」。
 *
 * 只有「当前没有默认工作区」时才自动认领，其余情况要显式 `ws use`。
 */
export function createWorkspace(
  dataDir: string,
  opts: CreateWorkspaceOptions & { makeActive?: boolean },
): CreatedWorkspace {
  const created = createWorkspaceDir(dataDir, opts);
  registerWorkspace(dataDir, created.entry, opts.makeActive ?? false);
  return created;
}

export interface RemoveWorkspaceOptions {
  /** 删除前先导出一份归档到 backups/，默认 true */
  snapshot?: boolean;
  /** 只从注册表移除，保留磁盘文件 */
  forgetOnly?: boolean;
}

export function removeWorkspace(
  dataDir: string,
  id: string,
  opts: RemoveWorkspaceOptions = {},
): { removed: boolean; snapshotPath?: string } {
  const reg = readRegistry(dataDir);
  const entry = reg.workspaces.find((w) => w.id === id);
  if (!entry) throw new WorkspaceNotFoundError(id);

  const dir = workspaceDir(dataDir, entry);
  let snapshotPath: string | undefined;

  if (!opts.forgetOnly && existsSync(dir)) {
    if (opts.snapshot !== false) {
      // 删除前留一份归档：误删是最不可逆的事故
      const backupsDir = join(dataDir, 'backups');
      mkdirSync(backupsDir, { recursive: true });
      snapshotPath = join(backupsDir, `${entry.id}-${stamp()}.db`);
      const db = openDatabase(join(dir, 'data.db'), { readOnly: true });
      try {
        backupTo(db, snapshotPath);
      } finally {
        db.close();
      }
    }
    removeDirWithRetry(dir);
  }

  reg.workspaces = reg.workspaces.filter((w) => w.id !== id);
  if (reg.activeWorkspaceId === id) {
    reg.activeWorkspaceId = reg.workspaces.find((w) => !w.archived)?.id ?? null;
  }
  writeRegistry(dataDir, reg);

  const out: { removed: boolean; snapshotPath?: string } = { removed: true };
  if (snapshotPath) out.snapshotPath = snapshotPath;
  return out;
}

export function renameWorkspace(dataDir: string, id: string, name: string): WorkspaceEntry {
  const reg = readRegistry(dataDir);
  const entry = reg.workspaces.find((w) => w.id === id);
  if (!entry) throw new WorkspaceNotFoundError(id);
  entry.name = name;
  writeRegistry(dataDir, reg);

  const metaPath = join(workspaceDir(dataDir, entry), 'meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      meta['name'] = name;
      writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      /* meta.json 损坏不应阻断重命名 */
    }
  }
  return entry;
}

/**
 * 改工作区的展示偏好：分组顺序、展开层级、排序字段、收起的分组。
 *
 * 这些是**界面偏好**而不是物品数据 —— 所以存在注册表里，
 * 不进 items、不进导出包。理由：
 *   - 它描述的是「组」的排列与「表」的列，不属于任何一件物品
 *   - 换个工作区就该有自己的一套，跟着注册表天然隔离
 */
export function updateWorkspacePrefs(
  dataDir: string,
  id: string,
  patch: Partial<
    Pick<WorkspaceEntry, 'groupOrder' | 'groupLevels' | 'sortField' | 'collapsed' | 'columns'>
  >,
): WorkspaceEntry {
  const reg = readRegistry(dataDir);
  const entry = reg.workspaces.find((w) => w.id === id);
  if (!entry) throw new WorkspaceNotFoundError(id);

  if (patch.groupOrder !== undefined) entry.groupOrder = patch.groupOrder;
  if (patch.groupLevels !== undefined) entry.groupLevels = Math.max(1, Math.min(3, patch.groupLevels));
  if (patch.sortField !== undefined) entry.sortField = patch.sortField;
  if (patch.collapsed !== undefined) entry.collapsed = patch.collapsed;
  // 列配置交给 resolveColumns 兜底（锁定列永远在），这里只做去重存档
  if (patch.columns !== undefined) entry.columns = resolveColumns(patch.columns);

  writeRegistry(dataDir, reg);
  return entry;
}

// ─────────────────────────────────────────────────────────────
// 统计与自检
// ─────────────────────────────────────────────────────────────

export interface WorkspaceStats {
  id: string;
  name: string;
  createdAt: string;
  source: string;
  dir: string;
  dbPath: string;
  dbBytes: number;
  schemaVersion: number;
  tableCounts: Record<string, number>;
  integrityOk: boolean;
  verify: VerifyResult;
}

export function workspaceStats(dataDir: string, entry: WorkspaceEntry): WorkspaceStats {
  const dbPath = workspaceDbPath(dataDir, entry);
  /**
   * **以可写方式打开，让懒迁移先跑完**，再自检。
   *
   * 当初是怎么坏的：这里用 `readOnly + skipMigrate`，于是库永远停在旧版本，
   * 而自检又把"版本落后"当异常、`ws verify` 据此**自动隔离** ——
   * 每次升 schema 之后所有工作区一起被锁死，用户被自己的安全机制挡在门外。
   *
   * 自检要回答的是"这份数据坏没坏"，不是"它是不是最新结构"。
   * 先迁移到当前结构，再判健康度，才是想问的那个问题。
   */
  const db = openDatabase(dbPath);
  try {
    const verify = verifyDatabase(db);
    const tableCounts: Record<string, number> = {};
    for (const t of EXPORT_TABLE_ORDER) tableCounts[t] = countRows(db, t);
    let dbBytes = 0;
    try {
      dbBytes = statSync(dbPath).size;
    } catch {
      /* ignore */
    }
    return {
      id: entry.id,
      name: entry.name,
      createdAt: entry.createdAt,
      source: entry.source,
      dir: workspaceDir(dataDir, entry),
      dbPath,
      dbBytes,
      schemaVersion: verify.schemaVersion,
      tableCounts,
      integrityOk: verify.integrity === 'ok',
      verify,
    };
  } finally {
    db.close();
  }
}

/**
 * 为导入准备一个**全新**的工作区（尚未登记）。
 * 失败时调用方直接删目录即可，注册表与其它工作区完全不受影响——
 * 这就是「导入 = 新建工作区」带来的最大好处：不存在合并冲突，也不存在半损坏状态。
 */
export function prepareImportedWorkspace(
  dataDir: string,
  opts: { name: string; sourceArchive: string; id?: string; notes?: string },
): CreatedWorkspace {
  const createOpts: CreateWorkspaceOptions = {
    name: opts.name,
    source: 'import',
    sourceArchive: opts.sourceArchive,
  };
  if (opts.id) createOpts.id = opts.id;
  if (opts.notes) createOpts.notes = opts.notes;
  return createWorkspaceDir(dataDir, createOpts);
}

export function discardWorkspaceDir(dataDir: string, dir: string): void {
  const root = resolve(join(dataDir, 'workspaces'));
  const target = resolve(dir);
  if (!target.startsWith(root + sep)) {
    throw new Error(`拒绝删除工作区目录之外的路径: ${dir}`);
  }
  removeDirWithRetry(target);
}

/**
 * 带退避重试的目录删除。
 *
 * 为什么需要：Windows 上 `SQLite` 的 `db.close()` 返回后，文件的句柄
 * 是**异步**释放的，紧接着同步 `rmSync` 很容易撞上 `EPERM`。
 * 这不是理论问题 —— 它让「删除工作区」在 CLI 和桌面端都直接失败过。
 * `rmSync` 自带的 maxRetries 只在少数错误码上重试，这里显式做更稳。
 */
function removeDirWithRetry(dir: string, attempts = 6): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      sleepSync(20 * (i + 1));
    }
  }
  const stuck = firstUndeletable(dir);
  const base = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    stuck ? `目录删除失败，文件仍被占用: ${stuck}\n原始错误: ${base}` : base,
  );
}

/**
 * 诊断用：找出目录里哪个文件删不掉。
 * 只在删除重试全部失败时调用，用于给出可操作的错误信息。
 */
function firstUndeletable(dir: string): string | null {
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          const inner = firstUndeletable(full);
          if (inner) return inner;
          continue;
        }
        unlinkSync(full);
      } catch {
        return full;
      }
    }
    return null;
  } catch {
    return dir;
  }
}

/** 同步小睡。Atomics.wait 是 Node 里唯一不阻塞事件循环之外的同步等待方式。 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export { stamp, basename };
