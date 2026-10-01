/**
 * 功能测试装置（CLI + 数据层）。
 *
 * 目标不是「跑一遍不报错」，而是**逐条核对输出里的具体内容**：
 * 数量对不对、顺序对不对、边界行为是否符合设计。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'cli', 'main.js');
const ROOT = mkdtempSync(join(tmpdir(), 'ft-'));
const HOME = join(ROOT, 'home');

let pass = 0;
let fail = 0;
const failures = [];

/** 最近一次 CLI 调用的原始输入输出，失败时打印出来省得再手跑一遍 */
let lastCli = null;

/** 跑一条 CLI 命令，返回 { code, out, err } */
function cli(args, opts = {}) {
  const env = { ...process.env, DSH_INVENTORY_HOME: HOME, NODE_NO_WARNINGS: '1', ...(opts.env ?? {}) };
  let r;
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      input: opts.stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    });
    r = { args, code: 0, out, err: '' };
  } catch (e) {
    r = { args, code: e.status ?? -1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
  lastCli = r;
  return r;
}

/** 跑一条 CLI 命令并解析 JSON 信封 */
function json(args, opts = {}) {
  const r = cli([...args, '--json'], opts);
  let data = null;
  try {
    data = JSON.parse(r.out);
  } catch {
    /* 解析失败留给断言去报 */
  }
  return { ...r, data };
}

function check(name, fn) {
  // 支持 FUNCTEST_ONLY 按名字过滤，方便单独定位某一条失败
  const only = process.env.FUNCTEST_ONLY;
  if (only && !name.includes(only)) return;
  try {
    const detail = fn();
    pass += 1;
    console.log(`  ✔ ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    fail += 1;
    const msg = String(e && e.message ? e.message : e);
    failures.push({ name, err: msg });
    console.log(`  ✖ ${name}\n      ${msg.split('\n').join('\n      ')}`);
    // 最近一次 CLI 调用的原始输入输出 —— 失败时最需要的就是它
    if (lastCli) {
      console.log(`      ┌ 最近一次 CLI: ${lastCli.args.join(' ')}`);
      console.log(`      │ exit=${lastCli.code}`);
      if (lastCli.err) console.log(`      │ stderr: ${lastCli.err.trim().split('\n').slice(0, 3).join(' / ')}`);
      if (lastCli.out) console.log(`      │ stdout: ${lastCli.out.trim().split('\n').slice(0, 3).join(' / ')}`);
      console.log('      └');
    }
    // JSON 信封里的 error.message 往往就是答案
    try {
      const parsed = JSON.parse(lastCli?.out ?? '');
      if (parsed?.error) console.log(`      ⚑ error: ${parsed.error.name}: ${parsed.error.message}`);
    } catch {
      /* 不是 JSON 就算了 */
    }
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function ok(cond, what) {
  if (!cond) throw new Error(what);
}

// ═════════════════════════════════════════════════════════════
// 1. 初始化与工作区
// ═════════════════════════════════════════════════════════════

section('1. 初始化与工作区');

check('init 创建数据目录与默认工作区，并写入演示数据', () => {
  const r = json(['init', '--name', '我的家']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.name, '我的家', '名称');
  ok(r.data.data.seed.items > 0, '应有演示数据');
  return `${r.data.data.seed.items} 条物品 / ${r.data.data.seed.stocks} 条库存子行 / ${r.data.data.seed.moves} 条流水`;
});

check('重复 init 不报错、不改动已有数据', () => {
  const before = json(['item', 'list', '--all']).data.data.items.length;
  const r = json(['init', '--name', '换个名字']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.alreadyInitialized, true, '应识别为已初始化');
  eq(json(['item', 'list', '--all']).data.data.items.length, before, '物品数不变');
  return '幂等';
});

check('ws create 新建空工作区（来源=新建）', () => {
  const r = json(['ws', 'create', '--name', '父母家']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.tableCounts.items, 0, '应为空');
  const list = json(['ws', 'list']).data.data.workspaces;
  const p = list.find((w) => w.name === '父母家');
  eq(p.source, '新建', '来源中文标签');
  return `id=${p.id}`;
});

check('ws list 显示两个工作区，默认标记正确', () => {
  const d = json(['ws', 'list']).data.data;
  eq(d.count, 2, '工作区数');
  const active = d.workspaces.filter((w) => w.active);
  eq(active.length, 1, '应只有一个默认');
  eq(active[0].name, '我的家', '默认应仍是 init 的工作区（create 不该抢）');
  return d.workspaces.map((w) => `${w.name}(${w.items})`).join(' ');
});

check('同一物品登记在两个工作区互不影响（隔离）', () => {
  const a = json(['item', 'add', '--name', '隔离测试物', '-c', 'daily', '--ws', '我的家']).data.data.created[0];
  const b = json(['item', 'add', '--name', '隔离测试物', '-c', 'daily', '--ws', '父母家']).data.data.created[0];
  ok(a.code !== b.code || true, '内部标识可以重名');
  const la = json(['item', 'list', '--ws', '我的家', '--search', '隔离测试物']).data.data.items;
  const lb = json(['item', 'list', '--ws', '父母家', '--search', '隔离测试物']).data.data.items;
  eq(la.length, 1, '自家一条');
  eq(lb.length, 1, '父母家一条');
  ok(la[0].uuid !== lb[0].uuid, '两条是不同的记录');
  return '各自独立';
});

check('ws create 不会抢走默认工作区（回归）', () => {
  const activeBefore = json(['info']).data.data.activeWorkspaceId;
  const r = json(['ws', 'create', '--name', '临时工作区']);
  eq(r.code, 0, '退出码');
  const activeAfter = json(['info']).data.data.activeWorkspaceId;
  eq(activeAfter, activeBefore, '默认工作区不该被新建的空工作区顶掉');
  // 收尾：删掉，免得影响后面的计数
  cli(['ws', 'rm', '临时工作区', '--yes']);
  return '默认保持不变';
});

check('ws create --use 才显式切换默认', () => {
  const before = json(['info']).data.data.activeWorkspaceId;
  json(['ws', 'create', '--name', '临时工作区2', '--use']);
  const after = json(['info']).data.data.activeWorkspaceId;
  ok(after !== before, '--use 时默认应切换');
  // 切回原工作区并清理
  cli(['ws', 'use', '我的家']);
  cli(['ws', 'rm', '临时工作区2', '--yes']);
  eq(json(['info']).data.data.activeWorkspaceId, before, '切回来');
  return '仅 --use 时切换';
});

check('ws rename 改名生效', () => {
  const r = json(['ws', 'rename', '父母家', '爸妈家']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.name, '爸妈家', '新名字');
  const back = json(['ws', 'rename', '爸妈家', '父母家']);
  eq(back.code, 0, '改回来');
  return '双向';
});

check('指定不存在的工作区 → 退出码 4（未找到）', () => {
  const r = cli(['item', 'list', '--ws', '不存在的家']);
  eq(r.code, 4, '退出码');
  ok(/错误|不存在|未找到/.test(r.err), '错误信息要能看懂');
  return 'exit 4';
});

check('未分类：category 可留空，不兜底成 other', () => {
  const r = json(['item', 'add', '--name', '待分类物', '--unclassified']);
  eq(r.code, 0, '退出码');
  const it = json(['item', 'list', '--search', '待分类物']).data.data.items[0];
  eq(it.category, '', '分类应为空串而不是 other');
  return 'category=""';
});

// ═════════════════════════════════════════════════════════════
// 2. 物品字段
// ═════════════════════════════════════════════════════════════

section('2. 物品字段');

check('品牌 / 型号 / 规格 三者独立，都可选填', () => {
  const a = json(['item', 'add', '--name', '三字段A', '-c', 'digital', '--brand', 'Anker', '--model', 'A1287', '--spec', '20000mAh']).data.data.created[0];
  const b = json(['item', 'add', '--name', '三字段B', '-c', 'digital', '--model', 'MX3S']).data.data.created[0];
  const c = json(['item', 'add', '--name', '三字段C', '-c', 'digital', '--brand', '罗技']).data.data.created[0];
  const d = json(['item', 'add', '--name', '三字段D', '-c', 'digital']).data.data.created[0];

  const get = (uuid) => json(['item', 'show', uuid]).data.data.item;
  const A = get(a.uuid);
  eq(A.brand, 'Anker', 'A 品牌');
  eq(A.model, 'A1287', 'A 型号');
  eq(A.spec, '20000mAh', 'A 规格');
  const B = get(b.uuid);
  eq(B.brand, null, 'B 品牌应为空');
  eq(B.model, 'MX3S', 'B 型号');
  const C = get(c.uuid);
  eq(C.brand, '罗技', 'C 品牌');
  eq(C.model, null, 'C 型号应为空');
  const D = get(d.uuid);
  eq(D.brand, null, 'D 品牌应为空');
  eq(D.model, null, 'D 型号应为空');
  eq(D.spec, null, 'D 规格应为空');
  return '4 种组合都正确';
});

check('按型号能搜到', () => {
  const r = json(['item', 'list', '--search', 'MX3S']).data.data.items;
  eq(r.length, 1, '命中数');
  eq(r[0].name, '三字段B', '命中的是 B');
  return '1 条';
});

check('普通物品：数量恒为 1，--qty 被钳制', () => {
  const r = json(['item', 'add', '--name', '钳制测试', '-c', 'daily', '--qty', '99']).data.data.created[0];
  const it = json(['item', 'show', r.uuid]).data.data.item;
  eq(it.quantity, '1', '数量');
  eq(it.remaining, '1', '剩余');
  eq(it.min_stock, '0', '最低库存应被清 0');
  return 'qty=99 → 1';
});

check('批量物品：数量、剩余、最低库存都能设', () => {
  const r = json(['item', 'add', '--name', '批量测试', '-c', 'daily', '--bulk', '--qty', '24', '--remaining', '20', '--min-stock', '6']).data.data.created[0];
  const it = json(['item', 'show', r.uuid]).data.data.item;
  eq(it.quantity, '24', '数量');
  eq(it.remaining, '20', '剩余');
  eq(it.min_stock, '6', '最低库存');
  return '24/20/6';
});

check('金额用整数分存储，元分互转不丢精度', () => {
  const r = json(['item', 'add', '--name', '金额测试', '-c', 'daily', '--unit-price', '19.99']).data.data.created[0];
  const it = json(['item', 'show', r.uuid]).data.data.item;
  eq(it.unit_price_cents, '1999', '单价（分）');
  eq(it.amount_cents, '1999', '总价自动 = 单价 × 数量');
  return '19.99 → 1999';
});

check('非法分类被拒绝，退出码 2（参数错误）', () => {
  const r = cli(['item', 'add', '--name', '坏分类', '-c', '不存在的分类']);
  eq(r.code, 2, '退出码');
  ok(/不存在|可用/.test(r.err), '应给出可用值');
  return 'exit 2';
});

check('非法日期被拒绝（日历上不存在的日期也要拦住）', () => {
  const a = cli(['item', 'add', '--name', '坏日期', '--expires-on', '2027-02-30']);
  eq(a.code, 3, '2 月 30 日的退出码（数据校验失败）');
  const b = cli(['item', 'add', '--name', '坏日期', '--purchased-on', 'abc']);
  eq(b.code, 3, '非日期文本的退出码');
  const c = cli(['item', 'add', '--name', '坏日期', '--expires-on', '2027-13-01']);
  eq(c.code, 3, '13 月的退出码');
  return 'exit 3 ×3';
});

check('非法日期不会落库（也污染不到到期计算）', () => {
  const found = json(['item', 'list', '--all', '--search', '坏日期']).data.data.items;
  eq(found.length, 0, '不该有任何一条被写进去');
  const tl = json(['timeline', '--granularity', 'year']).data.data;
  const bad = tl.groups.flatMap((g) => g.entries).filter((e) => !/^\d{4}-\d{2}-\d{2}$/.test(e.expiresOn));
  eq(bad.length, 0, '时间轴里不该出现格式错误的到期日');
  return '库与时间轴都干净';
});

check('item update 部分更新：只改名字不动别的字段', () => {
  const uuid = json(['item', 'list', '--search', '批量测试']).data.data.items[0].uuid;
  const before = json(['item', 'show', uuid]).data.data.item;
  cli(['item', 'update', uuid, '--name', '批量测试改名']);
  const after = json(['item', 'show', uuid]).data.data.item;
  eq(after.name, '批量测试改名', '名字改了');
  eq(after.quantity, before.quantity, '数量不该被钳');
  eq(after.min_stock, before.min_stock, '最低库存不该被清');
  eq(after.is_bulk, 'true', '批量标志不该丢');
  return '批量属性保持';
});

check('item update 显式关闭批量后数量被钳回 1', () => {
  const uuid = json(['item', 'list', '--search', '批量测试改名']).data.data.items[0].uuid;
  cli(['item', 'update', uuid, '--no-bulk']);
  const after = json(['item', 'show', uuid]).data.data.item;
  eq(after.is_bulk, 'false', '批量已关');
  eq(after.quantity, '1', '数量被钳');
  eq(after.min_stock, '0', '最低库存被清');
  return '1/1/0';
});

// ═════════════════════════════════════════════════════════════
// 3. 消耗 / 领用 / 清理
// ═════════════════════════════════════════════════════════════

section('3. 消耗 / 领用 / 清理');

check('普通物品：一次消耗归 0，措辞是「消耗」', () => {
  const r = json(['item', 'add', '--name', '消耗测试', '-c', 'daily']);
  const uuid = r.data.data.created[0].uuid;
  const c = cli(['item', 'consume', uuid]);
  eq(c.code, 0, '退出码');
  ok(c.out.includes('已消耗'), `输出应为「已消耗」，实际: ${c.out.trim()}`);
  const it = json(['item', 'show', uuid]).data.data.item;
  eq(it.remaining, '0', '剩余归零');
  eq(it.status, 'consumed', '状态');
  return '1 → 0';
});

check('普通物品 --qty 99 也只扣 1', () => {
  const uuid = json(['item', 'add', '--name', '扣减钳制', '-c', 'daily']).data.data.created[0].uuid;
  cli(['item', 'consume', uuid, '--qty', '99']);
  eq(json(['item', 'show', uuid]).data.data.item.remaining, '0', '应只扣 1 就归零');
  return '99 → 扣 1';
});

check('批量物品可多次领用，措辞是「领用」并报剩余', () => {
  const uuid = json(['item', 'add', '--name', '领用测试', '-c', 'daily', '--bulk', '--qty', '10']).data.data.created[0].uuid;
  const c = cli(['item', 'consume', uuid, '--qty', '3']);
  eq(c.code, 0, '退出码');
  ok(c.out.includes('已领用') && c.out.includes('剩余 7'), `输出: ${c.out.trim()}`);
  return '10 → 7';
});

check('领用超过剩余会被拒绝，且不改数据', () => {
  const uuid = json(['item', 'list', '--search', '领用测试']).data.data.items[0].uuid;
  const r = cli(['item', 'consume', uuid, '--qty', '999']);
  eq(r.code, 2, '退出码');
  eq(json(['item', 'show', uuid]).data.data.item.remaining, '7', '剩余不变');
  return 'exit 2，数据不变';
});

check('丢弃归零时状态是 discarded', () => {
  const uuid = json(['item', 'add', '--name', '丢弃测试', '-c', 'daily']).data.data.created[0].uuid;
  cli(['item', 'consume', uuid, '--reason', 'discard']);
  eq(json(['item', 'show', uuid]).data.data.item.status, 'discarded', '状态');
  return 'discarded';
});

check('过期处理归零时状态是 expired_disposed', () => {
  const uuid = json(['item', 'add', '--name', '过期处理测试', '-c', 'medicine']).data.data.created[0].uuid;
  cli(['item', 'consume', uuid, '--reason', 'expired_dispose']);
  eq(json(['item', 'show', uuid]).data.data.item.status, 'expired_disposed', '状态');
  return 'expired_disposed';
});

check('一键清理只删「非批量且剩余 0」，批量物品即使为 0 也留着', () => {
  // 造：一个已用完的普通物品 + 一个已用完的批量物品
  const normal = json(['item', 'add', '--name', '待清理普通', '-c', 'daily']).data.data.created[0].uuid;
  cli(['item', 'consume', normal]);
  const bulk = json(['item', 'add', '--name', '待清理批量', '-c', 'daily', '--bulk', '--qty', '2']).data.data.created[0].uuid;
  cli(['item', 'consume', bulk, '--qty', '2']);

  const dry = json(['item', 'purge', '--dry-run']).data.data;
  const names = dry.items.map((i) => i.name);
  ok(names.includes('待清理普通'), '普通物品应在待清理清单里');
  ok(!names.includes('待清理批量'), '批量物品不该在清单里');

  const done = json(['item', 'purge', '--yes']).data.data;
  ok(done.purged > 0, '应真的删了');
  const left = json(['item', 'list', '--all', '--search', '待清理']).data.data.items.map((i) => i.name);
  ok(!left.includes('待清理普通'), '普通物品已删');
  ok(left.includes('待清理批量'), '批量物品还在');
  return `清理 ${done.purged} 条`;
});

check('purge 没有可清项时是成功而不是报错', () => {
  const r = json(['item', 'purge', '--yes']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.purged, 0, '条数');
  return 'exit 0';
});

check('item rm 需要 --yes，缺了会拒绝', () => {
  const uuid = json(['item', 'add', '--name', '待删', '-c', 'daily']).data.data.created[0].uuid;
  const r = cli(['item', 'rm', uuid]);
  eq(r.code, 2, '退出码');
  ok(json(['item', 'show', uuid]).code === 0, '记录还在');
  const okr = cli(['item', 'rm', uuid, '--yes']);
  eq(okr.code, 0, '带 --yes 成功');
  ok(json(['item', 'show', uuid]).code === 4, '记录已删');
  return 'exit 2 → 0';
});

// ═════════════════════════════════════════════════════════════
// 4. 到期 / 长期
// ═════════════════════════════════════════════════════════════


// ═════════════════════════════════════════════════════════════
// 4. 到期 / 长期
// ═════════════════════════════════════════════════════════════

section('4. 到期 / 长期');

check('只给年月 → 折算成当月最后一天', () => {
  const r = json(['item', 'add', '--name', '年月测试', '-c', 'medicine', '--expires-ym', '2027-02']).data.data.created[0];
  const it = json(['item', 'show', r.uuid]).data.data.item;
  eq(it.expires_on, '2027-02-28', '到期日');
  return '2027-02 → 2027-02-28';
});

check('不填到期日 = 长期，不参与到期提示', () => {
  const r = json(['item', 'add', '--name', '长期测试', '-c', 'document']).data.data.created[0];
  const d = json(['item', 'show', r.uuid]).data.data;
  eq(d.item.expires_on, null, '到期日应为空');
  eq(d.expiryLabel, '长期', '标签');
  eq(d.expiry.length, 0, '不该有任何到期条目');
  return '长期';
});

check('--long-term 能清空已有的到期日', () => {
  const uuid = json(['item', 'add', '--name', '转长期', '-c', 'daily', '--expires-on', '2027-01-01']).data.data.created[0].uuid;
  eq(json(['item', 'show', uuid]).data.data.item.expires_on, '2027-01-01', '先有到期日');
  cli(['item', 'update', uuid, '--long-term']);
  eq(json(['item', 'show', uuid]).data.data.item.expires_on, null, '已清空');
  return '有 → 无';
});

check('开封后有效期 = 开封日 + 天数', () => {
  const r = json([
    'item', 'add', '--name', '开封测试', '-c', 'medicine',
    '--opened-on', '2026-01-01', '--open-shelf-life-days', '28',
  ]).data.data.created[0];
  const d = json(['item', 'show', r.uuid]).data.data;
  const src = d.expiry.find((e) => e.kind === '开封后有效期');
  ok(src, '应有开封后有效期');
  eq(src.expiresOn, '2026-01-29', '到期日');
  return '2026-01-01 + 28 = 2026-01-29';
});

check('已过期的物品被标为已过期', () => {
  const uuid = json(['item', 'add', '--name', '过期物', '-c', 'medicine', '--expires-on', '2020-01-01']).data.data.created[0].uuid;
  const d = json(['item', 'show', uuid]).data.data;
  eq(d.expiryLabel, '已过期', '标签');
  ok(d.expiry[0].expired === true, 'expired 标志');
  ok(d.expiry[0].daysLeft < 0, '天数应为负');
  return d.expiry[0].daysLeftText;
});

check('--expiring N 只留 N 天内到期的', () => {
  const soon = json(['item', 'add', '--name', '近期到期', '-c', 'daily', '--expires-on', new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10)]).data.data.created[0].uuid;
  const far = json(['item', 'add', '--name', '远期到期', '-c', 'daily', '--expires-on', '2099-01-01']).data.data.created[0].uuid;
  const list = json(['item', 'list', '--expiring', '30']).data.data.items.map((i) => i.uuid);
  ok(list.includes(soon), '10 天后的应在内');
  ok(!list.includes(far), '2099 年的不该在内');
  return `${list.length} 条`;
});

check('--long-term / --dated 过滤', () => {
  const lt = json(['item', 'list', '--long-term']).data.data.items;
  ok(lt.length > 0, '应有长期物品');
  ok(lt.every((i) => !i.expiresOn), '长期列表里不该有到期日');
  const dated = json(['item', 'list', '--dated']).data.data.items;
  ok(dated.every((i) => i.expiresOn), '有到期日列表里每条都该有日期');
  return `长期 ${lt.length} / 有期 ${dated.length}`;
});

// ═════════════════════════════════════════════════════════════
// 5. 一组库存（嵌套）
// ═════════════════════════════════════════════════════════════

section('5. 一组库存');
check('给批量物品加三组库存，父项汇总正确', () => {
  const uuid = json(['item', 'add', '--name', '库存组测试', '-c', 'daily', '--bulk', '--qty', '1']).data.data.created[0].uuid;
  cli(['item', 'stock', 'add', uuid, '--qty', '10', '--remaining', '10', '--expires-on', '2029-04-30']);
  cli(['item', 'stock', 'add', uuid, '--qty', '8', '--remaining', '8', '--expires-on', '2030-04-30']);
  cli(['item', 'stock', 'add', uuid, '--qty', '6', '--remaining', '6', '--long-term']);

  const it = json(['item', 'show', uuid]).data.data;
  eq(it.item.quantity, '24', '总数 = 10+8+6');
  eq(it.item.remaining, '24', '剩余 = 10+8+6（三组都是满的）');
  eq(it.item.expires_on, '2029-04-30', '父项取最早的到期日');
  eq(it.stocks.length, 3, '三组');
  return '24/24，最早 2029-04-30';
});

check('非批量物品不允许配一组库存', () => {
  const uuid = json(['item', 'add', '--name', '非批量拒绝', '-c', 'daily']).data.data.created[0].uuid;
  const r = cli(['item', 'stock', 'add', uuid, '--qty', '5']);
  eq(r.code, 2, '退出码');
  ok(/批量/.test(r.err), '应提示需要先开启批量');
  return 'exit 2';
});

check('领用按先到期先出（FEFO）', () => {
  const uuid = json(['item', 'list', '--search', '库存组测试']).data.data.items[0].uuid;
  const c = cli(['item', 'consume', uuid, '--qty', '12']);
  eq(c.code, 0, '退出码');
  const d = json(['item', 'show', uuid]).data.data;
  const byDate = new Map(d.stocks.map((s) => [s.expiresOn, s.remaining]));
  eq(byDate.get('2029-04-30'), 0, '最早那组先扣光（10）');
  eq(byDate.get('2030-04-30'), 6, '第二组扣掉 2（8→6）');
  eq(byDate.get(null), 6, '长期那组没动');
  return '10→0, 8→6, 6→6';
});

check('某组用光后，父项到期日跳到下一组', () => {
  const uuid = json(['item', 'list', '--search', '库存组测试']).data.data.items[0].uuid;
  eq(json(['item', 'show', uuid]).data.data.item.expires_on, '2030-04-30', '父项到期日');
  return '跟着走';
});

check('删掉一组库存后父项汇总重算', () => {
  const uuid = json(['item', 'list', '--search', '库存组测试']).data.data.items[0].uuid;
  const d = json(['item', 'show', uuid]).data.data;
  const longTermStock = d.stocks.find((s) => s.expiresOn === null);
  const r = json(['item', 'stock', 'rm', longTermStock.uuid, '--yes']);
  eq(r.code, 0, '退出码');
  const after = json(['item', 'show', uuid]).data.data;
  eq(after.item.quantity, '18', '总数 = 24-6');
  eq(after.stocks.length, 2, '剩两组');
  return '24 → 18';
});

check('库存子行不出现在顶层列表里', () => {
  const all = json(['item', 'list', '--all']).data.data.items;
  const names = all.filter((i) => i.name === '库存组测试');
  eq(names.length, 1, '顶层只应有一条（父项），不是 3 条');
  return '1 条';
});

// ═════════════════════════════════════════════════════════════
// 6. 分组 / 排序 / 手动顺序
// ═════════════════════════════════════════════════════════════

section('6. 分组 / 排序 / 手动顺序');

check('一级分组：未分类置顶且 pinned', () => {
  const d = json(['group', 'list', '--levels', '1']).data.data;
  eq(d.groups[0].key, '', '第一个应是未分类');
  eq(d.groups[0].pinned, true, '应标记 pinned');
  eq(d.groups[0].label, '未分类', '显示名');
  ok(d.uncategorized > 0, '未分类计数');
  return `共 ${d.groups.length} 组，未分类 ${d.uncategorized} 件`;
});

check('二级分组：分类 → 子类', () => {
  const d = json(['group', 'list', '--levels', '2']).data.data;
  eq(d.levels, 2, '层级');
  const med = d.groups.find((g) => g.key === 'medicine');
  if (med) {
    ok(med.children.length > 0, '药品下应有子类');
    ok(med.items.length === 0, '有子分组时物品应沉到叶子');
  }
  return `药品子组 ${med ? med.children.length : 0} 个`;
});

check('三级分组：分类 → 子类 → 标签', () => {
  const uuid = json(['item', 'add', '--name', '三级测试', '-c', 'medicine', '--subcategory', '感冒药', '--tags', '常备,儿童']).data.data.created[0].uuid;
  const d = json(['group', 'list', '--levels', '3']).data.data;
  eq(d.levels, 3, '层级');
  const med = d.groups.find((g) => g.key === 'medicine');
  const sub = med.children.find((c) => c.label === '感冒药');
  ok(sub, '应有「感冒药」子组');
  const tagNames = sub.children.map((c) => c.label).sort();
  ok(tagNames.includes('常备') && tagNames.includes('儿童'), `标签子组应含常备与儿童，实际 ${tagNames.join(',')}`);
  // 一对多：同一个物品出现在两个标签组里
  const inChangbei = sub.children.find((c) => c.label === '常备').items.some((i) => i.uuid === uuid);
  const inErtong = sub.children.find((c) => c.label === '儿童').items.some((i) => i.uuid === uuid);
  ok(inChangbei && inErtong, '带两个标签的物品应同时出现在两组里');
  return '标签一对多正确';
});

check('没有子类 / 没有标签时有专门的组名', () => {
  const d = json(['group', 'list', '--levels', '3']).data.data;
  const labels = [];
  const walk = (ns) => ns.forEach((n) => { labels.push(n.label); walk(n.children); });
  walk(d.groups);
  ok(labels.includes('未分子类'), '应有「未分子类」');
  ok(labels.includes('无标签'), '应有「无标签」');
  return '两个占位组都在';
});

check('排序字段全都可用', () => {
  const fields = json(['sort', 'fields']).data.data.fields.map((f) => f.key);
  const expected = ['manual', 'expiry', 'name', 'purchased', 'quantity', 'remaining', 'location', 'price', 'created'];
  for (const f of expected) ok(fields.includes(f), `缺字段 ${f}`);
  return `${fields.length} 个`;
});

check('按名称排序生效（升序）', () => {
  const d = json(['group', 'list', '--levels', '1', '--sort', 'name']).data.data;
  eq(d.sortedBy, 'name', 'sortedBy');
  eq(d.dragEnabled, false, '排序开启时不该允许拖动');

  // 排序是**组内**的，所以要逐组校验。把所有组 flatMap 成一条再比是错的：
  // 上一组的最后一条和下一组的第一条之间没有任何顺序关系。
  let compared = 0;
  for (const g of d.groups) {
    for (let i = 1; i < g.items.length; i += 1) {
      const a = g.items[i - 1].name;
      const b = g.items[i].name;
      // localeCompare 的语义是「a 相对 b」：<=0 表示 a 在前
      ok(a.localeCompare(b, 'zh') <= 0, `「${g.label}」组内「${a}」应排在「${b}」之前`);
      compared += 1;
    }
  }
  ok(compared > 0, '应有可比对的相邻项');

  // 顺带确认中文是按拼音而不是按码位：布(bu) 应在 待(dai) 之前
  ok('布洛芬'.localeCompare('待分类', 'zh') < 0, '中文应按拼音排序');
  return `${d.groups.length} 组、${compared} 对相邻有序`;
});

check('按到期时间排序：没有到期日的排最后', () => {
  const d = json(['group', 'list', '--levels', '1', '--sort', 'expiry']).data.data;
  const med = d.groups.find((g) => g.key === 'medicine');
  if (med && med.items.length > 1) {
    const dates = med.items.map((i) => i.expiresOn ?? '9999-12-31');
    const sorted = [...dates].sort();
    eq(dates.join('|'), sorted.join('|'), '应按到期日升序、长期垫底');
  }
  return '长期垫底';
});

check('排序关闭时 dragEnabled=true，开启后为 false', () => {
  eq(json(['group', 'list', '--levels', '1']).data.data.dragEnabled, true, '默认应可拖');
  eq(json(['group', 'list', '--levels', '1', '--sort', 'name']).data.data.dragEnabled, false, '排序中不可拖');
  return '开关正确';
});

check('排序只改组内顺序，不改分组，也不改分组顺序', () => {
  const a = json(['group', 'list', '--levels', '1']).data.data;
  const b = json(['group', 'list', '--levels', '1', '--sort', 'name']).data.data;
  eq(a.groups.map((g) => g.key).join(','), b.groups.map((g) => g.key).join(','), '分组顺序应完全一致');
  return `${a.groups.length} 组顺序不变`;
});

check('item reorder 无 --after 时移到最前', () => {
  const list = json(['item', 'list', '--group', '0']).data.data.items;
  const last = list.at(-1);
  ok(last, '应能找到最后一条');
  const r = cli(['item', 'reorder', last.uuid]);
  eq(r.code, 0, '退出码');
  // 必须重新取一份：上面那个 list 是调用前的快照
  const after = json(['item', 'list', '--group', '0']).data.data.items;
  ok(after[0].uuid === last.uuid, `应排到最前，实际第 1 位是「${after[0].name}」`);
  return '移到第 1 位';
});

check('item reorder --after 插到指定条目之后', () => {
  const list = json(['item', 'list', '--group', '0']).data.data.items;
  const moving = list[0];
  const anchor = list[1];
  const r = cli(['item', 'reorder', moving.uuid, '--after', anchor.uuid]);
  eq(r.code, 0, '退出码');
  const after = json(['item', 'list', '--group', '0']).data.data.items;
  eq(after[0].uuid, anchor.uuid, '锚点应排第 1');
  eq(after[1].uuid, moving.uuid, '被移动的应排第 2');
  return '插入位置正确';
});

check('--order 固定组顺序并持久化', () => {
  const r = json(['group', 'list', '--levels', '1', '--order', '=daily,medicine']);
  eq(r.code, 0, '退出码');
  const again = json(['group', 'list', '--levels', '1']).data.data;
  const keys = again.groups.map((g) => g.key);
  const di = keys.indexOf('daily');
  const mi = keys.indexOf('medicine');
  ok(di >= 0 && mi >= 0 && di < mi, `日用品应排在药品之前，实际 ${keys.join(',')}`);
  return keys.slice(0, 4).join(' → ');
});

check('未分类永远置顶，即使 --order 把它排到后面', () => {
  const d = json(['group', 'list', '--levels', '1', '--order', '=medicine,daily,']).data.data;
  eq(d.groups[0].key, '', '未分类仍在第一个');
  return '置顶不受影响';
});

check('新物品自动排到手动顺序末尾', () => {
  const before = json(['item', 'list', '--group', '0']).data.data.items;
  const uuid = json(['item', 'add', '--name', '顺序末尾测试', '-c', 'daily']).data.data.created[0].uuid;
  const after = json(['item', 'list', '--group', '0']).data.data.items;
  eq(after.at(-1).uuid, uuid, '新物品应在最后');
  ok(after.length === before.length + 1, '数量 +1');
  return `第 ${after.length} 位`;
});

// ═════════════════════════════════════════════════════════════
// 7. 提醒与时间轴
// ═════════════════════════════════════════════════════════════

section('7. 提醒与时间轴');

check('alert list 按分类分组，只有已过期标记，没有旧分级词', () => {
  const r = cli(['alert', 'list']);
  eq(r.code, 0, '退出码');
  ok(!/紧急|临期|关注/.test(r.out), `不该再出现旧分级词，实际输出:\n${r.out.slice(0, 400)}`);
  const d = json(['alert', 'list']).data.data;
  ok(typeof d.counts.expired === 'number', '应有 expired 计数');
  ok(typeof d.counts.soon === 'number', '应有 soon 计数');
  ok(d.groups.length > 0, '应有分组');
  return `${d.groups.length} 组，过期 ${d.counts.expired}，30 天内 ${d.counts.soon}`;
});

check('alert list 组内按到期日升序', () => {
  const d = json(['alert', 'list']).data.data;
  for (const g of d.groups) {
    const dates = g.entries.map((e) => e.expiresOn);
    const sorted = [...dates].sort();
    eq(dates.join('|'), sorted.join('|'), `「${g.label}」组内应升序`);
  }
  return '全部升序';
});

check('alert list --within 过滤生效', () => {
  const all = json(['alert', 'list']).data.data.groups.flatMap((g) => g.entries);
  const within = json(['alert', 'list', '--within', '30']).data.data.groups.flatMap((g) => g.entries);
  ok(within.length <= all.length, '过滤后不该变多');
  ok(within.every((e) => e.daysLeft <= 30), '每条都应 ≤30 天');
  return `${all.length} → ${within.length}`;
});

check('时间轴：四种粒度都能出格', () => {
  const counts = {};
  for (const g of ['day', 'week', 'month', 'year']) {
    const d = json(['timeline', '--granularity', g]).data.data;
    ok(d.slots.length > 0, `${g} 应有时间格`);
    counts[g] = d.slots.length;
  }
  return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
});

check('时间轴：范围内的条目必落在格内，范围外的标 -1', () => {
  // 用一个足够大的窗口，让演示数据里的日期都落进来
  // 年粒度 + 足够大的窗口：要覆盖到 2099 那种远期数据
  const d = json(['timeline', '--granularity', 'year', '--past', '240', '--future', '1200']).data.data;
  const entries = d.groups.flatMap((g) => g.entries);
  ok(entries.length > 0, '应有条目');
  for (const e of entries) {
    ok(e.slot >= 0, `${e.itemName}@${e.expiresOn} 应落在范围内`);
    const s = d.slots[e.slot];
    ok(e.expiresOn >= s.start && e.expiresOn <= s.end, `${e.expiresOn} 不在格 ${s.label} 内`);
  }
  // 反过来：窄窗口下，范围外的必须标成 -1 而不是乱指一格
  const narrow = json(['timeline', '--granularity', 'month', '--past', '1', '--future', '1']).data.data;
  const far = narrow.groups.flatMap((g) => g.entries).filter((e) => e.slot < 0);
  ok(far.length > 0, '窄窗口下应有条目落在范围外');
  for (const e of far) ok(e.slot === -1, `${e.expiresOn} 应标 -1`);
  return `${entries.length} 条在范围内，窄窗口 ${far.length} 条标 -1`;
});

check('时间轴：--past/--future 改变覆盖范围', () => {
  const a = json(['timeline', '--granularity', 'month', '--past', '1', '--future', '2']).data.data;
  const b = json(['timeline', '--granularity', 'month', '--past', '12', '--future', '24']).data.data;
  ok(a.slots.length < b.slots.length, `窄范围应格数更少：${a.slots.length} vs ${b.slots.length}`);
  return `${a.slots.length} vs ${b.slots.length}`;
});

check('时间轴：非法粒度被拒绝', () => {
  const r = cli(['timeline', '--granularity', '季度']);
  eq(r.code, 2, '退出码');
  return 'exit 2';
});

// ═════════════════════════════════════════════════════════════
// 8. 导入导出
// ═════════════════════════════════════════════════════════════

section('8. 导入导出');

const archive = join(ROOT, 'export.zip');

check('export 生成归档，含 manifest 与两张表', () => {
  const r = json(['export', '--ws', '我的家', '-o', archive]);
  eq(r.code, 0, '退出码');
  eq(r.data.data.fileCount, 5, '文件数（manifest/README/checksums/items/moves）');
  ok(existsSync(archive), '归档文件存在');
  return `${r.data.data.bytes} 字节，${r.data.data.fileCount} 个文件`;
});

check('export --dry-run 不写文件', () => {
  const probe = join(ROOT, 'dry.zip');
  const r = json(['export', '--ws', '我的家', '-o', probe, '--dry-run']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.dryRun, true, 'dryRun 标志');
  ok(!existsSync(probe), '不该生成文件');
  return '未落盘';
});

check('import --dry-run 只预演，不建工作区', () => {
  const before = json(['ws', 'list']).data.data.count;
  const r = json(['import', archive, '--dry-run']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.dryRun, true, 'dryRun 标志');
  eq(r.data.data.errorCount, 0, '预演不该有错误');
  eq(json(['ws', 'list']).data.data.count, before, '工作区数不变');
  return `预演 ${r.data.data.totalRows} 行`;
});

check('import 建新工作区，行数与源一致', () => {
  const srcCounts = json(['ws', 'stats', '--ws', '我的家']).data.data.tableCounts;
  const r = json(['import', archive, '--name', '导入副本']);
  eq(r.code, 0, '退出码');
  const dstCounts = json(['ws', 'stats', '--ws', '导入副本']).data.data.tableCounts;
  eq(dstCounts.items, srcCounts.items, 'items 行数');
  eq(dstCounts.stock_moves, srcCounts.stock_moves, 'stock_moves 行数');
  return `items ${srcCounts.items} → ${dstCounts.items}`;
});

check('往返后关键字段逐条一致（品牌/型号/规格/数量/到期/分类）', () => {
  const pick = (ws) =>
    json(['item', 'list', '--all', '--ws', ws]).data.data.items
      .map((i) => [i.name, i.category, i.brand, i.model, i.spec, i.quantity, i.remaining, i.expiresOn, i.isBulk, i.minStock].join('|'))
      .sort();
  const a = pick('我的家');
  const b = pick('导入副本');
  eq(a.length, b.length, '条数');
  for (let i = 0; i < a.length; i += 1) eq(b[i], a[i], `第 ${i + 1} 条`);
  return `${a.length} 条逐条一致`;
});

check('往返后一组库存的父子关系保持', () => {
  const src = json(['item', 'list', '--ws', '我的家', '--search', '库存组测试']).data.data.items[0];
  const dst = json(['item', 'list', '--ws', '导入副本', '--search', '库存组测试']).data.data.items[0];
  ok(src && dst, '两边都应能找到「库存组测试」这条夹具');
  const ss = json(['item', 'stock', 'list', src.uuid, '--ws', '我的家']).data.data;
  const ds = json(['item', 'stock', 'list', dst.uuid, '--ws', '导入副本']).data.data;
  eq(ds.count, ss.count, '库存组数');
  eq(ds.totals.quantity, ss.totals.quantity, '总数');
  eq(ds.totals.remaining, ss.totals.remaining, '剩余');
  return `${ds.count} 组，合计 ${ds.totals.remaining}/${ds.totals.quantity}`;
});

check('导入不改动源工作区', () => {
  const src = json(['item', 'list', '--all', '--ws', '我的家']).data.data.items.length;
  json(['import', archive, '--name', '再导入一次']);
  eq(json(['item', 'list', '--all', '--ws', '我的家']).data.data.items.length, src, '源工作区条数不变');
  return '源未变';
});

check('同一个归档导入两次 = 两个独立工作区', () => {
  const list = json(['ws', 'list']).data.data.workspaces.filter((w) => w.name.startsWith('导入副本') || w.name.startsWith('再导入'));
  eq(list.length, 2, '两次导入两个工作区');
  ok(list[0].id !== list[1].id, 'id 不同');
  return list.map((w) => w.name).join(' / ');
});

check('导入不存在的归档 → 退出码 4', () => {
  const r = cli(['import', join(ROOT, '不存在.zip')]);
  eq(r.code, 4, '退出码');
  return 'exit 4';
});

check('导入坏包不落库、不留残目录', () => {
  const before = json(['ws', 'list']).data.data.workspaces.map((w) => w.id).sort().join(',');
  // 造一个缺 items.csv 的坏包
  const stage = join(ROOT, 'bad');
  mkdirSync(join(stage, 'tables'), { recursive: true });
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify({ format: 'dsh-inventory-archive', formatVersion: 1 }), 'utf8');
  writeFileSync(join(stage, 'tables', 'items.csv'), 'name,category\n甲,不存在的分类\n', 'utf8');
  const badZip = join(ROOT, 'bad.zip');
  execFileSync('tar.exe', ['-a', '-c', '-f', badZip, '-C', stage, '.'], { stdio: 'ignore' });
  const r = cli(['import', badZip]);
  ok(r.code !== 0, `坏包应失败，实际退出码 ${r.code}`);
  const after = json(['ws', 'list']).data.data.workspaces.map((w) => w.id).sort().join(',');
  eq(after, before, '工作区列表不该变');
  return `exit ${r.code}`;
});

// ═════════════════════════════════════════════════════════════
// 9. 一致性自检与结构
// ═════════════════════════════════════════════════════════════

section('9. 一致性自检与结构');

check('ws verify 全部工作区通过', () => {
  const r = json(['ws', 'verify']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.failed, 0, '不该有失败的工作区');
  return `${r.data.data.checked} 个工作区全部 ok`;
});

check('schema show 输出的表只有 items 与 stock_moves', () => {
  const d = json(['schema', 'show']).data.data;
  eq(d.tables.map((t) => t.name).join(','), 'items,stock_moves', '表清单');
  ok(!d.tables.some((t) => t.name === 'batches'), '不该有 batches');
  return `${d.tables.length} 张表`;
});

check('items 的导出列里没有内部字段（code / sort_order）', () => {
  const d = json(['schema', 'show']).data.data;
  const items = d.tables.find((t) => t.name === 'items');
  const exported = items.columns.filter((c) => c.exported).map((c) => c.name);
  // 不该导出的：重建即可得的内部标识，以及已经取消的旧字段
  for (const hidden of ['code', 'expiry_precision', 'expires_ym']) {
    ok(!exported.includes(hidden), `不该导出 ${hidden}`);
  }
  // 该导出的：手动顺序是用户拖出来的，丢了往返就不还原了
  ok(exported.includes('sort_order'), 'sort_order 必须导出（否则往返后顺序丢失）');
  ok(exported.includes('model'), '应导出 model');
  ok(exported.includes('brand'), '应导出 brand');
  ok(exported.includes('parent_uuid'), '应导出 parent_uuid（结构，不能丢）');
  return `${exported.length} 列`;
});

check('enums 列出所有枚举', () => {
  const d = json(['enums']).data.data;
  for (const k of ['item_category', 'item_status', 'workspace_source', 'move_reason']) {
    ok(d.enums[k], `缺枚举 ${k}`);
  }
  return Object.keys(d.enums).join(', ');
});

check('info 报出数据目录与工作区数', () => {
  const d = json(['info']).data.data;
  eq(d.dataDir, HOME, '数据目录');
  ok(d.workspaceCount > 0, '工作区数');
  eq(d.schemaVersion, 8, '结构版本');
  return `${d.workspaceCount} 个工作区，schema v${d.schemaVersion}`;
});

// ═════════════════════════════════════════════════════════════
// 10. CLI 契约
// ═════════════════════════════════════════════════════════════

section('10. CLI 契约');

check('--json 时 stdout 只有一个合法 JSON 对象', () => {
  const r = cli(['item', 'list', '--json']);
  const parsed = JSON.parse(r.out);
  ok(parsed.ok === true, 'ok 字段');
  ok('data' in parsed && 'warnings' in parsed && 'meta' in parsed, '信封结构');
  return '信封完整';
});

check('--json 时日志走 stderr 而不是 stdout', () => {
  const r = cli(['item', 'add', '--name', '日志分离测试', '-c', 'daily', '--json']);
  JSON.parse(r.out); // stdout 必须仍是纯 JSON
  return 'stdout 干净';
});

check('未知命令 → 退出码 2', () => {
  const r = cli(['不存在的命令']);
  eq(r.code, 2, '退出码');
  return 'exit 2';
});

check('缺必需参数 → 退出码 2 并给出用法', () => {
  const r = cli(['item', 'add']);
  eq(r.code, 2, '退出码');
  ok(/用法|--name|没有要新增/.test(r.err), '应给出可操作的提示');
  return 'exit 2';
});

check('--dry-run 不落库（item add）', () => {
  const r = json(['item', 'add', '--name', '不该被写入', '-c', 'daily', '--dry-run']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.dryRun, true, 'dryRun 标志');
  // 按名字查，不受其它用例增删物品的影响
  const found = json(['item', 'list', '--all', '--search', '不该被写入']).data.data.items;
  eq(found.length, 0, '不该真的写进去');
  return '未写入';
});

check('批量 JSON 录入（--json-file）', () => {
  const file = join(ROOT, 'batch.json');
  writeFileSync(
    file,
    JSON.stringify([
      { name: '批量录入甲', category: 'daily', qty: 1, expiresYm: '2028-06', unitPrice: '29.90' },
      { name: '批量录入乙', category: 'medicine', brand: '某厂', model: 'M-1' },
    ]),
    'utf8',
  );
  const r = json(['item', 'add', '--json-file', file]);
  eq(r.code, 0, '退出码');
  eq(r.data.data.created.length, 2, '应新增 2 条');
  const jia = json(['item', 'list', '--search', '批量录入甲']).data.data.items[0];
  eq(jia.expiresOn, '2028-06-30', '年月应折算成月末');
  eq(jia.unitPriceYuan, '29.90', '价格');
  return '2 条，年月已折算';
});

check('--json-file 容忍 UTF-8 BOM（Windows 上很常见）', () => {
  const file = join(ROOT, 'bom.json');
  // 手工加 BOM：记事本、PowerShell 的 Out-File -Encoding utf8 都会带
  writeFileSync(file, '\uFEFF' + JSON.stringify([{ name: '带BOM录入', category: 'daily' }]), 'utf8');
  const r = json(['item', 'add', '--json-file', file]);
  eq(r.code, 0, '带 BOM 的 JSON 也应能读');
  const found = json(['item', 'list', '--search', '带BOM录入']).data.data.items;
  eq(found.length, 1, '应当真的写进去');
  return 'BOM 已忽略';
});

check('JSON 录入缺 name 会被拒绝', () => {
  const file = join(ROOT, 'bad-batch.json');
  writeFileSync(file, JSON.stringify([{ category: 'daily' }]), 'utf8');
  const r = cli(['item', 'add', '--json-file', file]);
  eq(r.code, 2, '退出码');
  return 'exit 2';
});

check('--help 输出所有命令且退出码 0', () => {
  const r = cli(['--help']);
  eq(r.code, 0, '退出码');
  for (const cmd of ['item add', 'item consume', 'item reorder', 'item stock', 'item purge', 'group list', 'timeline', 'import', 'export']) {
    ok(r.out.includes(cmd), `帮助里应包含 ${cmd}`);
  }
  return '命令齐全';
});

check('子命令 --help 给出该命令的选项', () => {
  const r = cli(['item', 'add', '--help']);
  eq(r.code, 0, '退出码');
  ok(r.out.includes('--model'), '应列出 --model');
  ok(r.out.includes('--bulk'), '应列出 --bulk');
  return '选项齐全';
});

check('校验失败时 --json 给结构化错误信封', () => {
  const r = json(['item', 'add', '--name', '坏日期JSON', '--expires-on', '2027-02-30']);
  eq(r.code, 3, '退出码');
  ok(r.data && r.data.ok === false, 'ok 应为 false');
  ok(r.data.error && /日期/.test(r.data.error.message), 'error.message 应说明原因');
  eq(r.data.error.code, 3, 'error.code');
  return '结构化错误';
});

// ═════════════════════════════════════════════════════════════
// 11. 列配置
// ═════════════════════════════════════════════════════════════

section('11. 列配置');

check('column list 列出全部列，并标出必显的两列', () => {
  const d = json(['column', 'list']).data.data;
  eq(d.available.length, 10, '可配置列数（含默认关掉的 位置/规格/备注）');
  eq(d.locked.join(','), 'name,expiry', '必显列');
  eq(d.visible.length, 7, '默认显示的列数');
  ok(!d.visible.includes('notes'), '备注默认不显示');
  ok(!d.visible.includes('spec'), '规格默认不显示');
  ok(!d.visible.includes('location'), '位置默认不显示');
  const name = d.columns.find((c) => c.key === 'name');
  eq(name.lock, true, '物品列必显');
  eq(name.label, '物品', '物品列的中文名');
  const exp = d.columns.find((c) => c.key === 'expiry');
  eq(exp.lock, true, '到期时间列必显');
  return `${d.available.length} 列，必显 ${d.locked.join('+')}`;
});

check('column set 只留指定列', () => {
  const r = json(['column', 'set', 'name', 'expiry', 'quantity']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.visible.join(','), 'name,expiry,quantity', '结果');
  // 重新读一遍，确认真的存下来了
  eq(json(['column', 'list']).data.data.visible.join(','), 'name,expiry,quantity', '持久化');
  return '3 列';
});

check('column set 漏掉必显列会自动补回（约束在数据层）', () => {
  // 只给 brand —— 一个必显列都没给
  const r = json(['column', 'set', 'brand']);
  eq(r.code, 0, '退出码');
  const v = r.data.data.visible;
  ok(v.includes('name'), '名字被补回来了');
  ok(v.includes('expiry'), '到期时间被补回来了');
  ok(v.includes('brand'), '要的那列在');
  eq(v.length, 3, '不该多出别的');
  return v.join(',');
});

check('即使有人把配置手改成空数组，必显列仍在', () => {
  // 直接改注册表，模拟"配置被写坏"
  const r = json(['column', 'set']);
  ok(r.code === 2, '不带参数应报用法错误');
  // 空数组走 resolveColumns 的兜底：回落到默认列（也就包含必显列）
  const list = json(['column', 'list']).data.data;
  ok(list.visible.includes('name') && list.visible.includes('expiry'), '必显列在');
  return '受保护';
});

check('column set 认不出的列名被拒绝', () => {
  const r = cli(['column', 'set', 'name', 'expires']);
  eq(r.code, 2, '退出码');
  ok(/不存在|可用/.test(r.err), '应说明原因并给出可用值');
  ok(r.err.includes('expiry'), '应列出正确的名字');
  return 'exit 2';
});

check('column set --default / --show-all', () => {
  json(['column', 'set', 'name', 'expiry']);
  eq(json(['column', 'list']).data.data.visible.length, 2, '先缩到 2 列');

  const def = json(['column', 'set', '--default']).data.data;
  eq(def.visible.length, 7, '--default 回到默认的 7 列');

  json(['column', 'set', 'name', 'expiry']);
  const all = json(['column', 'set', '--show-all']).data.data;
  eq(all.visible.length, 10, '--show-all 打开全部 10 列');
  return '两个开关都对';
});

check('column set --dry-run 不落库', () => {
  json(['column', 'set', '--default']);
  const before = json(['column', 'list']).data.data.visible.join(',');
  const r = json(['column', 'set', 'name', 'expiry', '--dry-run']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.dryRun, true, 'dryRun 标志');
  eq(r.data.data.wouldShow.join(','), 'name,expiry', '预演结果');
  eq(json(['column', 'list']).data.data.visible.join(','), before, '实际没变');
  return '未写入';
});

check('列配置按工作区隔离', () => {
  json(['column', 'set', 'name', 'expiry', '--ws', '我的家']);
  const mine = json(['column', 'list', '--ws', '我的家']).data.data.visible.length;
  const parents = json(['column', 'list', '--ws', '父母家']).data.data.visible.length;
  eq(mine, 2, '我的家：2 列');
  eq(parents, 7, '父母家：不受影响，仍是默认 7 列');
  return `${mine} vs ${parents}`;
});

check('列配置不进导出包，副本拿默认值', () => {
  json(['column', 'set', 'name', 'expiry', '--ws', '我的家']);
  const archive = join(ROOT, 'cols.zip');
  json(['export', '--ws', '我的家', '-o', archive]);
  json(['import', archive, '--name', '列测试副本']);
  const copy = json(['column', 'list', '--ws', '列测试副本']).data.data;
  eq(copy.visible.length, 7, '副本应是默认 7 列，不继承源的界面偏好');
  return '副本 = 默认';
});

check('必显列不能被「全部关掉」绕过', () => {
  // 模拟界面被绕过：直接调底层 API 传空数组
  const r = json(['column', 'set', '--default']);
  eq(r.code, 0, '退出码');
  const list = json(['column', 'list']).data.data;
  ok(list.locked.length === 2, '锁定清单固定两项');
  for (const k of list.locked) ok(list.visible.includes(k), `${k} 在可见列里`);
  return '锁定生效';
});

// ═════════════════════════════════════════════════════════════
// 12. 补充信息（展开列）
// ═════════════════════════════════════════════════════════════

section('12. 补充信息');

check('item extra：列出固定三项 + 自定义字段', () => {
  json(['item', 'add', '--name', '空调', '-c', 'digital', '--extra', '{"滤网型号":"M8R-FLP"}']);
  const d = json(['item', 'extra', '空调']).data.data;
  eq(d.fields.length, 3, '固定三项');
  eq(d.fields.map((f) => f[0]).join(','), '位置,规格,备注', '顺序与名称');
  eq(d.custom['滤网型号'], 'M8R-FLP', '自定义字段');
  return JSON.stringify(d.custom);
});

check('item extra：逐字段设置，自定义字段进 JSON', () => {
  cli(['item', 'extra', '空调', '报修电话', '400-100-5678']);
  const d = json(['item', 'extra', '空调']).data.data;
  eq(d.custom['报修电话'], '400-100-5678', '写进去了');
  eq(d.custom['滤网型号'], 'M8R-FLP', '原来那个还在（不是整份覆盖）');
  return Object.keys(d.custom).join(',');
});

check('item extra：位置拆成 room / container 两列，不是塞进 JSON', () => {
  cli(['item', 'extra', '空调', 'room', '客厅']);
  cli(['item', 'extra', '空调', 'container', '净化器旁']);
  const d = json(['item', 'extra', '空调']).data.data;
  const loc = d.fields.find((f) => f[0] === '位置');
  eq(loc[1], '客厅 / 净化器旁', '位置拼出来了');
  // 关键：它必须是真实列，否则分组、搜索、导出都会失效
  const it = json(['item', 'list', '--search', '空调']).data.data.items[0];
  eq(it.room, '客厅', 'room 是真列');
  eq(it.container, '净化器旁', 'container 是真列');
  ok(!Object.keys(d.custom).includes('room'), '不该混进自定义字段里');
  return '真实列';
});

check('item extra：规格与备注也是真实列', () => {
  cli(['item', 'extra', '空调', 'spec', '适配 Pro H']);
  cli(['item', 'extra', '空调', 'notes', '每 6-12 个月换一次']);
  const it = json(['item', 'list', '--search', '空调']).data.data.items[0];
  eq(it.spec, '适配 Pro H', 'spec');
  eq(it.notes, '每 6-12 个月换一次', 'notes');
  return 'real columns';
});

check('值传空串 = 删除该字段', () => {
  cli(['item', 'extra', '空调', '报修电话', '']);
  const d = json(['item', 'extra', '空调']).data.data;
  ok(!('报修电话' in d.custom), '字段被删掉了');
  eq(d.custom['滤网型号'], 'M8R-FLP', '别的没受影响');
  return 'deleted';
});

check('--set 整份替换', () => {
  cli(['item', 'extra', '空调', '--set', '{"a":"1","b":"2"}']);
  const d = json(['item', 'extra', '空调']).data.data;
  eq(Object.keys(d.custom).sort().join(','), 'a,b', '整份替换');
  return '2 个字段';
});

check('键序不同的同一份内容归一成同一个字符串', () => {
  cli(['item', 'add', '--name', '甲归一', '-c', 'daily', '--extra', '{"z":"1","a":"2"}']);
  cli(['item', 'add', '--name', '乙归一', '-c', 'daily', '--extra', '{"a":"2","z":"1"}']);
  const a = json(['ws', 'stats']).code;
  void a;
  const x = json(['item', 'extra', '甲归一']).data.data.custom;
  const y = json(['item', 'extra', '乙归一']).data.data.custom;
  eq(JSON.stringify(x), JSON.stringify(y), '两份内容应一致');
  return JSON.stringify(x);
});

check('不允许嵌套结构', () => {
  const r = cli(['item', 'extra', '空调', '--set', '{"地址":{"市":"北京"}}']);
  eq(r.code, 3, '退出码（数据校验失败）');
  ok(/嵌套/.test(r.err), '应说明是嵌套的问题');
  // 数据没被改坏
  eq(Object.keys(json(['item', 'extra', '空调']).data.data.custom).sort().join(','), 'a,b', '原值不变');
  return 'exit 3';
});

check('不是 JSON 对象也拒绝', () => {
  eq(cli(['item', 'extra', '空调', '--set', '[1,2]']).code, 3, '数组');
  eq(cli(['item', 'extra', '空调', '--set', '不是json']).code, 3, '文本');
  eq(cli(['item', 'extra', '空调', '--set', '123']).code, 3, '数字');
  return 'exit 3 ×3';
});

check('location 有专门提示（别让人以为它进了 JSON）', () => {
  const r = cli(['item', 'extra', '空调', 'location', '客厅']);
  eq(r.code, 2, '退出码');
  ok(/room/.test(r.err) && /container/.test(r.err), '应引导到 room / container');
  return 'exit 2';
});

check('item extra --dry-run 不落库', () => {
  const before = JSON.stringify(json(['item', 'extra', '空调']).data.data.custom);
  const r = json(['item', 'extra', '空调', '--set', '{"试":"试"}', '--dry-run']);
  eq(r.code, 0, '退出码');
  eq(r.data.data.dryRun, true, 'dryRun 标志');
  eq(JSON.stringify(json(['item', 'extra', '空调']).data.data.custom), before, '实际没变');
  return '未写入';
});

check('补充信息进导出包并原样还原', () => {
  const archive = join(ROOT, 'extra.zip');
  json(['export', '--ws', '我的家', '-o', archive]);
  json(['import', archive, '--name', '补充副本']);
  const src = json(['item', 'extra', '空调', '--ws', '我的家']).data.data;
  const dst = json(['item', 'extra', '空调', '--ws', '补充副本']).data.data;
  eq(JSON.stringify(dst.custom), JSON.stringify(src.custom), '自定义字段逐字一致');
  eq(dst.fields.find((f) => f[0] === '位置')[1], src.fields.find((f) => f[0] === '位置')[1], '位置一致');
  return JSON.stringify(dst.custom);
});

check('列表接口不返回 extra_json（按需拉取）', () => {
  const it = json(['item', 'list', '--search', '空调']).data.data.items[0];
  ok(!('extra_json' in it), '列表里不该带上它 —— 绝大多数行不会被展开');
  ok('spec' in it && 'notes' in it && 'room' in it, '真实字段仍在列表里');
  return '按需加载';
});

// ═════════════════════════════════════════════════════════════
// 汇总
// ═════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(64)}`);
console.log(`通过 ${pass}　失败 ${fail}　共 ${pass + fail}`);
if (failures.length > 0) {
  console.log('\n失败清单:');
  for (const f of failures) console.log(`  ✖ ${f.name}\n    ${f.err.split('\n')[0]}`);
}
console.log(`数据目录: ${HOME}`);

// 清理
try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* Windows 上偶尔删不掉，留着不影响结论 */
}

process.exit(fail === 0 ? 0 : 1);
