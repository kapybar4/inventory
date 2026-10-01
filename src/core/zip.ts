/**
 * 归档打包 / 解包。
 *
 * 设计选择：调用 Windows 自带的 `tar.exe`（libarchive，Win10 1803+ 内置），
 * 而不是引第三方 zip 库或依赖 PowerShell。理由：
 *   1. libarchive 按规范写 UTF-8 名字标志，中文文件名不会乱码
 *      （`Compress-Archive` 在非 ASCII 名字上有已知问题）
 *   2. 零依赖，符合本项目「无运行时依赖」的整体取向
 * 非 Windows 平台回退到 `zip`/`unzip`，都没有则报明确错误，而不是悄悄产出坏包。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export class ZipError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = 'ZipError';
  }
}

interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(cmd: string, args: string[], cwd?: string): ToolResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    code: r.status,
  };
}

function which(cmd: string): boolean {
  const probe = process.platform === 'win32' ? run('where', [cmd]) : run('which', [cmd]);
  return probe.ok;
}

let cachedTar: string | null | undefined;

function findTar(): string | null {
  if (cachedTar !== undefined) return cachedTar;
  if (process.platform === 'win32') {
    const sysTar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    cachedTar = existsSync(sysTar) ? sysTar : which('tar') ? 'tar' : null;
  } else {
    cachedTar = which('tar') ? 'tar' : null;
  }
  return cachedTar;
}

export function archiveToolAvailable(): boolean {
  return findTar() !== null;
}

/**
 * 把目录内容打成 zip（不包含目录本身，即 zip 根就是 dir 的内容）。
 * entries 的路径用 `/` 分隔，保证跨平台一致。
 */
export function zipDirectory(dir: string, zipPath: string, entries?: string[]): void {
  const tar = findTar();
  if (!tar) {
    throw new ZipError('系统中找不到 tar.exe，无法生成归档', 'Windows 10 1803+ 应自带 System32\\tar.exe');
  }

  const list = (entries ?? readdirSync(dir)).slice().sort();
  if (list.length === 0) throw new ZipError('归档内容为空，拒绝生成');

  mkdirSync(dirname(resolve(zipPath)), { recursive: true });

  const args = ['-a', '-c', '-f', resolve(zipPath), ...list];
  const r = run(tar, args, dir);
  if (!r.ok) {
    throw new ZipError(`打包失败（${tar} 退出码 ${r.code}）`, r.stderr.trim() || r.stdout.trim());
  }
  if (!existsSync(zipPath)) {
    throw new ZipError('打包命令返回成功，但目标文件不存在');
  }
}

/**
 * 解包到目标目录，并做 **zip slip 防护**：
 * 解包后逐个检查，任何落在目标目录之外的路径都视为恶意/损坏归档。
 */
export function unzipTo(zipPath: string, destDir: string): void {
  const tar = findTar();
  if (!tar) throw new ZipError('系统中找不到 tar.exe，无法解包归档');

  mkdirSync(destDir, { recursive: true });

  const r = run(tar, ['-x', '-f', resolve(zipPath), '-C', resolve(destDir)]);
  if (!r.ok) {
    throw new ZipError(`解包失败（退出码 ${r.code}）`, r.stderr.trim() || r.stdout.trim());
  }

  assertNoEscape(destDir);
}

function assertNoEscape(root: string): void {
  const resolvedRoot = resolve(root);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const resolved = resolve(full);
      if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
        throw new ZipError(
          '归档包含试图逃出目标目录的路径（zip slip），已中止导入',
          `越界路径: ${resolved}`,
        );
      }
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(resolvedRoot);
}

/** 列出 zip 内的条目名，用于导入前的预检 */
export function listArchive(zipPath: string): string[] {
  const tar = findTar();
  if (!tar) throw new ZipError('系统中找不到 tar.exe');
  const r = run(tar, ['-t', '-f', resolve(zipPath)]);
  if (!r.ok) throw new ZipError(`无法读取归档（退出码 ${r.code}）`, r.stderr.trim());
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
