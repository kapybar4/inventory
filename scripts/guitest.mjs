/**
 * 桌面端走查的入口。
 *
 * 做三件事，一步不能少：
 *   1. 准备**隔离的数据目录**（guidb.mjs）—— 走查会真的新建/改名/删除
 *      工作区、改动物品，跑在 data/ 上就是拿用户的真实数据当试验品
 *   2. 起 Electron 跑走查（guitest.cjs），产出 _gui.json
 *   3. 判定（guiassert.mjs）
 *
 * ── 为什么要有这个包装，而不是直接写在 npm 脚本里 ──
 * 走查必须带上隔离的环境变量（INVENTORY_HOME 等），而
 * **npm 脚本里的环境变量写法不跨平台**（VAR=x cmd 在 cmd.exe 里不成立），
 * 引 cross-env 又要多一个依赖 —— 而这个项目运行时是零依赖的。
 * 用 Node 起子进程最省事，也顺带把"必须先建库"这个顺序固定下来。
 *
 * ── 两个必须传的环境变量 ──
 *   INVENTORY_HOME            数据目录（隔离，指向 _guidb/）
 *   INVENTORY_BOOTSTRAP_HOME  启动配置（有一份 fallback 路径；
 *                                 不隔离的话会往真机 %LOCALAPPDATA% 写，
 *                                 而那份配置会影响真实应用下次去哪找数据）
 *
 * 另外要清掉 ELECTRON_RUN_AS_NODE —— 它被全局设过，
 * 留着的话 Electron 会以 Node 模式跑，不开窗口（表现是"静默秒退"）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GUIDB = join(ROOT, '_guidb');
const BOOTSTRAP = join(ROOT, '_guitest-bootstrap');
const USERDATA = join(ROOT, '_guitest-profile');

const electron = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!existsSync(electron)) {
  process.stderr.write('[gui] 找不到 Electron。先运行 npm install。\n');
  process.exit(1);
}
if (!existsSync(join(ROOT, 'dist', 'cli', 'main.js'))) {
  process.stderr.write('[gui] 找不到 dist/cli/main.js。先运行 npm run build。\n');
  process.exit(1);
}

const env = {
  ...process.env,
  INVENTORY_HOME: GUIDB,
  INVENTORY_BOOTSTRAP_HOME: BOOTSTRAP,
  NODE_NO_WARNINGS: '1',
};
// 见文件头：不清掉的话 Electron 以 Node 模式跑，不开窗口
delete env.ELECTRON_RUN_AS_NODE;

function run(label, args) {
  process.stdout.write('\n[gui] ' + label + '\n');
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) {
    process.stderr.write('\n[gui] 失败: ' + label + '（退出码 ' + r.status + '）\n');
    process.exit(r.status === null ? 1 : r.status);
  }
}

// 1. 隔离数据
run('准备隔离数据目录', [join(ROOT, 'scripts', 'guidb.mjs')]);

// 2. 起 Electron 跑走查
process.stdout.write('\n[gui] 桌面端走查（真开窗口读 DOM）\n');
const r = spawnSync(
  electron,
  [join(ROOT, 'scripts', 'guitest.cjs'), '--no-sandbox', '--user-data-dir=' + USERDATA],
  { cwd: ROOT, env, stdio: 'inherit', windowsHide: true },
);
if (r.status !== 0 && r.status !== null) {
  process.stderr.write('\n[gui] 走查进程异常退出（退出码 ' + r.status + '）\n');
}

// 3. 判定（走查本身"没崩"不算过，要看断言）
run('核对断言', [join(ROOT, 'scripts', 'guiassert.mjs')]);