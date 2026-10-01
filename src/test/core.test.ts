/**
 * 核心不变量测试。用 node:test 跑，零测试框架依赖。
 *
 * 最重要的一条是「往返不变式」：
 *     export(ws) → import → ws'
 *   除时间戳外，ws' 的全部数据必须与 ws 深度相等。
 *
 * 它同时证明了：
 *   1. 导出包是完整备份（导入能还原一切）
 *   2. 格式没有隐性丢失
 *   3. 「导入 = 新建工作区」不会串改已有工作区
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createWorkspace,
  listWorkspaces,
  readRegistry,
  removeWorkspace,
  workspaceDbPath,
  requireWorkspace,
} from '../core/workspace';
import {
  openDatabase,
  selectAll,
  selectWhere,
  selectOne,
  countRows,
  insertRow,
  updateRow,
  transaction,
  TOP_LEVEL,
  applyItemOrder,
  nextItemCode,
  type Row,
} from '../core/db';
import {
  addStock,
  removeStock,
  stocksOf,
  toBulkStocks,
  refreshParentTotals,
  consumeFromStocks,
  hasStocks,
} from '../core/bulk';
import { exportWorkspace, exportWorkspaces } from '../core/export';
import { importArchive, previewArchive } from '../core/import';
import { seedWorkspace } from '../core/seed';
import {
  computeOverview,
  summarizeOverview,
  groupByCategory,
  expiriesForItem,
  expirySources,
  isLongTerm,
  leadDaysFor,
  lowStockItems,
  categoryLabel,
  classifyKind,
  isSoon,
  worstExpireEntry,
  SOON_DAYS,
  KIND_SHELF_LIFE,
  KIND_WARRANTY,
  KIND_OPENED,
} from '../core/alerts';
import { monthEnd, resolveExpiresOn, daysBetween, daysUntil, addMonths, addDays, isDateString, isYearMonth, today } from '../core/dates';
import { parseCsv, serializeCsv, cellToRaw, rawToCell } from '../core/csv';
import { normalizeFromCsv, centsToYuan, yuanToCents, deriveExpiryColumns, isSpentNonBulk } from '../core/values';
import { buildDdl, SCHEMA_VERSION } from '../core/schema';
import { uuidv7, isUuid } from '../core/ids';
import { buildManifest, validateManifest, CSV_CONVENTION } from '../core/manifest';
import { zipDirectory, unzipTo } from '../core/zip';
import {
  buildTree,
  sortItems,
  SORT_FIELDS,
  uncategorizedCount,
} from '../core/ordering';
import {
  COLUMN_KEYS,
  DEFAULT_COLUMNS,
  ITEM_COLUMNS,
  LOCKED_COLUMNS,
  columnDef,
  isColumnKey,
  isMinimal,
  resolveColumns,
} from '../core/columns';
import {
  mergeExtra,
  parseExtra,
  serializeExtra,
} from '../core/values';
import {
  updateWorkspacePrefs,
  quarantineWorkspace,
  unquarantineWorkspace,
  defaultDataDir,
  isDataDirConfigured,
  isDirWritable,
  programDir,
  markImporting,
  workspaceStatus,
  isUsable,
  assertUsable,
  pickWorkspace,
  resolveWorkspace,
} from '../core/workspace';
import { exportTableColumns } from './_helpers';
import {
  bootstrapPath,
  clearBootstrap,
  ensureBootstrapDir,
  readBootstrap,
  writeBootstrap,
} from '../core/bootstrap';

// ═════════════════════════════════════════════════════════════
// 工作区状态：正常 / 导入中 / 已隔离
// ═════════════════════════════════════════════════════════════

test('工作区缺省是正常的', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '甲', id: 'ws_st_a' });
    assert.equal(workspaceStatus(ws.entry), 'ok', '新建的就是 ok');
    assert.equal(isUsable(ws.entry), true);
    assert.doesNotThrow(() => assertUsable(ws.entry));
  } finally {
    removeTempRoot(root);
  }
});

test('隔离后 resolveWorkspace 拒绝，allowUnusable 放行', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    createWorkspace(dataDir, { name: '甲', id: 'ws_st_b' });
    quarantineWorkspace(dataDir, 'ws_st_b', '测试原因');

    assert.throws(() => resolveWorkspace(dataDir, 'ws_st_b'), /禁止读写/, '默认应拒绝');
    // 恢复路径必须还能走
    const ok = resolveWorkspace(dataDir, 'ws_st_b', { allowUnusable: true });
    assert.equal(workspaceStatus(ok), 'quarantined');
    assert.equal(ok.statusReason, '测试原因', '原因要留着，界面要显示');
    assert.ok(ok.statusAt, '记下时间');

    // pickWorkspace 只挑不查
    assert.equal(pickWorkspace(dataDir, 'ws_st_b').id, 'ws_st_b');
  } finally {
    removeTempRoot(root);
  }
});

test('导入中（importing）的工作区同样被拦住', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    createWorkspace(dataDir, { name: '甲', id: 'ws_st_c' });
    markImporting(dataDir, 'ws_st_c');

    assert.equal(workspaceStatus(requireWorkspace(dataDir, 'ws_st_c')), 'importing');
    assert.throws(() => resolveWorkspace(dataDir, 'ws_st_c'), /导入没有完成|导入尚未完成/);
  } finally {
    removeTempRoot(root);
  }
});

test('解除隔离后恢复可用，状态字段清干净', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    createWorkspace(dataDir, { name: '甲', id: 'ws_st_d' });
    quarantineWorkspace(dataDir, 'ws_st_d', '原因');
    unquarantineWorkspace(dataDir, 'ws_st_d');

    const e = requireWorkspace(dataDir, 'ws_st_d');
    assert.equal(workspaceStatus(e), 'ok');
    assert.equal(e.statusReason, undefined, '原因要清掉');
    assert.equal(e.statusAt, undefined, '时间要清掉');
    assert.doesNotThrow(() => resolveWorkspace(dataDir, 'ws_st_d'));
  } finally {
    removeTempRoot(root);
  }
});

test('状态按工作区隔离，不互相影响', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    createWorkspace(dataDir, { name: '甲', id: 'ws_st_e1' });
    createWorkspace(dataDir, { name: '乙', id: 'ws_st_e2' });
    quarantineWorkspace(dataDir, 'ws_st_e1', '只有甲坏了');

    assert.throws(() => resolveWorkspace(dataDir, 'ws_st_e1'));
    assert.doesNotThrow(() => resolveWorkspace(dataDir, 'ws_st_e2'), '乙不受影响');
  } finally {
    removeTempRoot(root);
  }
});

test('多工作区导出：每个子目录自成一套完整内容', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '甲', id: 'ws_mx_a' });
    const b = createWorkspace(dataDir, { name: '乙', id: 'ws_mx_b' });
    for (const [ws, code] of [
      [a, 'A-1'],
      [b, 'B-1'],
    ] as const) {
      const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
      try {
        insertRow(db, 'items', { code, name: `东西${code}`, category: 'daily' });
      } finally {
        db.close();
      }
    }

    const zip = join(root, 'multi.zip');
    const result = exportWorkspaces(dataDir, [a.entry, b.entry], { outPath: zip });
    assert.equal(result.workspaces.length, 2);
    assert.deepEqual(result.workspaces.map((w) => w.dir), ['甲', '乙'], '子目录用工作区名');

    const unpack = join(root, 'unpacked');
    unzipTo(zip, unpack);
    for (const w of result.workspaces) {
      const rel = join('workspaces', w.dir, 'manifest.json');
      assert.ok(existsSync(join(unpack, rel)), `应有 ${rel}`);
    }
    const rootManifest = JSON.parse(readFileSync(join(unpack, 'manifest.json'), 'utf8')) as {
      kind?: string;
      workspaceCount?: number;
    };
    assert.equal(rootManifest.kind, 'multi', '根目录是总目录');
    assert.equal(rootManifest.workspaceCount, 2);
  } finally {
    removeTempRoot(root);
  }
});

test('多工作区导出：同名工作区的目录不会互相覆盖', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '同名', id: 'ws_mx_c1' });
    const b = createWorkspace(dataDir, { name: '同名', id: 'ws_mx_c2' });

    const result = exportWorkspaces(dataDir, [a.entry, b.entry], { outPath: join(root, 'dup.zip') });
    const dirs = result.workspaces.map((w) => w.dir);
    assert.equal(new Set(dirs).size, 2, `两个目录名必须不同: ${dirs.join(', ')}`);
    assert.deepEqual(dirs, ['同名', '同名-2'], '第二个加后缀');
  } finally {
    removeTempRoot(root);
  }
});

test('多工作区导出：目录名不许带路径分隔符（不能逃出暂存目录）', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '../坏东西', id: 'ws_mx_d' });
    const result = exportWorkspaces(dataDir, [a.entry], { outPath: join(root, 'evil.zip') });
    const dir = result.workspaces[0]!.dir;
    assert.ok(!dir.includes('..'), `不该出现 ..：${dir}`);
    assert.ok(!dir.includes('/') && !dir.includes('\\'), `不该出现分隔符：${dir}`);
  } finally {
    removeTempRoot(root);
  }
});

test('隔离的工作区仍然能导出（否则数据就拿不回来了）', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '坏了的', id: 'ws_mx_e' });
    const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
    try {
      insertRow(db, 'items', { code: 'E-1', name: '要抢救的数据', category: 'daily' });
    } finally {
      db.close();
    }

    quarantineWorkspace(dataDir, 'ws_mx_e', '模拟损坏');
    // 导出不走状态检查，所以照样能跑
    const out = exportWorkspace(dataDir, requireWorkspace(dataDir, 'ws_mx_e'), {
      outPath: join(root, 'rescue.zip'),
    });
    assert.ok(existsSync(out.archivePath), '归档生成了');
    assert.equal(out.rowCounts['items'], 1, '数据在里面');
  } finally {
    removeTempRoot(root);
  }
});

// ═════════════════════════════════════════════════════════════
// 数据目录：默认位置、可写检测、启动配置
// ═════════════════════════════════════════════════════════════

test('数据目录默认在程序目录下的 data/，且一个工作区一个子目录', () => {
  const root = tmpRoot();
  try {
    // 环境变量优先，测试都靠它隔离
    const custom = join(root, 'custom');
    process.env['DSH_INVENTORY_HOME'] = custom;
    assert.equal(defaultDataDir(), resolve(custom), '环境变量优先');
    assert.equal(isDataDirConfigured(), true, '环境变量算"已配置"');

    delete process.env['DSH_INVENTORY_HOME'];
    // 不带环境变量时：要么是启动配置里的，要么是 <程序目录>/data
    const d = defaultDataDir();
    assert.ok(d.endsWith(join('', 'data')) || d.includes('data'), `默认目录应落在 data 下：${d}`);
    // 程序目录应当是仓库根（含本项目的 package.json），而不是 node_modules 里那个
    const pd = programDir();
    assert.ok(existsSync(join(pd, 'package.json')), `程序目录应有 package.json：${pd}`);
    assert.ok(!pd.includes('node_modules'), `不能停在 node_modules 里：${pd}`);
    const pkg = JSON.parse(readFileSync(join(pd, 'package.json'), 'utf8')) as { name?: string };
    assert.equal(pkg.name, 'dsh-inventory', '必须是我们自己的 package.json');
  } finally {
    removeTempRoot(root);
  }
});

test('可写检测：普通目录可写，文件当目录不可写', () => {
  const root = tmpRoot();
  try {
    const okDir = join(root, 'ok');
    const r = isDirWritable(okDir);
    assert.equal(r.ok, true, `普通目录应可写：${r.reason}`);
    // 探测文件必须被清掉，不能留垃圾
    assert.ok(!existsSync(join(okDir, '.dsh-write-probe')), '探测文件应当被删掉');

    // 拿一个**文件**当目录用 —— 确定写不进去
    const asDir = join(root, 'file-not-dir');
    writeFileSync(asDir, 'x', 'utf8');
    const bad = isDirWritable(asDir);
    assert.equal(bad.ok, false, '文件当目录应当判为不可写');
    assert.ok(bad.reason.length > 0, '要给得出原因');
  } finally {
    removeTempRoot(root);
  }
});

test('启动配置：设置数据目录、读回、复位', () => {
  const root = tmpRoot();
  try {
    // 启动配置固定落在 %LOCALAPPDATA%\<名字>，为了不污染真机把它指到临时目录
    const fakeLocal = join(root, 'localappdata');
    const savedLocal = process.env['LOCALAPPDATA'];
    process.env['LOCALAPPDATA'] = fakeLocal;

    const target = join(root, 'my-data');
    assert.equal(readBootstrap().dataDir, undefined, '一开始没有配置');

    writeBootstrap({ dataDir: target });
    assert.equal(readBootstrap().dataDir, target, '写得进读得出');
    assert.ok(readBootstrap().updatedAt, '记下时间');
    assert.ok(existsSync(bootstrapPath()), '配置文件生成了');

    // 设了之后 defaultDataDir 就该听它的
    const savedEnv = process.env['DSH_INVENTORY_HOME'];
    delete process.env['DSH_INVENTORY_HOME'];
    assert.equal(defaultDataDir(), resolve(target), '配置优先于默认位置');
    assert.equal(isDataDirConfigured(), true);

    clearBootstrap();
    assert.equal(readBootstrap().dataDir, undefined, '复位后没有配置了');
    assert.notEqual(defaultDataDir(), resolve(target), '复位后不再指向它');

    if (savedEnv !== undefined) process.env['DSH_INVENTORY_HOME'] = savedEnv;
    if (savedLocal !== undefined) process.env['LOCALAPPDATA'] = savedLocal;
  } finally {
    removeTempRoot(root);
  }
});

test('启动配置坏了不影响启动', () => {
  const root = tmpRoot();
  try {
    const fakeLocal = join(root, 'localappdata');
    const savedLocal = process.env['LOCALAPPDATA'];
    process.env['LOCALAPPDATA'] = fakeLocal;
    ensureBootstrapDir();
    writeFileSync(bootstrapPath(), '{ 这不是 JSON', 'utf8');
    // 读坏了就当没配过，而不是抛出去让整个应用起不来
    assert.deepEqual(readBootstrap(), {});
    if (savedLocal !== undefined) process.env['LOCALAPPDATA'] = savedLocal;
  } finally {
    removeTempRoot(root);
  }
});

// ═════════════════════════════════════════════════════════════
// 补充信息（extra_json）
// ═════════════════════════════════════════════════════════════

test('补充信息：解析、规范化、键按字典序', () => {
  assert.deepEqual(parseExtra('{"b":"2","a":"1"}'), { b: '2', a: '1' });
  assert.deepEqual(parseExtra(null), {});
  assert.deepEqual(parseExtra(''), {});
  assert.deepEqual(parseExtra('{}'), {});

  // 键排序后再序列化 —— 否则同一份内容会得到不同字符串，
  // 往返比较就会"看起来变了"
  assert.equal(serializeExtra({ b: '2', a: '1' }), '{"a":"1","b":"2"}');
  assert.equal(serializeExtra({ a: '1', b: '2' }), '{"a":"1","b":"2"}');
  // 空对象 → null，库里不留两种空
  assert.equal(serializeExtra({}), null);
});

test('补充信息：值一律转成字符串，非字符串的键被拒', () => {
  const obj = parseExtra('{"数量":3,"在用":true}');
  assert.equal(obj['数量'], '3');
  assert.equal(obj['在用'], 'true');

  assert.throws(() => parseExtra('{"嵌套":{"a":1}}'), /嵌套/, '不允许嵌套');
  assert.throws(() => parseExtra('{"列表":[1,2]}'), /嵌套/, '数组也算嵌套');
  assert.throws(() => parseExtra('不是 json'), /JSON/);
});

test('补充信息：必须是对象，不能是数组或标量', () => {
  assert.throws(() => parseExtra('[1,2,3]'), /JSON 对象/);
  assert.throws(() => parseExtra('"字符串"'), /JSON 对象/);
  assert.throws(() => parseExtra('123'), /JSON 对象/);
});

test('补充信息：写入层会归一（键序固定），往返才稳', () => {
  withWorkspace('w', 'ws_extra', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      // 故意用乱序的键写两次，库里应当完全一样
      const a = insertRow(db, 'items', { code: 'E-1', name: '空调', extra_json: '{"滤网型号":"M8R-FLP","安装日":"2025-06"}' });
      const b = insertRow(db, 'items', { code: 'E-2', name: '空调二号', extra_json: '{"安装日":"2025-06","滤网型号":"M8R-FLP"}' });
      assert.equal(a['extra_json'], b['extra_json'], '键序不同的同一份内容应归一成同一个字符串');
      assert.equal(a['extra_json'], '{"安装日":"2025-06","滤网型号":"M8R-FLP"}');
    } finally {
      db.close();
    }
  });
});

test('补充信息：也接受直接传对象', () => {
  withWorkspace('w', 'ws_extra2', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', {
        code: 'E-3',
        name: '保单',
        // 界面直接传对象，比让人拼 JSON 字符串友好
        extra_json: { 保单号: 'P-2024-001', 报修电话: '95500' } as unknown as string,
      });
      const parsed = parseExtra(it['extra_json'] as string);
      assert.equal(parsed['保单号'], 'P-2024-001');
      assert.equal(parsed['报修电话'], '95500');
    } finally {
      db.close();
    }
  });
});

test('补充信息：非法的值被写入层拦住', () => {
  withWorkspace('w', 'ws_extra3', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      assert.throws(
        () => insertRow(db, 'items', { code: 'E-4', name: '坏的', extra_json: '{"a":{"b":1}}' }),
        /嵌套/,
      );
      assert.throws(
        () => insertRow(db, 'items', { code: 'E-5', name: '坏的', extra_json: '不是 json' }),
        /JSON/,
      );
      assert.equal(countRows(db, 'items'), 0, '一条都不该写进去');
    } finally {
      db.close();
    }
  });
});

test('补充信息：mergeExtra 合并 / 空串删除', () => {
  const base = serializeExtra({ a: '1', b: '2' });
  assert.equal(mergeExtra(base, { c: '3' }), '{"a":"1","b":"2","c":"3"}');
  assert.equal(mergeExtra(base, { b: '' }), '{"a":"1"}', '空串 = 删除');
  assert.equal(mergeExtra(base, { a: '', b: '' }), null, '删空了就是 null');
  assert.equal(mergeExtra(null, { x: 'y' }), '{"x":"y"}');
});

test('补充信息：空值存成 NULL 而不是 {}', () => {
  withWorkspace('w', 'ws_extra4', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', { code: 'E-6', name: '没有补充', extra_json: '{}' });
      assert.equal(it['extra_json'], null, '空对象应写成 NULL');
      const raw = db.prepare('SELECT extra_json FROM items WHERE uuid = ?').get(String(it['uuid'])) as { extra_json: unknown };
      assert.equal(raw.extra_json, null, '库里确实是 NULL，不是 "{}"');
    } finally {
      db.close();
    }
  });
});

test('补充信息：进导出包并原样还原', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '源', id: 'ws_ex_exp' });
    const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
    try {
      insertRow(db, 'items', { code: 'X-1', name: '空调', extra_json: '{"滤网型号":"M8R-FLP","安装日":"2025-06"}' });
      insertRow(db, 'items', { code: 'X-2', name: '雨伞', extra_json: null });
    } finally {
      db.close();
    }

    const archive = join(root, 'extra.zip');
    exportWorkspace(dataDir, ws.entry, { outPath: archive });
    const result = importArchive(archive, { dataDir, name: '副本', id: 'ws_ex_copy' });
    assert.equal(result.ok, true, JSON.stringify(result.preview.issues));

    const db2 = openDatabase(workspaceDbPath(dataDir, requireWorkspace(dataDir, 'ws_ex_copy')), { readOnly: true });
    try {
      const byName = new Map(selectAll(db2, 'items').map((r) => [String(r['name']), r]));
      assert.equal(
        byName.get('空调')!['extra_json'],
        '{"安装日":"2025-06","滤网型号":"M8R-FLP"}',
        '补充信息应逐字还原',
      );
      assert.equal(byName.get('雨伞')!['extra_json'], null, '原本是空的仍是空');
    } finally {
      db2.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

test('列配置：位置/规格/备注默认不显示，但可以手动打开', () => {
  // 默认列里不该有它们 —— 这是"减少默认展示"的落点
  for (const k of ['location', 'spec', 'notes'] as const) {
    assert.ok(!DEFAULT_COLUMNS.includes(k), `${k} 不该在默认列里`);
    assert.ok(COLUMN_KEYS.includes(k), `${k} 仍应可配置`);
    assert.ok(!columnDef(k).lock, `${k} 不是必显列`);
  }
  // 手动打开能生效
  assert.deepEqual(resolveColumns(['name', 'expiry', 'spec']), ['name', 'expiry', 'spec']);
});

// ═════════════════════════════════════════════════════════════
// 列配置
// ═════════════════════════════════════════════════════════════

test('列配置：物品与到期时间不可关闭', () => {
  assert.deepEqual(LOCKED_COLUMNS, ['name', 'expiry'], '锁定列就是这两个');
  assert.ok(columnDef('name').lock, '物品列 lock');
  assert.ok(columnDef('expiry').lock, '到期时间列 lock');
});

test('列配置：锁定列在被删掉时会被补回来', () => {
  // 用户把能关的都关了 —— 结果里仍然有物品与到期时间
  const onlyOptional = COLUMN_KEYS.filter((k) => !LOCKED_COLUMNS.includes(k));
  const resolved = resolveColumns(onlyOptional);
  for (const key of LOCKED_COLUMNS) {
    assert.ok(resolved.includes(key), `${key} 必须被补回来`);
  }
  assert.equal(resolved.length, LOCKED_COLUMNS.length + onlyOptional.length);
});

test('列配置：空数组 / 非法值回落到默认列', () => {
  assert.deepEqual(resolveColumns([]), DEFAULT_COLUMNS, '空数组 = 没配置过');
  assert.deepEqual(resolveColumns(null), DEFAULT_COLUMNS, 'null');
  assert.deepEqual(resolveColumns(undefined), DEFAULT_COLUMNS, 'undefined');
  assert.deepEqual(resolveColumns('name,expiry'), DEFAULT_COLUMNS, '不是数组');
  assert.deepEqual(resolveColumns([1, 2, 3]), DEFAULT_COLUMNS, '认不出的键');
});

test('列配置：认不出的键被丢掉，重复被去重', () => {
  const resolved = resolveColumns(['brand', '不存在', 'brand', 'model']);
  assert.ok(resolved.includes('brand') && resolved.includes('model'));
  assert.ok(!(resolved as string[]).includes('不存在'));
  assert.equal(new Set(resolved).size, resolved.length, '不该有重复');
  // 顺序按定义走，不随传入顺序变
  assert.deepEqual(resolved, ['name', 'expiry', 'brand', 'model']);
});

test('列配置：输出顺序稳定，不随勾选先后变', () => {
  const a = resolveColumns(['purchased', 'brand', 'quantity']);
  const b = resolveColumns(['quantity', 'brand', 'purchased']);
  assert.deepEqual(a, b, '同一组列，不管按什么顺序传，结果应一致');
  // 而且应等于定义里的相对顺序
  const defOrder = ITEM_COLUMNS.map((c) => c.key);
  const positions = a.map((k) => defOrder.indexOf(k));
  assert.deepEqual(positions, [...positions].sort((x, y) => x - y), '应按定义顺序');
});

test('列配置：只剩锁定列时算「最小」', () => {
  assert.equal(isMinimal(['name', 'expiry']), true);
  assert.equal(isMinimal(['name']), true, '少给一个也是最小（会被补回来）');
  assert.equal(isMinimal(['name', 'expiry', 'brand']), false);
  assert.equal(isMinimal(null), false, '没配过是默认全开，不是最小');
});

test('列配置：按工作区各存各的，且写进去的一定是解析后的结果', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '甲', id: 'ws_col_a' });
    createWorkspace(dataDir, { name: '乙', id: 'ws_col_b' });

    // 甲只留三列，还故意漏掉锁定列
    updateWorkspacePrefs(dataDir, a.entry.id, { columns: ['quantity'] });
    // 乙不动

    const entryA = requireWorkspace(dataDir, 'ws_col_a');
    const entryB = requireWorkspace(dataDir, 'ws_col_b');
    assert.deepEqual(resolveColumns(entryA.columns), ['name', 'expiry', 'quantity'], '锁定列补上了');
    assert.deepEqual(resolveColumns(entryB.columns), DEFAULT_COLUMNS, '乙不受影响');

    // 存进去的时候就该是解析后的，不留半成品
    assert.deepEqual(entryA.columns, ['name', 'expiry', 'quantity']);
  } finally {
    removeTempRoot(root);
  }
});

test('列配置：isColumnKey 挡住拼错的键', () => {
  assert.equal(isColumnKey('expiry'), true);
  assert.equal(isColumnKey('expires'), false, '差一个字母要挡住');
  assert.equal(isColumnKey(''), false);
  assert.equal(isColumnKey(null), false);
  assert.equal(isColumnKey(7), false);
});

test('列配置：不影响导出包（它是界面偏好，不是物品数据）', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '源', id: 'ws_col_exp' });
    const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
    try {
      insertRow(db, 'items', { code: 'X-1', name: '一件东西', category: 'daily' });
    } finally {
      db.close();
    }
    updateWorkspacePrefs(dataDir, 'ws_col_exp', { columns: ['name', 'expiry'] });

    const archive = join(root, 'col.zip');
    exportWorkspace(dataDir, ws.entry, { outPath: archive });
    const result = importArchive(archive, { dataDir, name: '副本', id: 'ws_col_copy' });
    assert.equal(result.ok, true);

    // 归档里不该有列配置的痕迹
    const exported = exportTableColumns('items');
    assert.ok(!exported.includes('columns'), 'items 的导出列里不该有 columns');

    // 副本拿默认列，不继承源工作区的界面偏好
    const copy = requireWorkspace(dataDir, 'ws_col_copy');
    assert.deepEqual(resolveColumns(copy.columns), DEFAULT_COLUMNS);
  } finally {
    removeTempRoot(root);
  }
});

// ═════════════════════════════════════════════════════════════
// 功能测试这一轮抓到的 bug，逐条固化成回归测试。
// 每条都写清「当初是怎么坏的」，否则以后有人「顺手简化」又会踩回去。
// ═════════════════════════════════════════════════════════════

test('回归：updateRow 里 null 是「清空」而不是「不修改」', () => {
  withWorkspace('w', 'ws_null', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', {
        code: 'N-1',
        name: '有到期日',
        category: 'medicine',
        expires_on: '2027-01-01',
      });
      assert.equal(it['expires_on'], '2027-01-01');

      // 当初这里把 null 当成「不修改」，于是「设为长期」静默失效：
      // 界面和命令都报成功，值却还在 —— 最难查的那类 bug
      const cleared = updateRow(db, 'items', String(it['uuid']), { expires_on: null });
      assert.equal(cleared?.['expires_on'], null, 'null 必须真的把列清空');

      const reread = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true });
      assert.equal(reread?.['expires_on'], null, '再读一遍也应是空的');
    } finally {
      db.close();
    }
  });
});

test('回归：只改一行的一个字段，不会顺手改掉别的字段', () => {
  withWorkspace('w', 'ws_partial', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', {
        code: 'P-1',
        name: '原名',
        category: 'medicine',
        brand: '芬必得',
        model: 'M-1',
        spec: '0.3g×20粒',
        expires_on: '2027-05-01',
        unit_price_cents: '1999',
        store: '山姆',
      });

      updateRow(db, 'items', String(it['uuid']), { name: '新名' });

      const after = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true })!;
      assert.equal(after['name'], '新名');
      for (const [k, v] of Object.entries({
        brand: '芬必得',
        model: 'M-1',
        spec: '0.3g×20粒',
        expires_on: '2027-05-01',
        unit_price_cents: '1999',
        store: '山姆',
      })) {
        assert.equal(after[k], v, `只改名字不该动 ${k}`);
      }
    } finally {
      db.close();
    }
  });
});

test('回归：只给 expires_ym 时按「旧值 + 新值」折算，不把 expires_on 清掉', () => {
  withWorkspace('w', 'ws_ym', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', { code: 'Y-1', name: '按年月', category: 'medicine' });

      // 只给年月 → 应折算出月末
      updateRow(db, 'items', String(it['uuid']), { expires_ym: '2027-02' });
      let row = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true })!;
      assert.equal(row['expires_on'], '2027-02-28', '年月应折算成月末');

      // 再改别的字段，到期日不该被算没
      updateRow(db, 'items', String(it['uuid']), { name: '按年月改名' });
      row = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true })!;
      assert.equal(row['expires_on'], '2027-02-28', '改名字不该影响到期日');

      // 换个年月 → 重新折算
      updateRow(db, 'items', String(it['uuid']), { expires_ym: '2028-02' });
      row = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true })!;
      assert.equal(row['expires_on'], '2028-02-29', '2028 是闰年，2 月末是 29 号');
    } finally {
      db.close();
    }
  });
});

test('回归：写入层拦住日历上不存在的日期', () => {
  withWorkspace('w', 'ws_baddate', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      // 这类脏数据会让后面所有到期计算算出一个凭空捏造的天数
      assert.throws(
        () => insertRow(db, 'items', { code: 'B-1', name: '坏日期', expires_on: '2027-02-30' }),
        /日期/,
        '2 月 30 日应被拒绝',
      );
      assert.throws(
        () => insertRow(db, 'items', { code: 'B-2', name: '坏年份', expires_on: '2027-13-01' }),
        /日期/,
        '13 月应被拒绝',
      );
      assert.throws(
        () => insertRow(db, 'items', { code: 'B-3', name: '非日期', purchased_on: 'abc' }),
        /日期/,
        '非日期文本应被拒绝',
      );

      const good = insertRow(db, 'items', { code: 'B-4', name: '真闰日', expires_on: '2028-02-29' });
      assert.equal(good['expires_on'], '2028-02-29', '闰年的 2 月 29 日是合法的');

      assert.equal(countRows(db, 'items'), 1, '只应有一条合法记录被写进去');
    } finally {
      db.close();
    }
  });
});

test('回归：updateRow 也要拦非法日期', () => {
  withWorkspace('w', 'ws_baddate2', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const it = insertRow(db, 'items', { code: 'C-1', name: '正常', expires_on: '2027-01-01' });
      assert.throws(
        () => updateRow(db, 'items', String(it['uuid']), { expires_on: '2027-02-30' }),
        /日期/,
      );
      const row = selectOne(db, 'items', 'uuid = ?', [String(it['uuid'])], { includeInternal: true })!;
      assert.equal(row['expires_on'], '2027-01-01', '校验失败时不该改坏原值');
    } finally {
      db.close();
    }
  });
});

/**
 * 字段定义里写了 `validation.min/max`，写入层就必须真的执行。
 *
 * 当初是怎么坏的：`validateFieldValue` 只查枚举，`validation` 整个参数
 * 根本没往下传。于是 `unit_price_cents` 上写着 `min: 0`，负价格照样进库 ——
 * 而且因为负数是合法整数，`normalizeValue` 也不报错，命令一路回"已新增"。
 * 这种"约束写在定义里但没人执行"的情况最坑：看代码的人会以为已经挡住了。
 */
test('回归：金额的 min 真的会被执行（负价格进不去）', () => {
  withWorkspace('w', 'ws_money_min', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      // 负数：必须拒
      assert.throws(
        () => insertRow(db, 'items', { code: 'M-1', name: '负价格', unit_price_cents: '-500' }),
        /小于下限/,
        '负数单价应当被拒',
      );
      assert.throws(
        () => insertRow(db, 'items', { code: 'M-2', name: '负总价', amount_cents: '-1' }),
        /小于下限/,
        '负数总价应当被拒',
      );

      // 边界：0 是允许的（赠品），合法正数也要能进
      const zero = insertRow(db, 'items', { code: 'M-3', name: '零元', unit_price_cents: '0' });
      assert.equal(zero['unit_price_cents'], '0', '0 是合法值');

      const ok = insertRow(db, 'items', { code: 'M-4', name: '正常', unit_price_cents: '1234' });
      assert.equal(ok['unit_price_cents'], '1234');

      // updateRow 走同一条校验，也要拦住
      assert.throws(
        () => updateRow(db, 'items', String(ok['uuid']), { unit_price_cents: '-1' }),
        /小于下限/,
        '更新也要拦',
      );
      const after = selectOne(db, 'items', 'uuid = ?', [String(ok['uuid'])], { includeInternal: true })!;
      assert.equal(after['unit_price_cents'], '1234', '校验失败不该改坏原值');
    } finally {
      db.close();
    }
  });
});

test('回归：内部标识只认「PREFIX-数字」，不被库存子行带偏', () => {
  withWorkspace('w', 'ws_code', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const parent = insertRow(db, 'items', {
        code: nextItemCode(db, 'daily'),
        name: '抽纸巾',
        category: 'daily',
        is_bulk: 'true',
        quantity: '10',
      });

      // 造两个库存子行，标识形如 DAY-0001-S1 / DAY-0001-S2
      addStock(db, parent, { quantity: '5', expires_on: '2029-01-01' });
      addStock(db, parent, { quantity: '5', expires_on: '2030-01-01' });

      // 当初用 `LIKE 'DAY-%' ORDER BY code DESC` 取「最大的」，子行的 `-S` 后缀
      // 字典序更靠后，于是解析出 NaN 回落到 0001，直接撞号
      const codes: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const code = nextItemCode(db, 'daily');
        codes.push(code);
        insertRow(db, 'items', { code, name: `第${i}件`, category: 'daily' });
      }
      assert.equal(new Set(codes).size, codes.length, `标识不该重复: ${codes.join(', ')}`);
      for (const c of codes) {
        assert.match(c, /^DAY-\d{4}$/, `标识格式应是 DAY-0000：${c}`);
      }
      // 父项占 0001，所以新的应从 0002 起
      assert.equal(codes[0], 'DAY-0002', '应跳过已占用的编号');

      const all = selectAll(db, 'items').map((r) => String(r['code']));
      assert.equal(new Set(all).size, all.length, '整张表的标识都该唯一');
    } finally {
      db.close();
    }
  });
});

test('回归：编号有空洞时也要找到真正没被占用的那个', () => {
  withWorkspace('w', 'ws_code2', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      // 手工造出 DAY-0001 / DAY-0003（中间是洞）
      insertRow(db, 'items', { code: 'DAY-0001', name: '甲', category: 'daily' });
      insertRow(db, 'items', { code: 'DAY-0003', name: '丙', category: 'daily' });
      // 简单 +1 会给出 0004（浪费洞），这里应补上 0002
      assert.equal(nextItemCode(db, 'daily'), 'DAY-0002', '应补上中间的洞');

      insertRow(db, 'items', { code: 'DAY-0002', name: '乙', category: 'daily' });
      assert.equal(nextItemCode(db, 'daily'), 'DAY-0004', '洞补完了就往后走');
    } finally {
      db.close();
    }
  });
});

test('回归：新建工作区不抢默认（否则命令会落到空工作区上）', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const first = createWorkspace(dataDir, { name: '我的家', id: 'ws_first' });
    assert.equal(readRegistry(dataDir).activeWorkspaceId, first.entry.id, '第一个自动成为默认');

    createWorkspace(dataDir, { name: '父母家', id: 'ws_second' });
    assert.equal(
      readRegistry(dataDir).activeWorkspaceId,
      first.entry.id,
      '再建一个不该把默认抢走 —— 否则之后所有不带 --ws 的命令都会落到这个空工作区上',
    );

    // 显式要求时才切
    createWorkspace(dataDir, { name: '办公室', id: 'ws_third', makeActive: true });
    assert.equal(readRegistry(dataDir).activeWorkspaceId, 'ws_third', '显式 makeActive 才切换');
  } finally {
    removeTempRoot(root);
  }
});


function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-inv-test-'));
}

/**
 * 清理临时目录。
 *
 * Windows 上 SQLite 关闭连接后文件句柄是**异步**释放的，紧接着的同步
 * rmSync 会撞 EPERM。这里做退避重试；仍失败就报出具体是哪个文件被占用，
 * 而不是抛一个没有上下文的 EPERM。
 */
function removeTempRoot(root: string): void {
  let lastErr: unknown = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      // 同步小睡，给 OS 一点时间释放句柄
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (i + 1));
    }
  }
  // 全失败时列出残留文件，便于定位是谁占着
  const leftovers: string[] = [];
  const walk = (dir: string): void => {
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) walk(full);
          else leftovers.push(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  };
  walk(root);
  const base = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`临时目录清理失败。残留文件: ${leftovers.join(', ') || '(空)'}\n原始错误: ${base}`);
}

/** 建一个工作区，返回 { dataDir, entry }，并在回调结束后清理 */
function withWorkspace(name: string, id: string, fn: (dataDir: string, entry: ReturnType<typeof createWorkspace>['entry']) => void): void {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name, id });
    fn(dataDir, ws.entry);
  } finally {
    removeTempRoot(root);
  }
}

/**
 * 把测试里手搓的样本数据当 Row[] 用。
 *
 * 这些字面量对象的属性是「有的有、有的没有」，直接当 Row 会被
 * exactOptionalPropertyTypes 挑刺 —— 而这里本来就是宽松的样本数据，
 * 所以集中在这一处转换，别让类型体操淹没断言本身。
 */
function asRows(list: unknown[]): Row[] {
  return list as unknown as Row[];
}

function cells(values: (string | number)[]): string[] {
  return values.map((v) => String(v));
}

// ─────────────────────────────────────────────────────────────
// 日期
// ─────────────────────────────────────────────────────────────

test('monthEnd 取当月最后一天，含闰年与短月', () => {
  assert.equal(monthEnd('2027-03'), '2027-03-31');
  assert.equal(monthEnd('2027-02'), '2027-02-28');
  assert.equal(monthEnd('2028-02'), '2028-02-29');
  assert.equal(monthEnd('2027-04'), '2027-04-30');
  assert.equal(monthEnd('2027-12'), '2027-12-31');
  assert.equal(monthEnd('2027-01'), '2027-01-31');
});

test('日期字符串校验拦掉不存在的日期', () => {
  assert.equal(isDateString('2027-03-31'), true);
  assert.equal(isDateString('2027-02-30'), false);
  assert.equal(isDateString('2027-13-01'), false);
  assert.equal(isDateString('2027-3-1'), false);
  assert.equal(isDateString('2027/03/01'), false);
  assert.equal(isYearMonth('2027-03'), true);
  assert.equal(isYearMonth('2027-13'), false);
});

test('resolveExpiresOn：显式日期优先，其次年月折算，都没有就是长期', () => {
  assert.equal(resolveExpiresOn('2027-03-15', '2027-06', 'day'), '2027-03-15');
  assert.equal(resolveExpiresOn(null, '2027-06', 'month'), '2027-06-30');
  assert.equal(resolveExpiresOn('', '2027-06', 'month'), '2027-06-30');
  assert.equal(resolveExpiresOn(null, null, 'none'), null);
  assert.equal(resolveExpiresOn('2027-03-15', null, 'none'), '2027-03-15');
});

test('daysBetween / daysUntil 按日历日计算', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-02'), 1);
  assert.equal(daysBetween('2026-01-01', '2026-01-01'), 0);
  assert.equal(daysBetween('2026-01-02', '2026-01-01'), -1);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysUntil(today()), 0);
  assert.equal(daysUntil(addDays(today(), 10)!), 10);
});

test('addMonths 处理月末夹取（1/31 + 1 月 = 2/28）', () => {
  assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2027-03-15', -1), '2027-02-15');
});

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────

test('CSV 往返：引号、逗号、换行、中文、前导零', () => {
  const header = ['a', 'b', 'c', 'd', 'e'];
  const rows = [
    ['带"引号"', '含,逗号', '含\n换行', '中文名称', '0012345'],
    ['普通', '另一个', 'x', '规格 0.25g×24粒', '2027-03'],
  ];
  const parsed = parseCsv(serializeCsv(header, rows));

  assert.deepEqual(parsed.header, header);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], ['带"引号"', '含,逗号', '含\n换行', '中文名称', '0012345']);
  assert.deepEqual(parsed.rows[1], ['普通', '另一个', 'x', '规格 0.25g×24粒', '2027-03']);
});

test('CSV 空值语义：空单元格与 \\N 都归一为空值，导出永不写哨兵', () => {
  const text = serializeCsv(['x'], [[''], ['\\N'], ['v']]);
  assert.equal(text.charCodeAt(0), 0xfeff, '应以 BOM 开头');

  const parsed = parseCsv(text);
  assert.equal(parsed.rows.length, 2, '空单元格行按空白行跳过');
  assert.equal(cellToRaw(parsed.rows[0]![0]), null, '\\N → 空值（兼容解析）');
  assert.equal(cellToRaw(parsed.rows[1]![0]), 'v');
  assert.equal(cellToRaw(undefined), null, '缺失列 → 空值');
  assert.equal(cellToRaw('   '), null, '只有空白的单元格也按空值处理');
  assert.equal(cellToRaw('x'), 'x');

  assert.equal(rawToCell(null), '');
  assert.equal(rawToCell(undefined), '');
  assert.equal(rawToCell(''), '');
  assert.equal(rawToCell(true), 'true');
  assert.equal(rawToCell(0), '0', '数字 0 不能被当成空值');
});

test('CSV 序列化：空值写空单元格，非空值加引号', () => {
  const text = serializeCsv(['a', 'b', 'c', 'd'], [['', null as unknown as string, 'x', 0]]);
  assert.equal(text, '\uFEFF"a","b","c","d"\r\n,,"x","0"\r\n');

  const back = parseCsv(text).rows[0]!;
  assert.equal(back[0], '', '空值');
  assert.equal(back[1], '', '空值');
  assert.equal(cellToRaw(back[2]), 'x');
  assert.equal(cellToRaw(back[3]), '0');
});

test('CSV 忽略完全空白的行（Excel 常见尾部空行）', () => {
  const parsed = parseCsv('a,b\r\n1,2\r\n\r\n,\r\n3,4\r\n');
  assert.equal(parsed.rows.length, 2, '空行与 ,, 行都应被跳过');
  assert.deepEqual(parsed.rows[0], ['1', '2']);
  assert.deepEqual(parsed.rows[1], ['3', '4']);
});

test('CSV 表头检查：别名可救回中文表头，缺列会报错', () => {
  const ok = parseCsv('名称,code\n甲,X\n', {
    expectedHeader: ['name', 'code'],
    aliases: { 名称: 'name' },
  });
  assert.equal(ok.issues.filter((i) => i.message.includes('缺少必需列')).length, 0);

  const bad = parseCsv('code\nX\n', { expectedHeader: ['name', 'code'] });
  assert.ok(bad.issues.some((i) => i.message.includes('缺少必需列')));
});

// ─────────────────────────────────────────────────────────────
// 值转换
// ─────────────────────────────────────────────────────────────

test('normalizeFromCsv 按类型校验并拒绝非法值', () => {
  assert.equal(normalizeFromCsv('42', 'int', 'n'), '42');
  assert.throws(() => normalizeFromCsv('4.5', 'int', 'n'), /期望整数/);
  assert.equal(normalizeFromCsv('true', 'bool', 'b'), 'true');
  assert.equal(normalizeFromCsv('1', 'bool', 'b'), 'true');
  assert.equal(normalizeFromCsv('否', 'bool', 'b'), 'false');
  assert.throws(() => normalizeFromCsv('maybe', 'bool', 'b'), /布尔/);
  assert.equal(normalizeFromCsv('2027-03-01', 'date', 'd'), '2027-03-01');
  assert.throws(() => normalizeFromCsv('2027-02-30', 'date', 'd'), /日期/);
  assert.throws(() => normalizeFromCsv('2027-13', 'year_month', 'ym'), /年月/);
  assert.equal(normalizeFromCsv('', 'int', 'n'), '', '空串保留原样，落库按空值处理');
  assert.equal(normalizeFromCsv(null, 'int', 'n'), null, '未提供 → 空值');
});

test('金额用整数分表示，元分互转不丢精度', () => {
  assert.equal(yuanToCents('19.30'), 1930);
  assert.equal(yuanToCents(19.3), 1930);
  assert.equal(yuanToCents('0.1'), 10);
  assert.equal(centsToYuan(1930), '19.30');
  assert.equal(centsToYuan(10), '0.10');
  assert.equal(centsToYuan(null), '');
  assert.equal(yuanToCents(19.99), 1999, '浮点陷阱：19.99*100 不应变成 1998');
});

test('deriveExpiryColumns：只给年月折算成月末，没有到期日就是长期', () => {
  // 只给年月 → 月末
  assert.equal(deriveExpiryColumns({ expires_ym: '2027-02' })['expires_on'], '2027-02-28');
  // 明确的到期日原样保留
  assert.equal(deriveExpiryColumns({ expires_on: '2027-05-01' })['expires_on'], '2027-05-01');
  // 都没有 → 长期，两个到期列都清空
  const none = deriveExpiryColumns({ expires_on: null, expires_ym: null });
  assert.equal(none['expires_on'], null);
  assert.equal(none['expires_ym'], null);
  assert.equal(none['expiry_precision'], 'none');
  // 有到期日时精度归一为 day（这个字段现在只是旧数据兼容，不再有业务含义）
  assert.equal(deriveExpiryColumns({ expires_on: '2027-05-01' })['expiry_precision'], 'day');
});

// ─────────────────────────────────────────────────────────────
// UUID / schema / manifest
// ─────────────────────────────────────────────────────────────

test('uuidv7 合法且按时间递增', () => {
  const a = uuidv7(1000);
  const b = uuidv7(2000);
  assert.ok(isUuid(a));
  assert.ok(isUuid(b));
  assert.equal(a[14], '7', '版本位应为 7');
  assert.ok(a < b, '字典序应等于时间序');
});

test('结构：只有 items 与 stock_moves，没有 batches；有 parent_uuid', () => {
  const ddl = buildDdl().join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS items/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS stock_moves/);
  assert.ok(!ddl.includes('CREATE TABLE IF NOT EXISTS batches'), '不应再创建 batches 表');
  assert.match(ddl, /REFERENCES items\(uuid\) ON DELETE CASCADE/);
  assert.match(ddl, /trg_items_updated_at/);
  for (const col of ['quantity', 'remaining', 'purchased_on', 'expires_on', 'unit_price_cents', 'store', 'status', 'is_bulk', 'parent_uuid', 'sort_order', 'brand', 'model', 'spec', 'extra_json']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(ddl), `items 应包含 ${col}`);
  }
  assert.equal(SCHEMA_VERSION, 8);
});

test('品牌与型号是两个独立字段，都可选填', () => {
  withWorkspace('w', 'ws_model', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      // 只填品牌不填型号
      const a = insertRow(db, 'items', { code: 'M-1', name: '布洛芬', category: 'medicine', brand: '芬必得' });
      assert.equal(a['brand'], '芬必得');
      assert.equal(a['model'], null, '型号没填就是空，不该被品牌带着走');

      // 只填型号不填品牌
      const b = insertRow(db, 'items', { code: 'M-2', name: '鼠标', category: 'digital', model: 'MX Master 3S' });
      assert.equal(b['brand'], null);
      assert.equal(b['model'], 'MX Master 3S');

      // 两个都填，且与规格互不干扰
      const c = insertRow(db, 'items', {
        code: 'M-3',
        name: '移动电源',
        category: 'digital',
        brand: 'Anker',
        model: 'A1287',
        spec: '20000mAh',
      });
      assert.equal(c['brand'], 'Anker');
      assert.equal(c['model'], 'A1287');
      assert.equal(c['spec'], '20000mAh', '规格与型号是两回事，不能互相覆盖');

      // 两个都不填也完全正常（都是选填）
      const d = insertRow(db, 'items', { code: 'M-4', name: '雨伞', category: 'other' });
      assert.equal(d['brand'], null);
      assert.equal(d['model'], null);
    } finally {
      db.close();
    }
  });
});

test('品牌与型号要进导出包，并原样还原', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '源', id: 'ws_m' });
    const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
    try {
      insertRow(db, 'items', { code: 'D-1', name: '移动电源', category: 'digital', brand: 'Anker', model: 'A1287', spec: '20000mAh' });
      insertRow(db, 'items', { code: 'D-2', name: '无线鼠标', category: 'digital', model: 'MX Master 3S' });
      insertRow(db, 'items', { code: 'D-3', name: '雨伞', category: 'other' });
    } finally {
      db.close();
    }

    const archive = join(root, 'm.zip');
    exportWorkspace(dataDir, ws.entry, { outPath: archive });
    const result = importArchive(archive, { dataDir, name: '副本', id: 'ws_m2' });
    assert.equal(result.ok, true, JSON.stringify(result.preview.issues));

    const db2 = openDatabase(workspaceDbPath(dataDir, requireWorkspace(dataDir, 'ws_m2')), { readOnly: true });
    try {
      const byName = new Map(selectAll(db2, 'items').map((r) => [String(r['name']), r]));
      const power = byName.get('移动电源')!;
      assert.equal(power['brand'], 'Anker');
      assert.equal(power['model'], 'A1287');
      assert.equal(power['spec'], '20000mAh');
      const mouse = byName.get('无线鼠标')!;
      assert.equal(mouse['brand'], null, '原本空的品牌不能变成空串');
      assert.equal(mouse['model'], 'MX Master 3S');
      const umbrella = byName.get('雨伞')!;
      assert.equal(umbrella['brand'], null);
      assert.equal(umbrella['model'], null);
    } finally {
      db2.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

// ─────────────────────────────────────────────────────────────
// 手动顺序 / 排序 / 分组树
// ─────────────────────────────────────────────────────────────

test('新记录自动排到末尾，手动顺序可以整份重写', () => {
  withWorkspace('w', 'ws_order', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const a = insertRow(db, 'items', { code: 'A-1', name: '甲', category: 'medicine' });
      const b = insertRow(db, 'items', { code: 'A-2', name: '乙', category: 'medicine' });
      const c = insertRow(db, 'items', { code: 'A-3', name: '丙', category: 'medicine' });

      // 新记录依次排到末尾
      assert.ok(Number(a['sort_order']) < Number(b['sort_order']));
      assert.ok(Number(b['sort_order']) < Number(c['sort_order']));

      // 整份重写：丙 → 甲 → 乙
      applyItemOrder(db, [String(c['uuid']), String(a['uuid']), String(b['uuid'])]);
      const rows = selectWhere(db, 'items', TOP_LEVEL, []);
      const byOrder = [...rows].sort((x, y) => Number(x['sort_order']) - Number(y['sort_order']));
      assert.deepEqual(byOrder.map((r) => r['name']), ['丙', '甲', '乙']);

      // 步长留了空隙：插到中间不用整体重排
      assert.equal(Number(byOrder[1]!['sort_order']) - Number(byOrder[0]!['sort_order']), 10);
    } finally {
      db.close();
    }
  });
});

test('迁移时给老数据补上手动顺序，且保持原相对次序', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: 'w', id: 'ws_backfill' });
    const dbPath = workspaceDbPath(dataDir, ws.entry);

    // 手工造一个「有 items 但没有 sort_order」的中间版本库
    {
      const db = openDatabase(dbPath);
      try {
        db.exec('DROP TABLE IF EXISTS items');
        db.exec(`CREATE TABLE items (uuid TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          category TEXT, brand TEXT, spec TEXT, unit TEXT, room TEXT, container TEXT,
          is_bulk INTEGER, quantity INTEGER, remaining INTEGER, min_stock INTEGER,
          purchased_on TEXT, unit_price_cents INTEGER, amount_cents INTEGER, store TEXT,
          expires_on TEXT, expires_ym TEXT, expiry_precision TEXT, opened_on TEXT,
          warranty_months INTEGER, warranty_until TEXT, status TEXT, is_prescription INTEGER,
          open_shelf_life_days INTEGER, serial_no TEXT, photo_path TEXT, notes TEXT, tags TEXT,
          created_at TEXT, updated_at TEXT)`);
        db.exec('PRAGMA user_version = 5');
        db.exec(`INSERT INTO items (uuid, code, name, category, is_bulk, quantity, remaining, status)
                 VALUES ('u1','A-1','先插的','daily',0,1,1,'in_stock')`);
        db.exec(`INSERT INTO items (uuid, code, name, category, is_bulk, quantity, remaining, status)
                 VALUES ('u2','A-2','后插的','daily',0,1,1,'in_stock')`);
      } finally {
        // 漏掉 close 的话，Windows 上这个临时目录就删不掉了
        db.close();
      }
    }

    const db = openDatabase(dbPath);
    try {
      const rows = selectWhere(db, 'items', TOP_LEVEL, []);
      const byOrder = [...rows].sort((x, y) => Number(x['sort_order']) - Number(y['sort_order']));
      assert.deepEqual(byOrder.map((r) => r['name']), ['先插的', '后插的'], '按插入顺序补号');
      for (const r of rows) assert.ok(r['sort_order'] !== null, '每条都要有手动顺序');
    } finally {
      db.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

test('排序字段：每个都能排，且都不改变物品集合', () => {
  const items = asRows([
    { uuid: 'b', name: '乙', category: 'medicine', remaining: '3', quantity: '3', expires_on: '2027-01-01', purchased_on: '2026-05-01', room: '客厅', unit_price_cents: '500', created_at: '2026-02-01', sort_order: '20' },
    { uuid: 'a', name: '甲', category: 'medicine', remaining: '1', quantity: '1', expires_on: '2026-06-01', purchased_on: '2026-01-01', room: '厨房', unit_price_cents: '900', created_at: '2026-01-01', sort_order: '10' },
    { uuid: 'c', name: '丙', category: 'medicine', remaining: '9', quantity: '9', sort_order: '30' },
  ]);

  for (const f of SORT_FIELDS) {
    const sorted = sortItems(items, f.key);
    assert.equal(sorted.length, items.length, `${f.key} 不该丢物品`);
    assert.deepEqual(
      sorted.map((r) => r['uuid']).sort(),
      ['a', 'b', 'c'],
      `${f.key} 不该改物品集合`,
    );
  }

  // 手动顺序 = sort_order
  assert.deepEqual(sortItems(items, 'manual').map((r) => r['uuid']), ['a', 'b', 'c']);
  // 到期日升序，没有到期日的垫底
  assert.deepEqual(sortItems(items, 'expiry').map((r) => r['uuid']), ['a', 'b', 'c']);
  // 名称、位置升序
  assert.equal(String(sortItems(items, 'name')[0]!['name']), '丙');
  // 数量、剩余、价格、添加时间都是降序
  assert.equal(String(sortItems(items, 'quantity')[0]!['uuid']), 'c');
  assert.equal(String(sortItems(items, 'remaining')[0]!['uuid']), 'c');
  assert.equal(String(sortItems(items, 'price')[0]!['uuid']), 'a');
  assert.equal(String(sortItems(items, 'created')[0]!['uuid']), 'b');
  assert.equal(String(sortItems(items, 'purchased')[0]!['uuid']), 'b');
});

test('三级分组：分类 → 子类 → 标签，层级可以只展开到需要的那层', () => {
  const items = asRows([
    { uuid: '1', name: '感冒灵', category: 'medicine', subcategory: '感冒药', tags: '常备,儿童' },
    { uuid: '2', name: '布洛芬', category: 'medicine', subcategory: '退烧', tags: '常备' },
    { uuid: '3', name: '抽纸巾', category: 'daily', tags: '囤货' },
    { uuid: '4', name: '神秘物', category: '', tags: '' },
  ]);

  // 一级：只有分类
  const l1 = buildTree(items, { levels: 1, sort: 'manual', order: {} });
  assert.deepEqual(l1.nodes.map((n) => n.key), ['', 'medicine', 'daily']);
  assert.equal(l1.nodes[0]!.label, '未分类');
  assert.equal(l1.nodes[0]!.pinned, true, '未分类永远置顶且不可拖');
  for (const n of l1.nodes) assert.equal(n.children.length, 0, '一级不该有子分组');

  // 二级：再加子类
  const l2 = buildTree(items, { levels: 2, sort: 'manual', order: {} });
  const med = l2.nodes.find((n) => n.key === 'medicine')!;
  assert.deepEqual(med.children.map((c) => c.label).sort(), ['感冒药', '退烧']);
  assert.equal(med.items.length, 0, '有子分组时物品都沉到叶子');
  assert.equal(med.count, 2);

  // 三级：再加标签；一个物品有多个标签就会出现在多组里
  const l3 = buildTree(items, { levels: 3, sort: 'manual', order: {} });
  const med3 = l3.nodes.find((n) => n.key === 'medicine')!;
  const ganmao = med3.children.find((c) => c.label === '感冒药')!;
  assert.deepEqual(ganmao.children.map((c) => c.label).sort(), ['儿童', '常备']);
  assert.equal(l3.maxLevel, 3);

  // 没有子类的落到「未分子类」，没有标签的落到「无标签」
  const daily = l3.nodes.find((n) => n.key === 'daily')!;
  assert.equal(daily.children[0]!.label, '未分子类');
  assert.equal(daily.children[0]!.children[0]!.label, '囤货');
});

test('未分类永远置顶，且排序与拖动都动不了它', () => {
  const items = asRows([
    { uuid: '1', name: '有分类', category: 'medicine' },
    { uuid: '2', name: '没分类', category: '' },
  ]);

  // 即使顺序表把它排到最后，它也还在最前
  const tree = buildTree(items, {
    levels: 1,
    sort: 'manual',
    order: { '': ['medicine', ''] },
  });
  assert.equal(tree.nodes[0]!.key, '', '未分类必须第一个');
  assert.equal(tree.nodes[0]!.pinned, true);
  assert.equal(tree.nodes[1]!.pinned, false);

  // 分类留空（不是 'other'）才算未分类
  const withOther = asRows([{ uuid: '3', name: '其他类', category: 'other' }]);
  const t2 = buildTree(withOther, { levels: 1, sort: 'manual', order: {} });
  assert.equal(t2.nodes[0]!.key, 'other');
  assert.equal(t2.nodes[0]!.pinned, false, '「其他」是有分类，不该被置顶固定');
  assert.equal(uncategorizedCount(withOther), 0);
});

/**
 * 「未分类」那一组的 `count` 必须等于全库未分类件数。
 *
 * 界面上的悬停说明用的是组自己的 `count`，而原来的顶部横幅用的是
 * `uncategorizedCount(items)`。两个数若不等，提示就会说谎 ——
 * 这条把两者的等价关系钉住，任何一级分组都成立。
 */
test('「未分类」组的 count 等于全库未分类件数（各层级都成立）', () => {
  const items = asRows([
    { uuid: '1', name: '有分类', category: 'medicine', subcategory: '感冒药', tags: '常备' },
    { uuid: '2', name: '没分类但有子类', category: '', subcategory: '待定' },
    { uuid: '3', name: '没分类也没子类', category: '' },
    { uuid: '4', name: '没分类有标签', category: '', tags: '回头再说' },
    { uuid: '5', name: '另一件有分类', category: 'food', subcategory: '乳制品' },
  ]);

  const expected = uncategorizedCount(items);
  assert.equal(expected, 3, '夹具本身：3 件没分类');

  for (const levels of [1, 2, 3] as const) {
    const tree = buildTree(items, { levels, sort: 'manual', order: {} });
    const pinned = tree.nodes.find((n) => n.pinned);
    assert.ok(pinned, `${levels} 级也该有置顶组`);
    assert.equal(pinned!.label, '未分类');
    assert.equal(pinned!.count, expected, `${levels} 级下 count 应等于 ${expected}`);
    // 置顶的必须是第一个，且带子类/标签时它仍然只有一棵子树、总数不变
    assert.equal(tree.nodes[0]!.key, '', `${levels} 级下未分类仍在最前`);
  }
});

test('组顺序可以拖动固定；排序只影响组内物品，不影响分组', () => {
  const items = asRows([
    { uuid: '1', name: '甲', category: 'medicine', expires_on: '2027-01-01', sort_order: '10' },
    { uuid: '2', name: '乙', category: 'medicine', expires_on: '2026-06-01', sort_order: '20' },
    { uuid: '3', name: '丙', category: 'daily', expires_on: '2026-01-01', sort_order: '30' },
  ]);

  // 拖动固定：日用品排到药品前面
  const dragged = buildTree(items, {
    levels: 1,
    sort: 'manual',
    order: { '': ['daily', 'medicine'] },
  });
  assert.deepEqual(dragged.nodes.map((n) => n.key), ['daily', 'medicine']);

  // 换成按到期时间排：分组顺序保持不变，只有组内变了
  const sorted = buildTree(items, {
    levels: 1,
    sort: 'expiry',
    order: { '': ['daily', 'medicine'] },
  });
  assert.deepEqual(sorted.nodes.map((n) => n.key), ['daily', 'medicine'], '排序不该改变分组顺序');
  const med = sorted.nodes.find((n) => n.key === 'medicine')!;
  assert.deepEqual(med.items.map((r) => r['name']), ['乙', '甲'], '组内按到期日升序');
});

test('分组与排序互相独立：排序关掉后回到手工顺序', () => {
  const items = asRows([
    { uuid: '1', name: '先', category: 'medicine', expires_on: '2027-01-01', sort_order: '10' },
    { uuid: '2', name: '后', category: 'medicine', expires_on: '2026-01-01', sort_order: '20' },
  ]);
  const manual = buildTree(items, { levels: 1, sort: 'manual', order: {} });
  assert.deepEqual(manual.nodes[0]!.items.map((r) => r['name']), ['先', '后']);

  const byExpiry = buildTree(items, { levels: 1, sort: 'expiry', order: {} });
  assert.deepEqual(byExpiry.nodes[0]!.items.map((r) => r['name']), ['后', '先']);

  // 手动顺序没有被改写，所以关掉排序就回来了
  const back = buildTree(items, { levels: 1, sort: 'manual', order: {} });
  assert.deepEqual(back.nodes[0]!.items.map((r) => r['name']), ['先', '后']);
});

test('分组顺序存在工作区偏好里，跟着注册表走', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: 'w', id: 'ws_prefs' });

    updateWorkspacePrefs(dataDir, ws.entry.id, {
      groupOrder: { '': ['daily', 'medicine'] },
      groupLevels: 2,
      sortField: 'expiry',
      collapsed: ['medicine'],
    });

    const again = requireWorkspace(dataDir, 'ws_prefs');
    assert.deepEqual(again.groupOrder, { '': ['daily', 'medicine'] });
    assert.equal(again.groupLevels, 2);
    assert.equal(again.sortField, 'expiry');
    assert.deepEqual(again.collapsed, ['medicine']);

    // 层级夹到 1~3
    updateWorkspacePrefs(dataDir, ws.entry.id, { groupLevels: 99 });
    assert.equal(requireWorkspace(dataDir, 'ws_prefs').groupLevels, 3);
    updateWorkspacePrefs(dataDir, ws.entry.id, { groupLevels: 0 });
    assert.equal(requireWorkspace(dataDir, 'ws_prefs').groupLevels, 1);
  } finally {
    removeTempRoot(root);
  }
});

test('manifest 由字段定义派生，且不含内部列', () => {
  const manifest = buildManifest({
    workspace: { id: 'ws_x', name: '测试', createdAt: '2026-01-01T00:00:00.000Z', source: 'blank' },
    rowCounts: { items: 1, stock_moves: 3 },
    exportedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(manifest.format, 'dsh-inventory-archive');
  assert.equal(manifest.csv.nullLiteral, CSV_CONVENTION.nullLiteral);
  assert.deepEqual(
    manifest.tables.map((t) => t.name),
    ['items', 'stock_moves'],
  );

  const items = manifest.tables.find((t) => t.name === 'items')!;
  const names = items.columns.filter((c) => c.exported).map((c) => c.name);

  // 取消编号：内部标识不出现在导出包里
  assert.ok(!names.includes('code'), '编号不应再导出');
  assert.ok(names.includes('parent_uuid'), '父子关系必须导出，否则导入后一组库存会散架');
  assert.ok(!names.includes('expiry_precision'), '到期类型已取消，不导出');
  assert.ok(!names.includes('is_critical'), '关键物品已取消，不导出');
  // 仍然导出的关键列
  for (const col of ['name', 'category', 'is_bulk', 'quantity', 'remaining', 'expires_on']) {
    assert.ok(names.includes(col), `应导出 ${col}`);
  }
  assert.deepEqual(names, exportTableColumns('items'));
});

test('validateManifest 拒绝错误格式与过高版本', () => {
  const good = buildManifest({
    workspace: { id: 'a', name: 'n', createdAt: 'x', source: 'blank' },
    rowCounts: {},
    exportedAt: 'x',
  });
  assert.equal(validateManifest(good).ok, true);
  assert.equal(validateManifest({ format: 'something-else' }).ok, false);

  const v = validateManifest({ ...good, formatVersion: 999 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('高于当前支持版本')));
});

// ─────────────────────────────────────────────────────────────
// 到期与「长期」
// ─────────────────────────────────────────────────────────────

test('expirySources 认出三类到期来源', () => {
  const item = {
    expires_on: '2027-01-01',
    warranty_until: '2027-06-01',
    opened_on: '2026-01-01',
    open_shelf_life_days: '28',
  };
  const kinds = expirySources(item).map((s) => s.kind);
  assert.deepEqual(kinds, ['保质期', '质保期', '开封后有效期']);
  assert.equal(expirySources(item)[2]!.expiresOn, '2026-01-29', '开封日 + 28 天');
});

test('「长期」= 完全没有到期日，不参与到期提示', () => {
  assert.equal(isLongTerm({}), true);
  assert.equal(isLongTerm({ expires_on: null, warranty_until: null, opened_on: null }), true);
  assert.equal(isLongTerm({ expires_on: '2027-01-01' }), false);
  assert.equal(isLongTerm({ warranty_until: '2027-01-01' }), false, '只有质保期也算有到期日');

  assert.deepEqual(expiriesForItem({}), [], '长期物品没有任何到期条目');
  assert.equal(summarizeOverview(asRows([{ uuid: 'a', category: 'other', remaining: '1' }]), { id: 'w', name: 'w' }).counts.longTerm, 1);
});

test('剩余为 0 的物品不参与分组与提醒', () => {
  const items = [
    { uuid: 'a', name: '用完了', category: 'medicine', remaining: '0', expires_on: '2020-01-01' },
    { uuid: 'b', name: '还在', category: 'medicine', remaining: '1', expires_on: '2020-01-01' },
  ];
  const groups = groupByCategory(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.entries.length, 1, '用完的那条不进组');
  assert.equal(groups[0]!.entries[0]!.item['uuid'], 'b');
});

// ─────────────────────────────────────────────────────────────
// 分组与排序（取代原来的严重度分级）
// ─────────────────────────────────────────────────────────────

test('按分类分组，组内按到期日升序，长期沉到组尾', () => {
  const now = new Date(2026, 0, 1);
  const items = [
    { uuid: 'm2', name: '药B', category: 'medicine', remaining: '1', expires_on: '2026-06-01' },
    { uuid: 'm1', name: '药A', category: 'medicine', remaining: '1', expires_on: '2026-02-01' },
    { uuid: 'm3', name: '长期药', category: 'medicine', remaining: '1' },
    { uuid: 'd1', name: '纸巾', category: 'daily', remaining: '3', expires_on: '2026-03-01' },
  ];
  const groups = groupByCategory(asRows(items), now);

  assert.deepEqual(groups.map((g) => g.key), ['medicine', 'daily'], '组间按枚举顺序，位置稳定');

  const med = groups.find((g) => g.key === 'medicine')!;
  assert.deepEqual(med.entries.map((e) => e.item['uuid']), ['m1', 'm2'], '组内按到期日升序');
  assert.deepEqual(med.longTerm.map((l) => l.item['uuid']), ['m3'], '长期在组尾单独列出');
  assert.equal(med.counts.items, 3);
  assert.equal(med.counts.total, 2, '只有 2 条有到期日');

  assert.equal(categoryLabel('medicine'), '药品');
});

test('已过期的排在组内最前，并被标记 expired', () => {
  const now = new Date(2026, 5, 1);
  const items = [
    { uuid: 'a', name: '还早', category: 'medicine', remaining: '1', expires_on: '2026-12-01' },
    { uuid: 'b', name: '过期了', category: 'medicine', remaining: '1', expires_on: '2026-01-01' },
  ];
  const g = groupByCategory(asRows(items), now)[0]!;
  assert.equal(g.entries[0]!.item['uuid'], 'b', '过期的排在前面');
  assert.equal(g.entries[0]!.expired, true);
  assert.equal(g.entries[1]!.expired, false);
  assert.equal(g.counts.expired, 1);
});

test('概览计数：过期 / 15 天内 / 长期 / 待补货，没有分级字段', () => {
  const now = new Date(2026, 0, 1);
  const items = [
    { uuid: 'a', name: '过期', category: 'medicine', remaining: '1', expires_on: '2025-12-01' },
    { uuid: 'b', name: '快到了', category: 'medicine', remaining: '1', expires_on: '2026-01-10' },
    { uuid: 'c', name: '还早', category: 'medicine', remaining: '1', expires_on: '2027-01-01' },
    { uuid: 'd', name: '长期', category: 'medicine', remaining: '1' },
    { uuid: 'e', name: '要补货', category: 'daily', remaining: '1', min_stock: '5' },
  ];
  const s = summarizeOverview(asRows(items), { id: 'w', name: 'w' }, now);

  assert.equal(s.counts.expired, 1);
  assert.equal(s.counts.soon, 1, '9 天后到期，算 15 天内');
  assert.equal(s.counts.dated, 3, '三条有到期日');
  assert.equal(s.counts.longTerm, 2, '「长期」和没填到期日的「要补货」都算长期');
  assert.equal(s.counts.lowStock, 1);
  assert.match(s.headline, /已过期/);
  assert.match(s.headline, /15 天内到期/, '文案要说 15 天');
  // 旧的分级字段不该再出现
  assert.ok(!('expired' in s && Array.isArray((s as unknown as Record<string, unknown>)['expired'])));
});

test('窗口是 15 天：第 16 天不算，第 15 天算', () => {
  const now = new Date(2026, 0, 1);
  const mk = (name: string, on: string) => ({ uuid: name, name, category: 'daily', remaining: '1', expires_on: on });
  const s = summarizeOverview(
    asRows([mk('十四天', '2026-01-15'), mk('十五天', '2026-01-16'), mk('十六天', '2026-01-17')]),
    { id: 'w', name: 'w' },
    now,
  );
  assert.equal(SOON_DAYS, 15, '窗口就是 15 天');
  assert.equal(s.counts.soon, 2, '14 天和 15 天各算一条，16 天不算');
});

test('过保不计入「已过期」与「15 天内到期」', () => {
  const now = new Date(2026, 0, 1);
  const items = [
    // 只有质保期，且已经过了
    { uuid: 'w1', name: '过保的鼠标', category: 'digital', remaining: '1', warranty_until: '2025-06-01' },
    // 只有质保期，快到了
    { uuid: 'w2', name: '快过保的路由器', category: 'digital', remaining: '1', warranty_until: '2026-01-10' },
    // 真的过期
    { uuid: 'e1', name: '过期的药', category: 'medicine', remaining: '1', expires_on: '2025-12-01' },
    // 快到期的药
    { uuid: 'e2', name: '快过期的药', category: 'medicine', remaining: '1', expires_on: '2026-01-10' },
  ];
  const s = summarizeOverview(asRows(items), { id: 'w', name: 'w' }, now);

  assert.equal(s.counts.expired, 1, '只有药算过期，过保的鼠标不算');
  assert.equal(s.counts.soon, 1, '只有药算 15 天内，快过保的不算');
  assert.equal(s.counts.warrantyExpired, 1, '过保单列一项');
  // headline 是高亮用的，过保不该出现
  assert.ok(!/过保/.test(s.headline), `headline 不该提过保：${s.headline}`);
  assert.match(s.headline, /1 项已过期/);
  assert.match(s.headline, /1 项 15 天内到期/);
});

test('一件东西既有保质期又有质保期时，按各自来源分别归类', () => {
  const now = new Date(2026, 0, 1);
  const items = [
    {
      uuid: 'both',
      name: '既有保质期也有质保',
      category: 'digital',
      remaining: '1',
      expires_on: '2026-01-10', // 快过期
      warranty_until: '2025-01-01', // 已过保
    },
  ];
  const s = summarizeOverview(asRows(items), { id: 'w', name: 'w' }, now);
  assert.equal(s.counts.soon, 1, '保质期那条算 15 天内');
  assert.equal(s.counts.expired, 0, '质保期那条不算过期');
  assert.equal(s.counts.warrantyExpired, 1, '质保期那条算过保');
});

test('开封后有效期算「过期」，质保期算「过保」', () => {
  assert.equal(classifyKind(KIND_SHELF_LIFE), 'expire');
  assert.equal(classifyKind(KIND_OPENED), 'expire', '开封后有效期是"不能用了"，算过期');
  assert.equal(classifyKind(KIND_WARRANTY), 'warranty');
});

test('worstExpireEntry 不看质保期 —— 只有质保期的物品不报红', () => {
  const now = new Date(2026, 0, 1);
  const warrantyOnly = asRows([
    { uuid: 'w', name: '只有质保', category: 'digital', remaining: '1', warranty_until: '2025-01-01' },
  ])[0]!;
  assert.equal(worstExpireEntry(warrantyOnly, now), undefined, '过保不该产生"最坏条目"');

  const both = asRows([
    {
      uuid: 'b',
      name: '两个都有',
      category: 'digital',
      remaining: '1',
      expires_on: '2026-01-10',
      warranty_until: '2025-01-01',
    },
  ])[0]!;
  const worst = worstExpireEntry(both, now);
  assert.equal(worst?.kind, KIND_SHELF_LIFE, '要挑保质期那条，不是质保期');
});

test('isSoon 只认「过期」类且不认已过期', () => {
  const now = new Date(2026, 0, 1);
  const rows = asRows([
    { uuid: 'a', name: '快过期', category: 'daily', remaining: '1', expires_on: '2026-01-10' },
    { uuid: 'b', name: '已过期', category: 'daily', remaining: '1', expires_on: '2025-12-01' },
    { uuid: 'c', name: '快过保', category: 'daily', remaining: '1', warranty_until: '2026-01-10' },
    { uuid: 'd', name: '已过保', category: 'daily', remaining: '1', warranty_until: '2025-12-01' },
  ]);
  const soon = rows.flatMap((r) => expiriesForItem(r, now)).filter((e) => isSoon(e));
  assert.equal(soon.length, 1, '只有"快过期"那条');
  assert.equal(soon[0]!.kind, KIND_SHELF_LIFE);
});

test('分组树的过保单独数，不进 expired / soon', () => {
  const items = asRows([
    { uuid: 'a', name: '过保', category: 'digital', remaining: '1', warranty_until: '2025-01-01' },
    { uuid: 'b', name: '过期', category: 'digital', remaining: '1', expires_on: '2025-01-01' },
    { uuid: 'c', name: '快过期', category: 'digital', remaining: '1', expires_on: '2026-01-10' },
    { uuid: 'd', name: '长期', category: 'digital', remaining: '1' },
  ]);
  const tree = buildTree(items, { levels: 1, sort: 'manual', order: {}, now: new Date(2026, 0, 1) });
  const node = tree.nodes.find((n) => n.key === 'digital')!;
  assert.equal(node.expired, 1, '只有"过期"那条');
  assert.equal(node.soon, 1, '只有"快过期"那条');
  assert.equal(node.warranty, 1, '过保单独数');
  assert.equal(node.longTerm, 1, '长期只算真的没有到期日的');
});

test('只有质保期的物品不算「长期」，但也不进提醒', () => {
  const items = asRows([
    { uuid: 'w', name: '只有质保', category: 'digital', remaining: '1', warranty_until: '2030-01-01' },
  ]);
  const tree = buildTree(items, { levels: 1, sort: 'manual', order: {}, now: new Date(2026, 0, 1) });
  const node = tree.nodes.find((n) => n.key === 'digital')!;
  // 它确实有日期要记，所以不算"长期"；但也不报红、不报快到期
  assert.equal(node.longTerm, 0, '有质保日期就不算长期');
  assert.equal(node.expired, 0);
  assert.equal(node.soon, 0);
});

test('待补货只认设了最低库存的物品', () => {
  const items = [
    { uuid: 'a', name: '低于下限', category: 'daily', remaining: '1', min_stock: '5' },
    { uuid: 'b', name: '没设下限', category: 'daily', remaining: '0', min_stock: '0' },
    { uuid: 'c', name: '够用', category: 'daily', remaining: '9', min_stock: '5' },
  ];
  const low = lowStockItems(asRows(items));
  assert.equal(low.length, 1);
  assert.equal(low[0]!.item['uuid'], 'a');
  assert.equal(low[0]!.shortfall, 4);
});

test('提醒提前量按分类给，且不再有关键物品放大', () => {
  assert.equal(leadDaysFor({ category: 'food' }), 15);
  assert.equal(leadDaysFor({ category: 'medicine' }), 60);
  assert.equal(leadDaysFor({ category: '不存在的分类' }), 45, '未知分类回落到 other');
  // 以前 is_critical 会 ×1.5，现在这个字段已经不参与计算
  assert.equal(leadDaysFor({ category: 'medicine', is_critical: 'true' }), 60);
});

// ─────────────────────────────────────────────────────────────
// 「批量」不变量
// ─────────────────────────────────────────────────────────────

test('普通物品：数量恒为 1，剩余只能是 0 或 1，最低库存被忽略', () => {
  withWorkspace('w', 'ws_bulk', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const a = insertRow(db, 'items', {
        code: 'A-1',
        name: '普通物品',
        category: 'medicine',
        quantity: '7', // 会被钉回 1
        remaining: '5', // 会被钉回 1（>0）
        min_stock: '3', // 会被清 0
      });
      assert.equal(a['quantity'], '1', '非批量物品数量恒为 1');
      assert.equal(a['remaining'], '1', '剩余 >0 时归 1');
      assert.equal(a['min_stock'], '0', '非批量物品的最低库存无意义');

      const b = insertRow(db, 'items', {
        code: 'A-2',
        name: '已消耗完的普通物品',
        category: 'medicine',
        is_bulk: 'false',
        remaining: '0',
      });
      assert.equal(b['quantity'], '1');
      assert.equal(b['remaining'], '0', '剩余 0 时保持 0');

      const c = insertRow(db, 'items', {
        code: 'A-3',
        name: '批量物品',
        category: 'daily',
        is_bulk: 'true',
        quantity: '24',
        remaining: '7',
        min_stock: '6',
      });
      assert.equal(c['quantity'], '24');
      assert.equal(c['remaining'], '7');
      assert.equal(c['min_stock'], '6');
    } finally {
      db.close();
    }
  });
});

test('部分更新不会把批量物品误判成非批量', () => {
  withWorkspace('w', 'ws_bulk2', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const item = insertRow(db, 'items', {
        code: 'B-1',
        name: '批量物品',
        category: 'daily',
        is_bulk: 'true',
        quantity: '24',
        remaining: '24',
        min_stock: '6',
      });
      const uuid = String(item['uuid']);

      const renamed = updateRow(db, 'items', uuid, { name: '改了名字' });
      assert.equal(renamed!['is_bulk'], 'true', '没提交 is_bulk 时不能把它当真');
      assert.equal(renamed!['quantity'], '24', '数量不应被抹成 1');
      assert.equal(renamed!['min_stock'], '6', '最低库存不应被清 0');

      const off = updateRow(db, 'items', uuid, { is_bulk: 'false' });
      assert.equal(off!['is_bulk'], 'false');
      assert.equal(off!['quantity'], '1');
      assert.equal(off!['min_stock'], '0');
    } finally {
      db.close();
    }
  });
});

test('「已消耗完」= 非批量 且 剩余为 0', () => {
  assert.equal(isSpentNonBulk({ is_bulk: 'false', remaining: '0' }), true);
  assert.equal(isSpentNonBulk({ is_bulk: 'false', remaining: '1' }), false);
  assert.equal(isSpentNonBulk({ is_bulk: 'true', remaining: '0' }), false, '批量物品即使为 0 也不算可清理');
  assert.equal(isSpentNonBulk({ is_bulk: 0, remaining: 0 }), true);
});

// ─────────────────────────────────────────────────────────────
// 「一组库存」：批量物品的嵌套条目
// ─────────────────────────────────────────────────────────────

test('一组库存：父项数量、剩余、最早到期日都由子行汇总', () => {
  withWorkspace('w', 'ws_stock', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const parent = insertRow(db, 'items', {
        code: 'DAY-1',
        name: '抽纸巾',
        category: 'daily',
        is_bulk: 'true',
        quantity: '0',
        remaining: '0',
        min_stock: '6',
      });
      const uuid = String(parent['uuid']);

      addStock(db, parent, { quantity: '10', remaining: '6', expires_on: '2027-03-31' });
      addStock(db, parent, { quantity: '8', remaining: '8', expires_on: '2028-06-30' });
      addStock(db, parent, { quantity: '6', remaining: '6' }); // 长期

      const fresh = selectWhere(db, 'items', 'uuid = ?', [uuid], { includeInternal: true })[0]!;
      assert.equal(fresh['quantity'], '24', '总数 = 10+8+6');
      assert.equal(fresh['remaining'], '20', '剩余 = 6+8+6');
      assert.equal(fresh['expires_on'], '2027-03-31', '父项取最早的到期日');
      assert.equal(fresh['status'], 'in_use');

      const { stocks, totals } = toBulkStocks(stocksOf(db, uuid));
      assert.equal(stocks.length, 3);
      assert.equal(totals.quantity, 24);
      assert.equal(totals.remaining, 20);
      assert.equal(totals.expiresOn, '2027-03-31');
      assert.deepEqual(
        stocks.map((s) => s.expiresOn),
        ['2027-03-31', '2028-06-30', null],
        '库存条目按到期日升序，长期的排最后',
      );
    } finally {
      db.close();
    }
  });
});

test('消耗「一组库存」按先到期先出（FEFO）', () => {
  withWorkspace('w', 'ws_fefo', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const parent = insertRow(db, 'items', {
        code: 'DAY-2',
        name: '口罩',
        category: 'daily',
        is_bulk: 'true',
        quantity: '0',
        remaining: '0',
      });
      const uuid = String(parent['uuid']);

      // 故意按「晚 → 早」的顺序加，验证扣减顺序是按到期日而不是按插入顺序
      addStock(db, parent, { quantity: '5', remaining: '5', expires_on: '2029-01-01' });
      addStock(db, parent, { quantity: '5', remaining: '5', expires_on: '2027-01-01' });

      const taken = consumeFromStocks(db, uuid, 7);
      assert.equal(taken.length, 2, '跨了两组');
      // 第一组先扣的是 2027-01-01 那条
      const earliest = stocksOf(db, uuid).find((r) => r['expires_on'] === '2027-01-01')!;
      const latest = stocksOf(db, uuid).find((r) => r['expires_on'] === '2029-01-01')!;
      assert.equal(earliest['remaining'], '0', '先到期的那组先被扣光');
      assert.equal(latest['remaining'], '3', '后到期的扣掉剩下的 2');

      refreshParentTotals(db, uuid);
      const fresh = selectWhere(db, 'items', 'uuid = ?', [uuid], { includeInternal: true })[0]!;
      assert.equal(fresh['remaining'], '3');
      assert.equal(fresh['expires_on'], '2029-01-01', '最早那组空了之后，父项到期日跟着变成下一条');
    } finally {
      db.close();
    }
  });
});

test('删掉一条库存后父项汇总会重算', () => {
  withWorkspace('w', 'ws_del_stock', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const parent = insertRow(db, 'items', {
        code: 'DAY-3',
        name: '电池',
        category: 'daily',
        is_bulk: 'true',
        quantity: '0',
        remaining: '0',
      });
      const uuid = String(parent['uuid']);
      const s1 = addStock(db, parent, { quantity: '4', remaining: '4', expires_on: '2027-01-01' });
      addStock(db, parent, { quantity: '6', remaining: '6', expires_on: '2028-01-01' });

      assert.equal(hasStocks(db, uuid), true);
      removeStock(db, String(s1['uuid']));

      const fresh = selectWhere(db, 'items', 'uuid = ?', [uuid], { includeInternal: true })[0]!;
      assert.equal(fresh['quantity'], '6');
      assert.equal(fresh['expires_on'], '2028-01-01');
      assert.equal(stocksOf(db, uuid).length, 1);
    } finally {
      db.close();
    }
  });
});

test('库存子行不会出现在顶层列表与分组里', () => {
  withWorkspace('w', 'ws_toplevel', (dataDir, entry) => {
    const db = openDatabase(workspaceDbPath(dataDir, entry));
    try {
      const parent = insertRow(db, 'items', {
        code: 'DAY-4',
        name: '咖啡豆',
        category: 'food',
        is_bulk: 'true',
        quantity: '0',
        remaining: '0',
      });
      addStock(db, parent, { quantity: '2', remaining: '2', expires_on: '2027-01-01' });
      addStock(db, parent, { quantity: '3', remaining: '3', expires_on: '2028-01-01' });

      const all = selectAll(db, 'items');
      assert.equal(all.length, 3, '1 个父项 + 2 个子行');

      const top = selectWhere(db, 'items', TOP_LEVEL, []);
      assert.equal(top.length, 1, '顶层只有父项');
      assert.equal(top[0]!['name'], '咖啡豆');

      const groups = groupByCategory(top);
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.counts.items, 1, '子行不算独立的物品');
      assert.equal(groups[0]!.entries.length, 1, '子行不各自产生到期条目');
    } finally {
      db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 工作区隔离
// ─────────────────────────────────────────────────────────────

test('工作区完全隔离：同样的东西登记在两个工作区互不影响', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '自己家', id: 'ws_aaa' });
    const b = createWorkspace(dataDir, { name: '父母家', id: 'ws_bbb' });

    // 一个普通物品（数量恒 1），一个批量物品（数量 5）——顺便验证两条规则
    for (const [ws, bulk, qty] of [
      [a, false, 1],
      [b, true, 5],
    ] as const) {
      const db = openDatabase(workspaceDbPath(dataDir, ws.entry));
      try {
        insertRow(db, 'items', {
          code: 'MED-0001',
          name: '布洛芬缓释胶囊',
          category: 'medicine',
          unit: '盒',
          is_bulk: bulk ? 'true' : 'false',
          quantity: String(qty),
          remaining: String(qty),
        });
      } finally {
        db.close();
      }
    }

    const dbA = openDatabase(workspaceDbPath(dataDir, a.entry), { readOnly: true });
    const dbB = openDatabase(workspaceDbPath(dataDir, b.entry), { readOnly: true });
    try {
      assert.equal(countRows(dbA, 'items'), 1);
      assert.equal(countRows(dbB, 'items'), 1);
      assert.equal(selectAll(dbA, 'items')[0]!['remaining'], '1', '普通物品剩 1');
      assert.equal(selectAll(dbB, 'items')[0]!['remaining'], '5', '批量物品保留真实数量');
    } finally {
      // 断言失败也必须走到 close，否则 Windows 上临时目录删不掉
      dbA.close();
      dbB.close();
    }

    rmSync(join(dataDir, 'workspaces', 'ws_aaa'), { recursive: true, force: true });
    const dbB2 = openDatabase(workspaceDbPath(dataDir, b.entry), { readOnly: true });
    try {
      assert.equal(countRows(dbB2, 'items'), 1);
    } finally {
      dbB2.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

/**
 * 比对用的归一化。
 *
 * 往返不变式是「除时间戳与内部标识外完全一致」：
 *   - created_at / updated_at 必然不同（导入是新建记录，触发器会重写）
 *   - code 是内部标识，导出包里没有它，导入时按分类前缀重新生成
 *   - expires_ym 只是旧数据兼容列，已经不导出
 *   - expiry_precision 完全由 expires_on 派生（有日期=day，没日期=none），
 *     而 expires_on 是被比对的，所以它不带来额外信息
 * 到期语义完全由 expires_on 承载，而它是被比对的 —— 这条不变式的强度不受影响。
 */
function forCompare(rows: ReturnType<typeof selectAll>): Record<string, unknown>[] {
  return rows.map((r) => {
    const { created_at: _c, updated_at: _u, expires_ym: _ym, expiry_precision: _p, code: _code, ...rest } = r;
    return rest as Record<string, unknown>;
  });
}

// ─────────────────────────────────────────────────────────────
// ★ 往返不变式
// ─────────────────────────────────────────────────────────────

test('往返不变式：导出 → 导入 → 数据完全一致，且不改动源工作区', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');

    const ws = createWorkspace(dataDir, { name: '原始家当', id: 'ws_origin' });
    const seeded = seedWorkspace(dataDir, ws.entry);
    assert.ok(seeded.items > 0);
    assert.ok(seeded.stocks > 0, '演示数据里应该有「一组库存」的子行');

    const db1 = openDatabase(workspaceDbPath(dataDir, ws.entry), { readOnly: true });
    const items1 = selectAll(db1, 'items');
    const moves1 = selectAll(db1, 'stock_moves');
    db1.close();

    const archive = join(root, 'out', 'origin.zip');
    const exported = exportWorkspace(dataDir, ws.entry, { outPath: archive });
    assert.ok(existsSync(archive));
    for (const f of ['manifest.json', 'README.md', 'checksums.txt', 'tables/items.csv', 'tables/stock_moves.csv']) {
      assert.ok(exported.files.includes(f), `归档应包含 ${f}`);
    }

    const preview = previewArchive(archive);
    assert.equal(preview.errorCount, 0, `预演不应有错误: ${JSON.stringify(preview.issues)}`);
    assert.equal(preview.checksumVerified, true, '校验和应通过');
    assert.equal(preview.workspaceName, '原始家当');

    const before = listWorkspaces(dataDir).length;
    const result = importArchive(archive, { dataDir, name: '副本', id: 'ws_copy' });
    assert.equal(result.ok, true, JSON.stringify(result.preview.issues));
    assert.equal(result.workspaceId, 'ws_copy');
    assert.equal(listWorkspaces(dataDir).length, before + 1);

    const db2 = openDatabase(workspaceDbPath(dataDir, requireWorkspace(dataDir, 'ws_copy')), { readOnly: true });
    const items2 = selectAll(db2, 'items');
    const moves2 = selectAll(db2, 'stock_moves');
    db2.close();

    assert.deepEqual(forCompare(items2), forCompare(items1), 'items 应完全一致（时间戳与内部标识除外）');
    assert.deepEqual(forCompare(moves2), forCompare(moves1), 'stock_moves 应完全一致（时间戳除外）');

    // 父子关系也要原样保留
    const roots1 = items1.filter((r) => !r['parent_uuid']).length;
    const roots2 = items2.filter((r) => !r['parent_uuid']).length;
    assert.equal(roots2, roots1, '顶层物品数量一致');
    assert.ok(items2.some((r) => r['parent_uuid']), '库存子行也应被导出并还原');
    // 子行要挂在同一个父项下
    const parentOf = (rows: typeof items1, childName: string): string =>
      String(rows.find((r) => r['parent_uuid'] && r['name'] === childName)?.['parent_uuid'] ?? '');
    assert.equal(
      parentOf(items2, '抽纸巾'),
      parentOf(items1, '抽纸巾'),
      '子行的 parent_uuid 必须指向同一个父项',
    );

    const db1b = openDatabase(workspaceDbPath(dataDir, ws.entry), { readOnly: true });
    assert.deepEqual(forCompare(selectAll(db1b, 'items')), forCompare(items1), '导入不得修改源工作区');
    db1b.close();
  } finally {
    removeTempRoot(root);
  }
});

// ─────────────────────────────────────────────────────────────
// 导入的失败与边界
// ─────────────────────────────────────────────────────────────

test('导入校验失败时不落库、不污染注册表、不留残目录', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    createWorkspace(dataDir, { name: '已有', id: 'ws_keep' });

    const stage = join(root, 'stage');
    mkdirSync(join(stage, 'tables'), { recursive: true });
    const manifest = buildManifest({
      workspace: { id: 'x', name: '坏包', createdAt: '2026-01-01T00:00:00.000Z', source: 'blank' },
      rowCounts: {},
      exportedAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    // items：分类非法
    writeFileSync(
      join(stage, 'tables', 'items.csv'),
      serializeCsv(exportTableColumns('items'), [
        cells(['u1', '甲', '不存在的分类']),
        cells(['u2', '乙', 'medicine']),
      ]),
      'utf8',
    );

    // stock_moves：外键悬空
    writeFileSync(
      join(stage, 'tables', 'stock_moves.csv'),
      serializeCsv(exportTableColumns('stock_moves'), [cells(['m1', 'missing-item', '2026-01-01', '-1', 'consume'])]),
      'utf8',
    );

    const badZip = join(root, 'bad.zip');
    zipDirectory(stage, badZip);

    const regBefore = readRegistry(dataDir);
    const result = importArchive(badZip, { dataDir });

    assert.equal(result.ok, false, '有错误时必须失败');
    assert.ok(result.preview.errorCount >= 1);

    const regAfter = readRegistry(dataDir);
    assert.deepEqual(regAfter.workspaces.map((w) => w.id), regBefore.workspaces.map((w) => w.id));
    assert.equal(regAfter.activeWorkspaceId, regBefore.activeWorkspaceId);
    assert.deepEqual(readdirNames(join(dataDir, 'workspaces')), ['ws_keep'], '不得留下残目录');
  } finally {
    removeTempRoot(root);
  }
});

test('导入同一个归档两次 = 两个互相独立的工作区', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '源', id: 'ws_src' });
    seedWorkspace(dataDir, ws.entry);
    const archive = join(root, 'a.zip');
    exportWorkspace(dataDir, ws.entry, { outPath: archive });

    const r1 = importArchive(archive, { dataDir, name: '副本一' });
    const r2 = importArchive(archive, { dataDir, name: '副本二' });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.workspaceId, r2.workspaceId);

    const list = listWorkspaces(dataDir);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((w) => w.name).sort(), ['副本一', '副本二', '源']);

    rmSync(join(dataDir, 'workspaces', r1.workspaceId!), { recursive: true, force: true });
    const d2 = openDatabase(workspaceDbPath(dataDir, requireWorkspace(dataDir, r2.workspaceId!)), { readOnly: true });
    try {
      assert.ok(countRows(d2, 'items') > 0);
    } finally {
      d2.close();
    }
  } finally {
    removeTempRoot(root);
  }
});

// ─────────────────────────────────────────────────────────────
// v1 → 当前版本迁移
// ─────────────────────────────────────────────────────────────

test('v1 库迁移：每个批次展开成一条独立物品记录', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '老库', id: 'ws_old' });
    const dbPath = workspaceDbPath(dataDir, ws.entry);

    // 手工造一个 v1 形态的库：items + batches
    {
      const db = openDatabase(dbPath);
      db.exec('DROP TABLE IF EXISTS items');
      db.exec('DROP TABLE IF EXISTS stock_moves');
      db.exec(`CREATE TABLE items (
        uuid TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL,
        brand TEXT, spec TEXT, unit TEXT, room TEXT, container TEXT, min_stock INTEGER,
        is_critical INTEGER, open_shelf_life_days INTEGER, is_prescription INTEGER,
        created_at TEXT, updated_at TEXT)`);
      db.exec(`CREATE TABLE batches (
        uuid TEXT PRIMARY KEY, item_uuid TEXT NOT NULL, quantity INTEGER, remaining INTEGER,
        unit_price_cents INTEGER, amount_cents INTEGER, purchased_on TEXT, expires_on TEXT,
        expires_ym TEXT, expiry_precision TEXT, opened_on TEXT, status TEXT, store TEXT,
        serial_no TEXT, warranty_until TEXT, photo_path TEXT, notes TEXT, created_at TEXT, updated_at TEXT)`);
      db.exec('PRAGMA user_version = 3');
      db.exec(`INSERT INTO items VALUES
        ('i1','MED-0001','布洛芬缓释胶囊','medicine','芬必得','0.3g×20粒','盒','客厅','药箱-上层',1,0,NULL,0,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`);
      db.exec(`INSERT INTO batches VALUES
        ('b1','i1',2,1,1930,3860,'2025-05-01','2026-07-31',NULL,'month',NULL,'in_stock','京东健康','SN-A',NULL,NULL,NULL,'2025-05-01T00:00:00.000Z','2025-05-01T00:00:00.000Z')`);
      db.exec(`INSERT INTO batches VALUES
        ('b2','i1',1,1,2180,2180,'2025-09-01','2026-10-15',NULL,'day',NULL,'in_stock','老百姓大药房',NULL,NULL,NULL,NULL,'2025-09-01T00:00:00.000Z','2025-09-01T00:00:00.000Z')`);
      db.close();
    }

    // 重新打开 → 自动迁移
    const db = openDatabase(dbPath);
    try {
      assert.equal(countRows(db, 'items'), 2, '两条批次应展开成两条物品');
      const rows = selectAll(db, 'items');
      const codes = rows.map((r) => String(r['code'])).sort();
      assert.deepEqual(codes, ['MED-0001', 'MED-0001-1'], '第二条派生编码加后缀避免撞唯一索引');

      const first = rows.find((r) => r['code'] === 'MED-0001')!;
      assert.equal(first['name'], '布洛芬缓释胶囊', '继承物品名称');
      assert.equal(first['brand'], '芬必得', '继承品牌');
      assert.equal(first['room'], '客厅', '继承位置');
      assert.equal(first['quantity'], '1', '旧批次数量 2 迁移成普通物品后应被钳成 1');
      assert.equal(first['remaining'], '1');
      assert.equal(first['unit_price_cents'], '1930');
      assert.equal(first['purchased_on'], '2025-05-01');
      assert.equal(first['expires_on'], '2026-07-31');
      assert.equal(first['store'], '京东健康');

      const second = rows.find((r) => r['code'] === 'MED-0001-1')!;
      assert.ok(second, '应存在派生编码的第二条记录');
      assert.equal(second['expires_on'], '2026-10-15', '第二条有自己的到期日');

      // 版本号已更新，且 batches 表被清掉
      const ver = db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(Number(ver.user_version), SCHEMA_VERSION);
      const stillHasBatches = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='batches'`).get();
      assert.equal(stillHasBatches, undefined, 'batches 表应已移除');
    } finally {
      // 必须保证关闭：断言失败时若漏掉 close，临时目录在 Windows 上就删不掉
      db.close();
    }

    // 迁移后概览能正常算
    const overview = computeOverview(requireWorkspace(dataDir, 'ws_old'), dbPath, new Date(2026, 7, 1));
    assert.ok(overview.counts.expired >= 1, '按 2026-08 看，第一条应已过期');
  } finally {
    removeTempRoot(root);
  }
});

test('删除工作区：先留快照，且删完不影响其它工作区', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const a = createWorkspace(dataDir, { name: '待删', id: 'ws_doomed' });
    seedWorkspace(dataDir, a.entry);
    const b = createWorkspace(dataDir, { name: '保留', id: 'ws_survivor' });
    seedWorkspace(dataDir, b.entry);

    const res = removeWorkspace(dataDir, 'ws_doomed', { snapshot: true });
    assert.equal(res.removed, true);
    assert.ok(res.snapshotPath, '应生成快照');
    assert.ok(existsSync(res.snapshotPath!), '快照文件应真实存在');
    assert.ok(!existsSync(join(dataDir, 'workspaces', 'ws_doomed')), '工作区目录应被删除');

    const snap = openDatabase(res.snapshotPath!, { readOnly: true });
    const snapItems = countRows(snap, 'items');
    snap.close();

    const dbB = openDatabase(workspaceDbPath(dataDir, b.entry), { readOnly: true });
    const survivorItems = countRows(dbB, 'items');
    dbB.close();

    assert.ok(snapItems > 0, '快照里应有数据');
    assert.equal(snapItems, survivorItems, '快照应保留与源工作区相同的记录数');

    const reg = readRegistry(dataDir);
    assert.deepEqual(reg.workspaces.map((w) => w.id), ['ws_survivor']);
    assert.equal(reg.activeWorkspaceId, 'ws_survivor');
  } finally {
    removeTempRoot(root);
  }
});

// ─────────────────────────────────────────────────────────────
// 演示数据
// ─────────────────────────────────────────────────────────────

test('演示数据：分组、长期、一组库存、待补货都覆盖到了', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '演示', id: 'ws_demo' });
    const seeded = seedWorkspace(dataDir, ws.entry);

    const db = openDatabase(workspaceDbPath(dataDir, ws.entry), { readOnly: true });
    let top: ReturnType<typeof selectAll> = [];
    let all: ReturnType<typeof selectAll> = [];
    try {
      all = selectAll(db, 'items');
      top = selectWhere(db, 'items', TOP_LEVEL, []);
    } finally {
      db.close();
    }

    assert.equal(seeded.items, top.length, 'SeedResult.items 应该只数顶层物品');
    assert.equal(seeded.stocks, all.length - top.length, 'SeedResult.stocks 应该等于子行数');

    // 普通物品的数量恒为 1
    for (const r of top.filter((x) => x['is_bulk'] !== 'true')) {
      assert.equal(r['quantity'], '1', `普通物品「${String(r['name'])}」的数量必须是 1`);
      assert.ok(['0', '1'].includes(String(r['remaining'])));
    }

    // 至少有一个批量物品配了多条一组库存
    const parentsWithStocks = new Set(all.filter((r) => r['parent_uuid']).map((r) => String(r['parent_uuid'])));
    assert.ok(parentsWithStocks.size > 0, '应有配了一组库存的批量物品');
    const multi = [...parentsWithStocks].some(
      (p) => all.filter((r) => String(r['parent_uuid']) === p).length > 1,
    );
    assert.ok(multi, '至少有一个批量物品被拆成多组');

    // 概览：有已过期、有 30 天内、有长期、有待补货
    const overview = computeOverview(ws.entry, workspaceDbPath(dataDir, ws.entry), new Date());
    assert.ok(overview.counts.expired > 0, '演示数据应包含已过期项');
    assert.ok(overview.counts.soon > 0, '演示数据应包含 30 天内到期的');
    assert.ok(overview.counts.longTerm > 0, '演示数据应包含长期物品');
    assert.ok(overview.counts.lowStock > 0, '演示数据应包含待补货项');

    // 分组结构：每组内按到期日升序
    assert.ok(overview.groups.length > 1, '应该分成多个分类');
    for (const g of overview.groups) {
      for (let i = 1; i < g.entries.length; i += 1) {
        assert.ok(
          g.entries[i - 1]!.expiresOn <= g.entries[i]!.expiresOn,
          `「${g.label}」组内应按到期日升序`,
        );
      }
    }
  } finally {
    removeTempRoot(root);
  }
});

test('演示数据里同一种东西买两次会产生两条独立记录', () => {
  const root = tmpRoot();
  try {
    const dataDir = join(root, 'data');
    const ws = createWorkspace(dataDir, { name: '演示', id: 'ws_demo2' });
    seedWorkspace(dataDir, ws.entry);

    const db = openDatabase(workspaceDbPath(dataDir, ws.entry), { readOnly: true });
    let rows: ReturnType<typeof selectAll> = [];
    try {
      rows = selectWhere(db, 'items', TOP_LEVEL, []);
    } finally {
      db.close();
    }

    const ibuprofen = rows.filter((r) => r['name'] === '布洛芬缓释胶囊');
    assert.equal(ibuprofen.length, 2, '同一种药买两次应是两条记录');
    assert.notEqual(ibuprofen[0]!['uuid'], ibuprofen[1]!['uuid'], '各自有独立主键');
    assert.notEqual(ibuprofen[0]!['expires_on'], ibuprofen[1]!['expires_on'], '各自有自己的到期日');

    const names = rows.map((r) => String(r['code']));
    assert.equal(new Set(names).size, names.length, '内部标识必须唯一');
  } finally {
    removeTempRoot(root);
  }
});

// ─────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

void transaction;
void insertRow;
