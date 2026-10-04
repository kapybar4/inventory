/**
 * 走查数据准备。
 *
 * 走查**必须用隔离的数据目录** —— 它会真的新建/改名/删除工作区、改动物品，
 * 跑在 `data/` 上就是把用户的真实数据当试验品（而且断言依赖的条数会被
 * 跑一次变一次，第二次跑就红）。
 *
 * 产出：`_guidb/` —— 一个空数据目录 + 三个工作区：
 *   演示   17 项（`ws seed` 的固定夹具）
 *   空的   刻意留空，用来验"空工作区"这种状态
 *   随笔   再一个，让工作区列表不至于只有一行
 * 并把它设为默认工作区，这样界面一打开就有确定的数据可断言。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DB = join(ROOT, '_guidb');
const CLI = join(ROOT, 'dist', 'cli', 'main.js');

if (!existsSync(CLI)) {
  console.error('[guidb] 找不到 dist/cli/main.js —— 先跑 npm run build');
  process.exit(1);
}

// 每次从零开始：残留的工作区会让断言里的条数对不上
rmSync(DB, { recursive: true, force: true });

const env = { ...process.env, INVENTORY_HOME: DB };

function cli(args, label) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`[guidb] 失败: ${label}（退出码 ${r.status}）\n`);
    process.stderr.write(String(r.stderr || '').split('\n').slice(0, 6).join('\n') + '\n');
    process.exit(1);
  }
  return String(r.stdout || '');
}

/**
 * 从 `--json` 输出里取 data。
 *
 * ⚠️ 输出是**多行美化**的 JSON（不是一行），所以不能"找第一个 `{` 那一行"
 * 直接 parse —— 那只会拿到一个光秃秃的 `{`。
 * 这里按缩进配对，从第一个顶格的 `{` 收到底。
 */
function cliJson(args, label) {
  const out = cli([...args, '--json'], label);
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.trim() === '{');
  if (start < 0) {
    process.stderr.write(`[guidb] ${label} 没有 JSON 输出，实际：\n${out.slice(0, 300)}\n`);
    process.exit(1);
  }
  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const text = lines.slice(start, end + 1).join('\n');
  try {
    return JSON.parse(text).data;
  } catch (err) {
    process.stderr.write(`[guidb] ${label} 的 JSON 解析失败：${String(err)}\n`);
    process.exit(1);
  }
}

process.stdout.write('[guidb] 准备走查数据目录…\n');

cli(['init', '--name', '演示'], 'init 演示');
// 演示数据只从命令行走（界面上没有入口），这是它的设计用途
cli(['ws', 'seed'], 'ws seed');
/*
 * 再补一件**未分类**的东西。
 *
 * 「未分类」是一个独立的组（永远置顶、不可拖动），走查里要验这条规则；
 * 而 `ws seed` 的夹具每件都有分类，那样这组根本不存在 ——
 * 断言就会在"结构选择器不匹配"上红，看着像产品坏了，其实是夹具缺东西。
 * 所以夹具要保证这个状态**存在**。
 */
cli(['item', 'add', '--name', '还没想好放哪的东西'], 'item add 未分类');
cli(['ws', 'create', '--name', '空的'], 'ws create 空的');
cli(['ws', 'create', '--name', '随笔'], 'ws create 随笔');

const list = cliJson(['ws', 'list'], 'ws list');
const 演示 = list.workspaces.find((w) => w.name === '演示');
if (!演示) {
  process.stderr.write('[guidb] 没找到「演示」工作区\n');
  process.exit(1);
}
// 让界面打开时停在这个工作区，断言才有确定的数据
cli(['ws', 'use', 演示.id], 'ws use 演示');

const after = cliJson(['ws', 'list'], 'ws list');
process.stdout.write(`[guidb] 数据目录 ${DB}\n`);
process.stdout.write(`[guidb] 工作区 ${after.workspaces.length} 个：`);
process.stdout.write(after.workspaces.map((w) => `${w.name}(${w.items ?? '?'} 项)`).join('、') + '\n');
process.stdout.write(`[guidb] 默认工作区 ${after.activeWorkspaceId}\n`);
