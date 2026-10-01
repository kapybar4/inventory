/**
 * 构建脚本。
 *
 * 用 Node 而不是 shell，因为要跨平台（Windows 上没有 cp/rm 的可靠等价物，
 * 而且这个项目刻意不引任何打包/构建工具链）。
 *
 * 做三件事：
 *   1. 调 TypeScript 编译器（tsc -p tsconfig.json 与 tsconfig.renderer.json）
 *   2. 把 renderer 的静态资源（html/css）复制进 dist
 *   3. 给出清晰的失败信息
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

function run(label, args) {
  process.stdout.write(`\n[build] ${label}\n`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    process.stderr.write(`\n[build] 失败: ${label}（退出码 ${r.status}）\n`);
    process.exit(r.status ?? 1);
  }
}

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) {
  process.stderr.write('[build] 找不到本地 typescript。请先运行 npm install。\n');
  process.exit(1);
}

run('主进程 / CLI / core（tsconfig.json）', [tsc, '-p', 'tsconfig.json']);
run('渲染层（tsconfig.renderer.json）', [tsc, '-p', 'tsconfig.renderer.json']);

// 静态资源不被 tsc 处理，需要手动搬运
const rendererOut = join(dist, 'renderer');
mkdirSync(rendererOut, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  const src = join(root, 'src', 'renderer', f);
  if (!existsSync(src)) {
    process.stderr.write(`[build] 缺少静态资源: ${src}\n`);
    process.exit(1);
  }
  copyFileSync(src, join(rendererOut, f));
}

// 清理上次构建遗留的测试诊断文件
rmSync(join(dist, 'test', '_diag.js'), { force: true });

process.stdout.write('\n[build] 完成 → dist/\n');
process.stdout.write('  dist/main/main.js        桌面端主进程\n');
process.stdout.write('  dist/preload/preload.js  IPC 白名单\n');
process.stdout.write('  dist/renderer/           桌面界面\n');
process.stdout.write('  dist/cli/main.js         命令行工具（完整功能，默认人读 / --json 机器读）\n');
