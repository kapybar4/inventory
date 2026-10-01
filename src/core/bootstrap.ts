/**
 * 启动配置：在**数据目录之外**存放"数据目录在哪"这件事。
 *
 * 为什么不能放进数据目录：这个文件存在的唯一理由就是数据目录可能写不进去
 * （程序装在 `Program Files` 里就会这样）。把钥匙锁在打不开的抽屉里没有意义。
 *
 * 存放位置（按可用性挑，永远是可写的用户级目录）：
 *   Windows  `%LOCALAPPDATA%\dsh-inventory\config.json`
 *   其他     `~/.config/dsh-inventory/config.json`
 *
 * 界面与命令行都读同一个文件，所以配置一次两边都生效。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const BOOTSTRAP_DIR_NAME = 'dsh-inventory';
export const BOOTSTRAP_FILE = 'config.json';

export interface BootstrapConfig {
  /**
   * 用户指定的数据目录。**绝对路径**。
   *
   * 设了它就优先于"程序目录下的 data/"。没设（或指向的目录不可用）时
   * 回落到默认位置，界面上会提示去配置。
   */
  dataDir?: string;
  /** 记录写入时间，便于排查"什么时候改的" */
  updatedAt?: string;
}

/**
 * 启动配置所在目录（永远在用户目录下，不随程序安装位置变化）。
 *
 * `DSH_INVENTORY_BOOTSTRAP_HOME` 可以把它整个挪走 —— **专门给测试用**。
 * 不加这个的话，测试跑一次就会往真机的 `%LOCALAPPDATA%` 里写一个
 * `config.json`，而那个文件会影响**真实应用**下次启动时去哪找数据。
 * 测试污染真实配置是最难查的一类问题：现象出现在"下一次手动启动"，
 * 而原因在"上次跑测试"。
 */
export function bootstrapDir(): string {
  const override = process.env['DSH_INVENTORY_BOOTSTRAP_HOME'];
  if (override && override.trim()) return override.trim();
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData && localAppData.trim()) return join(localAppData.trim(), BOOTSTRAP_DIR_NAME);
  return join(homedir(), '.config', BOOTSTRAP_DIR_NAME);
}

export function bootstrapPath(): string {
  return join(bootstrapDir(), BOOTSTRAP_FILE);
}

/** 读启动配置。文件不存在或读坏了都给空对象 —— 这不是致命错误 */
export function readBootstrap(): BootstrapConfig {
  const p = bootstrapPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as Record<string, unknown>;
    const out: BootstrapConfig = {};
    if (typeof obj['dataDir'] === 'string' && obj['dataDir'].trim()) {
      out.dataDir = obj['dataDir'].trim();
    }
    if (typeof obj['updatedAt'] === 'string') out.updatedAt = obj['updatedAt'];
    return out;
  } catch {
    // 文件坏了就当作没配过，不要让整个应用起不来
    return {};
  }
}

/** 写启动配置。目录不存在会建 */
export function writeBootstrap(patch: BootstrapConfig): BootstrapConfig {
  const dir = bootstrapDir();
  mkdirSync(dir, { recursive: true });
  const next: BootstrapConfig = { ...readBootstrap(), ...patch };
  if (patch.dataDir === '') delete next.dataDir;
  next.updatedAt = new Date().toISOString();
  writeFileSync(bootstrapPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 清掉启动配置（回到默认数据目录） */
export function clearBootstrap(): void {
  const p = bootstrapPath();
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* 删不掉就算了，下次读到的内容仍然是旧的 —— 不值得为此报错 */
  }
}

/** 确保配置目录存在（供测试与诊断用） */
export function ensureBootstrapDir(): string {
  const dir = dirname(bootstrapPath());
  mkdirSync(dir, { recursive: true });
  return dir;
}
