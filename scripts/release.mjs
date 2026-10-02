/**
 * 打一个「双击即用」的绿色文件夹。
 *
 * 产出 `_release/Inventory/`：
 *
 *   Inventory/
 *   ├─ Inventory.exe        双击这个（见下面的「为什么要用启动器」）
 *   ├─ 启动.cmd             推荐双击这个
 *   ├─ data/                你的数据（工作区数据库），备份就拷这个目录
 *   ├─ .profile/            Chromium 的缓存 / 锁文件，纯垃圾，不用管
 *   └─ （Electron 运行时的一堆 dll / pak / locales）
 *
 * ── 为什么要用启动器 ──
 * 这台机器上 Electron **必须带 `--no-sandbox` 才能启动**，否则进程静默退出
 * （不打印任何东西，退出码还是 0，看起来就是"点了没反应"）。
 * 双击 exe 没法带参数，所以给一个 `启动.cmd` 代劳。
 * 别的机器上直接双击 exe 多半也能用，两个都留着。
 *
 * ── 为什么不用 `npm run dist:win` ──
 * electron-builder 默认要从 **github.com** 下 Electron 发行包，
 * 而本机连不上 GitHub（只有 npmmirror / npmjs 可达）。
 * 好在 `node_modules/electron/dist` 里已经有整份运行时（约 367MB），
 * 用 `--config.electronDist` 指过去就能**完全离线**打包。
 *
 * ── 更新时数据不丢 ──
 * 脚本会先删掉旧的 `_release/Inventory`，但**先把 `data/` 挪出来**，
 * 打完再放回去。所以"覆盖更新"不会碰到你的数据。
 * `.profile/` 直接丢掉重建 —— 它只是缓存。
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outRoot = join(root, '_release');
const outDir = join(outRoot, 'Inventory');
const dataDir = join(outDir, 'data');
const stash = join(outRoot, '_data-stash');

const log = (m) => process.stdout.write(`${m}\n`);
const fail = (m) => {
  process.stderr.write(`\n[release] ${m}\n`);
  process.exit(1);
};

// ── 0. 前置检查：本地要有 Electron 运行时，否则打不出可离线运行的包 ──
const electronDist = join(root, 'node_modules', 'electron', 'dist');
if (!existsSync(join(electronDist, 'electron.exe'))) {
  fail(
    `找不到本地 Electron 运行时：${electronDist}\n` +
      '  先运行 npm install（它会把 Electron 下载到 node_modules/electron/dist）。',
  );
}
if (!existsSync(join(root, 'node_modules', 'electron-builder'))) {
  fail('找不到 electron-builder。先运行 npm install。');
}

// ── 1. 编译 ──
log('[release] 编译');
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (build.status !== 0) fail(`编译失败（退出码 ${build.status}）`);

// ── 2. 把旧的数据挪出来（覆盖更新不丢数据）──
mkdirSync(outRoot, { recursive: true });
rmSync(stash, { recursive: true, force: true });
let hadData = false;
if (existsSync(dataDir)) {
  renameSync(dataDir, stash);
  hadData = true;
  log('[release] 已把旧的 data/ 挪到一边（打完会放回去）');
}

// ── 3. 打包（离线：用本地 Electron）──
rmSync(outDir, { recursive: true, force: true });
log('[release] 打包（用本地 Electron，不联网）');
const eb = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const pack = spawnSync(
  process.execPath,
  [eb, '--win', 'dir', '--publish', 'never', `--config.electronDist=${electronDist}`],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      // 这台机器没配代码签名证书，别去自动找
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  },
);
if (pack.status !== 0) {
  // 打包失败也要把数据还回去，不然用户的数据就"被更新弄丢了"
  if (hadData && existsSync(stash)) {
    mkdirSync(outDir, { recursive: true });
    renameSync(stash, dataDir);
    log('[release] 打包失败，已把 data/ 放回原位');
  }
  fail(`打包失败（退出码 ${pack.status}）`);
}

// electron-builder 的 dir 目标产出在 release/win-unpacked，搬到我们要的位置
const produced = join(root, 'release', 'win-unpacked');
if (!existsSync(produced)) fail(`没找到打包产物：${produced}`);
mkdirSync(outRoot, { recursive: true });
rmSync(outDir, { recursive: true, force: true });
renameSync(produced, outDir);
// release/ 中间产物用完就清掉，别留两份几百 MB 的东西
rmSync(join(root, 'release'), { recursive: true, force: true });

// ── 4. 放回数据 + 建空的 data/ ──
if (hadData) {
  renameSync(stash, dataDir);
  log('[release] data/ 已放回');
} else {
  mkdirSync(dataDir, { recursive: true });
}
// 让 git 忽略 data/ 里的东西（这个文件夹本身不在仓库里，但以防万一有人拷出去）
writeFileSync(join(dataDir, '.gitignore'), '*\n!.gitignore\n', 'utf8');

// ── 5. 启动器 ──
writeFileSync(
  join(outDir, '启动.cmd'),
  [
    '@echo off',
    'rem 双击这个启动。',
    'rem 为什么要它：Electron 在这台机器上需要 --no-sandbox，否则静默退出。',
    'rem 直接双击 Inventory.exe 在多数机器上也可以，两个都留着。',
    'cd /d "%~dp0"',
    'start "" "%~dp0Inventory.exe" --no-sandbox',
    '',
  ].join('\r\n'),
  'utf8',
);

// ── 6. 说明文件 ──
writeFileSync(
  join(outDir, '怎么用.txt'),
  [
    '家庭物品管理 —— 绿色版',
    '',
    '【怎么打开】',
    '  双击「启动.cmd」。',
    '  如果双击 Inventory.exe 也能开，那就直接用 exe（少一个黑窗口闪一下）。',
    '',
    '【数据在哪】',
    '  data\\ 这个文件夹。一个工作区 = 里面一个子目录。',
    '  换电脑 / 备份：整个拷走 data\\ 就行。',
    '',
    '【更新版本】',
    '  把这个文件夹整个换掉，但要**留下 data\\**。',
    '  在源码目录里跑 node scripts/release.mjs 也会自动保留 data\\。',
    '',
    '【.profile 是什么】',
    '  浏览器内核的缓存和锁文件，纯垃圾，删了会自动重建，不用管。',
    '',
    '【东西存哪了 / 命令行】',
    '  在源码目录里可以用命令行工具：',
    '    npm.cmd run cli -- item list',
    '    npm.cmd run cli -- ws stats',
    '  要让它看这个文件夹里的数据：',
    '    set DSH_INVENTORY_HOME=<这个文件夹>\\data',
    '',
  ].join('\r\n'),
  'utf8',
);

// ── 7. 报告 ──
const size = (dir) => {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? size(p) : statSync(p).size;
  }
  return n;
};
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
log('');
log('[release] 完成');
log(`  产物    ${outDir}`);
log(`  总大小  ${mb(size(outDir))}`);
log(`  数据    ${hadData ? '已保留原有 data/' : '新建了空 data/'}`);
log('');
log('  双击「启动.cmd」即可使用。');
