/**
 * 应用端系统走查（桌面端）。
 *
 * ── 设计 ──
 * 每一步**单独一次 `executeJavaScript`**，并单独限时：哪一步失败就能精确归因，
 * 某一步挂起也不会把整轮拖死。
 * 这个文件只负责**把界面读出来**；判定在 `scripts/guiassert.mjs`。
 *
 * ── 数据 ──
 * 必须跑在隔离的数据目录上（`scripts/guidb.mjs` 准备）——
 * 走查会真的新建/改名/删除工作区、改动物品，跑在 `data/` 上就是拿用户的
 * 真实数据当试验品，而且断言依赖的条数会被跑一次变一次。
 *
 * ── 写这个文件的几条规矩（都是踩过的）──
 *   1. 选择器助手只有两个名字：`one(sel)` 取单个、`all(sel)` 取全部。
 *      **不要用 `$` / `$$`** —— 它们在一串字符串替换里被误伤过很多次
 *      （`$$(` 被改成 `$$$(`、`$$(` 被改成 `$(`），而且改坏了不报编译错，
 *      只在运行时冒出 `$$$ is not defined` 这种看不懂的错。
 *   2. 给输入框赋值必须走 `setInput`：React 会跟踪输入框的值，
 *      直接写 `.value` 它认为没变过，onChange 不触发。
 *   3. 点完之后要读新画出来的东西，先 `await waitFor(sel)`：
 *      React 是异步渲染的，"等固定毫秒数"总会偶尔读到上一帧。
 *   4. 这一步改了筛选/批量模式，下一步开头要复位（`resetFilters` / `exitBatch`）。
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, '_gui.json');

const consoleErrors = [];
require(join(ROOT, 'dist', 'main', 'main.js'));

const results = {};
const failed = [];
let current = '';

function finish(extra = {}) {
  writeFileSync(OUT, JSON.stringify({ consoleErrors, failed, ...results, ...extra }, null, 2), 'utf8');
  app.exit(0);
}
setTimeout(() => finish({ timeout: true, stuckAt: current }), 420000);

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) consoleErrors.push(message);
    });

    async function ev(label, code) {
      current = label;
      try {
        results[label] = await Promise.race([
          win.webContents.executeJavaScript(`(async () => { ${code} })()`),
          new Promise((_, rej) => setTimeout(() => rej(new Error('这一步挂起超过 15 秒')), 15000)),
        ]);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        failed.push({ label, error: msg });
        results[label] = { __failed: msg };
      }
    }

    /** 每步注入的助手 */
    const PRE = `
      const one = (s) => document.querySelector(s);
      const all = (s) => Array.from(document.querySelectorAll(s));
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const tx = (el) => (el ? el.textContent.trim().replace(/\\s+/g, ' ') : null);
      const tabOf = (t) => all('.tab').find(b => b.textContent.trim().startsWith(t));
      const modal = () => one('#modal-root .modal');
      const btns = (scope) => Array.from((scope || document).querySelectorAll('button'));
      const btnTexts = (scope) => btns(scope).map(b => b.textContent.trim()).filter(Boolean);

      /** 找不到就把现场报出来（当前页签、可见按钮、页面文本） */
      const need = (v, what) => {
        if (v) return v;
        const view = one('#view');
        const 当前页 = one('.tab.active') ? one('.tab.active').textContent.trim() : '(无高亮)';
        throw new Error('找不到: ' + what
          + ' || 当前页: ' + 当前页
          + ' || 可见按钮: ' + btnTexts().slice(0, 12).join(' / ')
          + ' || 页面文本: ' + (view ? view.textContent.trim().slice(0, 70) : '?'));
      };

      /** 在 scope 里按文案找按钮并点它 */
      const clickBtn = (scope, re) => {
        const b = btns(scope).find(x => re.test(x.textContent.trim()));
        if (!b) throw new Error('没有匹配 ' + re + ' 的按钮，现有: ' + btnTexts(scope).join(' / '));
        b.click();
        return true;
      };

      /** 给输入框赋值并触发 React 的 onChange（见文件头第 2 条） */
      const setInput = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
      };
      const setSelect = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value;
      };

      /** 等元素出现（见文件头第 3 条） */
      const waitFor = async (sel, ms) => {
        const 上限 = ms || 6000;
        for (let i = 0; i < 上限 / 120; i++) {
          const el = one(sel);
          if (el) return el;
          await wait(120);
        }
        throw new Error('等了 ' + 上限 + 'ms 也没出现: ' + sel);
      };
      /** 等条件成立 */
      const waitUntil = async (fn, ms) => {
        const 上限 = ms || 6000;
        for (let i = 0; i < 上限 / 120; i++) {
          const v = fn();
          if (v) return v;
          await wait(120);
        }
        return null;
      };

      /** 切页签并等到视图真的画完 */
      const goto = async (t) => {
        need(tabOf(t), '页签 ' + t).click();
        await waitUntil(() => {
          const v = one('#view');
          return v && v.children.length > 0 && !/正在整理/.test(v.textContent || '');
        });
        await wait(200);
      };

      const closeModal = async () => {
        const c = modal() && btns(modal()).find(b => b.textContent.trim() === '取消');
        if (c) c.click();
        await wait(400);
      };

      /**
       * 弹窗是不是真的关掉了。
       *
       * ⚠️ **不能只看 #modal-root 里还有没有 .modal** —— 两种关法：
       *   手写 DOM 版：给 #modal-root 加 .hidden（元素还在）
       *   React 版    ：把内容卸载掉（元素没了）
       * 只看其中一种，换个实现就会误判成"没关掉"。
       */
      const modalClosed = () => {
        const root = one('#modal-root');
        if (!root) return true;
        if (root.classList.contains('hidden')) return true;
        return !root.querySelector('.modal');
      };
      const waitModalClosed = async (ms) => {
        const r = await waitUntil(() => modalClosed(), ms || 4000);
        return r !== null;
      };

      /**
       * 清掉明细页的筛选（见文件头第 4 条）。
       *
       * ⚠️ **纯 DOM 判断，不要用 window.__dsh。**
       * 那个调试钩子只在 React 版里存在（useSyncExternalStore 架构需要一个
       * 读状态的入口），手写 DOM 版没有。测试依赖它就会绑死在某一种实现上 ——
       * 而这一层的价值恰恰是"不管怎么实现，界面长这样、点下去该有反应"。
       *
       * 所以判据一律从界面上读：筛选值看输入框，列表有没有数据看表格。
       */
      const resetFilters = async () => {
        const inp = one('#view input[name="search"]');
        const sel = one('#view select[name="category"]');
        // 先看当前值，值没变就不白派发一次事件（派发会触发一次重查）
        if (inp && inp.value) setInput(inp, '');
        if (sel && sel.value) setSelect(sel, '');
        await waitUntil(() => {
          const i = one('#view input[name="search"]');
          const sl = one('#view select[name="category"]');
          if (i && i.value) return false;
          if (sl && sl.value) return false;
          // 列表回来了才算稳：要么有行，要么明确显示"没有匹配的物品"
          return !!one('#view table.items') || !!one('#view .empty');
        });
      };

      /** 退出批量模式（从界面上认：批量模式有 .batch-box） */
      const exitBatch = async () => {
        if (!one('#view .batch-box')) return;
        const done = btns(one('#view .toolbar')).find(b => b.textContent.trim() === '完成');
        if (done) done.click();
        await wait(400);
      };

      /** 把分组页恢复到"全部展开、没有只看已过期、没有排序" */
      const resetGroups = async () => {
        await goto('概览');
        await goto('分组');
        const oe = one('#view .mini-check');
        if (oe && oe.checked) { oe.click(); await wait(600); }
        for (let i = 0; i < 5; i++) {
          const on = all('#view .group-section .th-sort.on');
          if (on.length === 0) break;
          on.forEach(b => b.click());
          await wait(700);
        }
        const 展开 = btns(one('#view .toolbar')).find(b => /全部展开/.test(b.textContent));
        if (展开) { 展开.click(); await wait(600); }
      };

      const itemsTable = () => one('#view table.items');
      const itemRows = () => all('#view table.items tbody tr');
    `;

    await win.webContents
      .executeJavaScript(
        `(() => { window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.error && e.error.stack || e.message).split('\\n').slice(0,2).join(' | '))); window.addEventListener('unhandledrejection', e => window.__errs.push('rej: ' + String(e.reason && e.reason.stack || e.reason).split('\\n').slice(0,2).join(' | '))); return true; })()`,
      )
      .catch(() => {});

    // ════════════════ 1. 顶栏与横幅 ════════════════

    await ev(
      '01_顶栏骨架',
      `${PRE}
      return {
        页签: all('.tab').map(t => ({ 文案: t.textContent.trim(), 隐藏: t.classList.contains('hidden'), 高亮: t.classList.contains('active') })),
        topbar直接子元素: Array.from(one('#topbar').children).map(e => e.tagName + '#' + e.id),
        选中的工作区: tx(one('.wsp-name')),
        状态点: one('.wsp-dot') ? one('.wsp-dot').className : null,
      };
    `,
    );

    await ev(
      '02_横幅',
      `${PRE}
      const b = one('#banner');
      return {
        类名: b.className,
        是否隐藏: b.classList.contains('hidden'),
        文案: tx(one('#banner-text')),
        chips: all('#banner-chips .chip').map(c => ({ 文案: c.textContent.trim(), 类名: c.className })),
        高度: Math.round(b.getBoundingClientRect().height),
      };
    `,
    );

    await ev(
      '03_页签计数',
      `${PRE}
      return all('.tab').filter(t => !t.classList.contains('hidden')).map(t => {
        const c = t.querySelector('.count');
        return { 页签: t.textContent.trim().split(/[0-9]/)[0], 计数: c ? c.textContent.trim() : null, 热: c ? c.classList.contains('hot') : false };
      });
    `,
    );

    await ev(
      '04_工作区下拉可展开',
      `${PRE}
      need(one('.wsp-trigger'), '下拉触发按钮').click();
      await waitFor('.wsp-panel');
      await wait(300);
      const out = {
        面板可见: !one('.wsp-panel').classList.contains('hidden'),
        条目: all('.wsp-panel .wsp-item').map(i => ({
          名字: tx(i.querySelector('.wsp-item-name')),
          来源: tx(i.querySelector('.chip-src')),
          选中: i.classList.contains('active'),
        })),
        底部按钮: all('.wsp-footer button').map(b => b.textContent.trim()),
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(300);
      out.Esc后面板隐藏 = one('.wsp-panel').classList.contains('hidden');
      return out;
    `,
    );

    // ════════════════ 2. 概览 ════════════════

    await ev(
      '10_概览_卡片',
      `${PRE}
      await goto('概览');
      return {
        页面类: one('#view').className,
        卡片: all('#view .card').map(c => ({
          标题: tx(c.querySelector('.card-title')),
          值: tx(c.querySelector('.card-value')),
          说明: tx(c.querySelector('.card-sub')),
          类: c.className,
        })),
      };
    `,
    );

    await ev(
      '11_概览_分布条',
      `${PRE}
      const d = one('#view .dist');
      return {
        有分布条: !!d,
        分段: d ? all('#view .dist-seg').map(s => ({ 宽: s.style.width, 标题: s.title })) : [],
        图例: d ? all('#view .dist-legend > span').map(s => tx(s)) : [],
      };
    `,
    );

    await ev(
      '12_概览_最先到期表',
      `${PRE}
      const wrap = all('#view .table-wrap')[0];
      const t = wrap && wrap.querySelector('table');
      const body = t ? Array.from(t.querySelectorAll('tbody tr')) : [];
      return {
        表数: all('#view .table-wrap').length,
        表头: t ? Array.from(t.querySelectorAll('thead th')).map(h => tx(h)) : [],
        行数: body.length,
        第一行: body[0] ? Array.from(body[0].children).map(c => tx(c)) : null,
        有已过期标签: all('#view .tag.danger').length,
        垃圾桶按钮数: all('#view .col-act button').length,
      };
    `,
    );

    await ev(
      '13_概览_待补货',
      `${PRE}
      const wraps = all('#view .table-wrap');
      const last = wraps[wraps.length - 1];
      const t = last && last.querySelector('table');
      return {
        分区标题: all('#view h3').map(h => tx(h)),
        待补货表头: t ? Array.from(t.querySelectorAll('thead th')).map(h => ({ 文案: tx(h), 对齐: getComputedStyle(h).textAlign })) : [],
        待补货行数: t ? t.querySelectorAll('tbody tr').length : 0,
      };
    `,
    );

    // ════════════════ 3. 分组 ════════════════

    await ev(
      '20_分组_结构',
      `${PRE}
      await resetGroups();
      const secs = all('#view .group-section');
      return {
        标题: tx(one('#view .view-title')),
        组数: secs.length,
        组: secs.map(s => ({
          类: s.className,
          路径: s.dataset.path,
          组名: tx(s.querySelector('.group-label')),
          元信息: Array.from(s.querySelectorAll('.group-meta > *')).map(e => tx(e)),
          置顶: !!s.querySelector('.group-head .pin'),
          有手柄: !!s.querySelector('.group-head .grip'),
          有内容节点: !!s.querySelector(':scope > .group-body'),
          有内层: !!s.querySelector(':scope > .group-body > .group-body-inner'),
          表格在内容节点里: !!s.querySelector(':scope > .group-body > .group-body-inner > .table-wrap'),
          行数: s.querySelectorAll('tbody tr.item-row').length,
        })),
      };
    `,
    );

    await ev(
      '21_分组_列头与排序箭头',
      `${PRE}
      const first = need(all('#view .group-section')[0], '第一个分组');
      const t = first.querySelector('table.group-items');
      const heads = Array.from(t.querySelectorAll('thead th'));
      const 首行 = t.querySelector('tbody tr.item-row');
      return {
        表头数: heads.length,
        表头: heads.map(h => ({
          文案: tx(h.querySelector('.th-label')) || tx(h),
          可排序: h.classList.contains('sortable'),
          右对齐: h.classList.contains('right'),
          箭头数: h.querySelectorAll('.th-sort').length,
          高亮箭头: h.querySelectorAll('.th-sort.on').length,
          提示: (h.title || '').slice(0, 40),
        })),
        第一行: 首行 ? Array.from(首行.children).map(c => ({ 类: c.className, 文本: tx(c).slice(0, 24) })) : [],
      };
    `,
    );

    await ev(
      '22_分组_收起展开动画',
      `${PRE}
      const sec = need(all('#view .group-section')[0], '第一个分组');
      const caret = sec.querySelector('.caret');
      const bodyEl = sec.querySelector(':scope > .group-body');
      const h0 = bodyEl.getBoundingClientRect().height;
      caret.click();
      await wait(60);
      const 中途行高 = getComputedStyle(bodyEl).gridTemplateRows;
      await wait(700);
      const collapsed = sec.classList.contains('collapsed');
      const h1 = bodyEl.getBoundingClientRect().height;
      // 内容节点必须还在 DOM 里（过渡依赖它）
      const 节点仍在 = !!sec.querySelector(':scope > .group-body > .group-body-inner');
      caret.click();
      await wait(700);
      const h2 = bodyEl.getBoundingClientRect().height;
      return { 收起前高: Math.round(h0), 收起后高: Math.round(h1), 展开后高: Math.round(h2), 中途行高, collapsed, 节点仍在, 现在收起: sec.classList.contains('collapsed') };
    `,
    );

    await ev(
      '23_分组_全部收起与展开',
      `${PRE}
      const btn = () => btns(one('#view .toolbar')).find(b => /全部(收起|展开)/.test(b.textContent));
      need(btn(), '全部收起按钮').click();
      await wait(800);
      const 收起后 = { 按钮文案: btn().textContent.trim(), 收起组数: all('#view .group-section.collapsed').length, 总组数: all('#view .group-section').length };
      btn().click();
      await wait(800);
      return { ...收起后, 展开后按钮文案: btn().textContent.trim(), 展开后收起组数: all('#view .group-section.collapsed').length };
    `,
    );

    await ev(
      '24_分组_只看已过期',
      `${PRE}
      const box = need(one('#view .mini-check'), '只看已过期');
      const 收起前行数 = all('#view tbody tr.item-row').length;
      const 组数前 = all('#view .group-section').length;
      box.click();
      await wait(700);
      const 筛选后 = { 行数: all('#view tbody tr.item-row').length, 组数: all('#view .group-section').length, 勾选: one('#view .mini-check').checked };
      one('#view .mini-check').click();
      await wait(700);
      return { 收起前行数, 组数前, ...筛选后, 复原行数: all('#view tbody tr.item-row').length };
    `,
    );

    await ev(
      '25_分组_点列头排序',
      `${PRE}
      const sec = () => need(all('#view .group-section')[0], '第一个分组');
      const t = () => sec().querySelector('table.group-items');
      const 排序前可拖 = !!t().querySelector('tbody tr.item-row[draggable="true"]');
      const 手柄类前 = t().querySelector('.drag-handle').className;
      const 排序前首位 = tx(t().querySelector('tbody tr.item-row'));
      const th = Array.from(t().querySelectorAll('thead th')).find(h => tx(h.querySelector('.th-label')) === '物品');
      th.querySelectorAll('.th-sort')[0].click();
      await wait(1400);
      const th2 = Array.from(t().querySelectorAll('thead th')).find(h => tx(h.querySelector('.th-label')) === '物品');
      return {
        排序前首位,
        排序后首位: tx(t().querySelector('tbody tr.item-row')),
        排序前可拖,
        排序后可拖: !!t().querySelector('tbody tr.item-row[draggable="true"]'),
        // 这一组第一件可能是"名字为空"的那件 —— 按名称升序它本来就该在最前，
        // 所以"首行变了"不是可靠的判据。可靠的判据见 guiassert：名字必须非降序。
        该组首列全部名字: Array.from(t().querySelectorAll('tbody tr.item-row'))
          .map(r => tx(r.querySelector('td:nth-child(4) .link')) || ''),
        箭头高亮数: th2.querySelectorAll('.th-sort.on').length,
        手柄类前,
        手柄类后: t().querySelector('.drag-handle').className,
        手柄仍存在: !!t().querySelector('.drag-handle'),
        手柄提示: t().querySelector('.drag-handle').title,
      };
    `,
    );

    await ev(
      '26_分组_排序互不影响',
      `${PRE}
      const secs = all('#view .group-section');
      return {
        组数: secs.length,
        各组高亮箭头数: secs.map(s => s.querySelectorAll('.th-sort.on').length),
        各组可拖行数: secs.map(s => s.querySelectorAll('tbody tr.item-row[draggable="true"]').length),
      };
    `,
    );

    await ev(
      '27_分组_取消排序恢复可拖',
      `${PRE}
      const th = Array.from(all('#view .group-section')[0].querySelectorAll('thead th')).find(h => tx(h.querySelector('.th-label')) === '物品');
      const on = th.querySelector('.th-sort.on');
      if (on) on.click();
      await wait(1400);
      return {
        高亮箭头数: all('#view .group-section .th-sort.on').length,
        可拖行数: all('#view .group-section tbody tr.item-row[draggable="true"]').length,
      };
    `,
    );

    await ev(
      '28_分组_手柄列恒在',
      `${PRE}
      const secs = all('#view .group-section');
      return {
        每组手柄列数: secs.map(s => s.querySelectorAll('thead th.drag-col').length),
        每组首格类名: secs.map(s => (s.querySelector('tbody tr.item-row td') || {}).className || null),
        每组表头数: secs.map(s => s.querySelectorAll('thead th').length),
        每组首行格数: secs.map(s => (s.querySelector('tbody tr.item-row') || { children: [] }).children.length),
      };
    `,
    );

    // ════════════════ 4. 明细 ════════════════

    await ev(
      '30_明细_结构',
      `${PRE}
      await goto('明细');
      await resetFilters();
      const t = need(itemsTable(), '明细表');
      return {
        工具栏按钮: all('#view .toolbar button').map(b => b.textContent.trim()),
        有搜索框: !!one('#view input[name="search"]'),
        搜索占位: (one('#view input[name="search"]') || {}).placeholder,
        有分类下拉: !!one('#view select[name="category"]'),
        分类选项数: all('#view select[name="category"] option').length,
        表头: Array.from(t.querySelectorAll('thead th')).map(h => ({ 文案: tx(h), 类: h.className })),
        行数: t.querySelectorAll('tbody tr').length,
        可展开按钮数: all('#view .extra-toggle').length,
        色点数: all('#view td.dot').length,
      };
    `,
    );

    await ev(
      '31_明细_搜索',
      `${PRE}
      await resetFilters();
      const inp = need(one('#view input[name="search"]'), '搜索框');
      const 全部行数 = need(itemsTable(), '明细表').querySelectorAll('tbody tr').length;
      setInput(inp, '布洛芬');
      await wait(900);
      const t2 = await waitFor('#view table.items');
      const 筛选后 = { 行数: t2.querySelectorAll('tbody tr').length, 首行文本: tx(t2.querySelector('tbody tr')) };
      setInput(inp, '');
      await wait(900);
      const t3 = await waitFor('#view table.items');
      return { 全部行数, ...筛选后, 清空后行数: t3.querySelectorAll('tbody tr').length };
    `,
    );

    await ev(
      '32_明细_分类筛选',
      `${PRE}
      await resetFilters();
      const sel = need(one('#view select[name="category"]'), '分类下拉');
      const 全部行数 = need(itemsTable(), '明细表').querySelectorAll('tbody tr').length;
      const heads = all('#view table.items thead th').map(h => tx(h));
      const 分类列 = heads.indexOf('分类');
      setSelect(sel, 'medicine');
      await wait(900);
      const t2 = await waitFor('#view table.items');
      const 筛选后行数 = t2.querySelectorAll('tbody tr').length;
      const 分类值 = all('#view table.items tbody tr').slice(0, 5).map(r => (r.children[分类列] ? tx(r.children[分类列]) : '(无此列)'));
      setSelect(sel, '');
      await wait(900);
      const t3 = await waitFor('#view table.items');
      return { 全部行数, 筛选后行数, 分类列, 表头: heads, 前几行分类: 分类值, 复原行数: t3.querySelectorAll('tbody tr').length };
    `,
    );

    await ev(
      '33_明细_展开补充信息',
      `${PRE}
      await resetFilters();
      await waitFor('#view .extra-toggle');
      const toggles = all('#view .extra-toggle');
      const 展开前行数 = all('#view tr.extra-row').length;
      need(toggles[0], '第一个展开按钮').click();
      const box = await waitFor('#view tr.extra-row .extra-box');
      await wait(700);
      const 字段 = all('#view tr.extra-row .extra-field').map(f => ({
        标签: tx(f.querySelector('.extra-label')),
        有输入: !!f.querySelector('input,textarea'),
        有清除: !!f.querySelector('button'),
      }));
      const out = {
        展开前行数,
        展开后行数: all('#view tr.extra-row').length,
        有编辑器: !!box,
        字段,
        加载中文案: tx(one('#view .extra-loading')),
        colspan: box.closest('td').colSpan,
      };
      need(all('#view .extra-toggle')[0], '展开按钮').click();
      await wait(700);
      out.收起后行数 = all('#view tr.extra-row').length;
      return out;
    `,
    );

    await ev(
      '34_明细_批量模式',
      `${PRE}
      await resetFilters();
      await exitBatch();
      const 找按钮 = (re) => btns(one('#view .toolbar')).find(b => re.test(b.textContent.trim()));
      await waitUntil(() => 找按钮(/批量删除/));
      need(找按钮(/批量删除/), '批量删除').click();
      await waitFor('#view tbody .batch-box');
      const 行数 = itemRows().length;
      const 进入后 = {
        按钮文案: all('#view .toolbar button').map(b => b.textContent.trim()),
        复选框数: all('#view .batch-box').length,
        表头有全选框: !!one('#view thead .batch-box'),
        行数,
      };
      /*
       * 每次点之前都要重新查一遍。
       *
       * 手写 DOM 版勾一下会 render() 重画整张表 —— 之前缓存下来的复选框
       * 节点在第一次点击之后就成了**游离节点**，第二次点在它上面毫无效果
       *（表现是「勾两条只中一条」）。React 版会复用节点，缓存能侥幸生效，
       * 但那是实现细节，别依赖它。
       */
      all('#view tbody .batch-box')[0].click();
      await wait(500);
      all('#view tbody .batch-box')[1].click();
      await wait(500);
      const 选中后 = {
        选中行数: all('#view tr.batch-on').length,
        删除按钮文案: (找按钮(/删除选中/) || {}).textContent,
        半选: one('#view thead .batch-box').indeterminate,
      };
      const 全不选 = 找按钮(/全不选/);
      if (全不选) 全不选.click();
      await wait(400);
      const 清空后 = { 选中行数: all('#view tr.batch-on').length };
      const 全选 = 找按钮(/全选/);
      if (全选) 全选.click();
      await wait(600);
      const 全选后 = { 选中行数: all('#view tr.batch-on').length, 表头勾选: one('#view thead .batch-box').checked };
      need(找按钮(/^完成$/), '完成').click();
      await wait(600);
      return { 进入后, 选中后, 清空后, 全选后, 退出后复选框数: all('#view .batch-box').length };
    `,
    );

    await ev(
      '35_明细_批量删除确认框',
      `${PRE}
      await resetFilters();
      await exitBatch();
      const 找按钮 = (re) => btns(one('#view .toolbar')).find(b => re.test(b.textContent.trim()));
      await waitUntil(() => 找按钮(/批量删除/));
      找按钮(/批量删除/).click();
      await waitFor('#view tbody .batch-box');
      all('#view tbody .batch-box')[0].click();
      await waitUntil(() => 找按钮(/删除选中/) && !找按钮(/删除选中/).disabled);
      找按钮(/删除选中/).click();
      const m = await waitFor('#modal-root .modal');
      await wait(300);
      const out = {
        标题: tx(m.querySelector('h2')),
        说明: tx(m.querySelector('.modal-body p')),
        表头: Array.from(m.querySelectorAll('thead th')).map(h => tx(h)),
        行数: m.querySelectorAll('tbody tr').length,
        按钮: btnTexts(m),
      };
      await closeModal();
      const done = btns(one('#view .toolbar')).find(b => b.textContent.trim() === '完成');
      if (done) done.click();
      await wait(500);
      out.退出后复选框数 = all('#view .batch-box').length;
      return out;
    `,
    );

    await ev(
      '36_明细_列设置',
      `${PRE}
      await resetFilters();
      const 表头 = () => all('#view table.items thead th').map(h => tx(h));
      const 原表头 = 表头();
      clickBtn(one('#view .toolbar'), /列设置/);
      const m = await waitFor('#modal-root .modal');
      await wait(500);
      const rows0 = all('#modal-root .modal .col-row');
      const out = {
        标题: tx(m.querySelector('h2')),
        原表头,
        行数: rows0.length,
        行: rows0.map(r => ({
          名称: tx(r.querySelector('.col-name')),
          勾选: r.querySelector('input').checked,
          禁用: r.querySelector('input').disabled,
          必显: !!r.querySelector('.col-lock'),
          有说明: !!r.querySelector('.col-hint'),
        })),
        按钮: btnTexts(m),
      };
      /*
       * 这个弹窗是「**改一下立即生效**」：勾选框一变就写库并重画表格，
       * 没有"保存"按钮（只有「恢复默认列」与「完成」）。
       * 所以这里不需要点保存，取消勾选之后等它落库即可。
       */
      const target = rows0.find(r => !r.querySelector('input').disabled);
      out.取消的列 = tx(target.querySelector('.col-name'));
      target.querySelector('input').click();
      await wait(1200);
      out.取消后表头 = 表头();
      out.取消后该列消失 = !out.取消后表头.includes(out.取消的列);
      // 锁定列必须还在（core 的 resolveColumns 无条件补回）
      out.取消后仍有锁定列 = out.取消后表头.includes('物品') && out.取消后表头.includes('到期时间');
      clickBtn(m, /完成/);
      out.弹窗已关 = await waitModalClosed();
      return out;
    `,
    );

    await ev(
      '37_明细_恢复默认列',
      `${PRE}
      await resetFilters();
      clickBtn(one('#view .toolbar'), /列设置/);
      const m = await waitFor('#modal-root .modal');
      await wait(500);
      const 恢复前 = all('#modal-root .modal .col-row input:checked').length;
      const 锁定 = all('#modal-root .modal .col-row').filter(r => r.querySelector('input').disabled);
      const out = {
        恢复前勾选数: 恢复前,
        锁定列数: 锁定.length,
        锁定列名称: 锁定.map(r => tx(r.querySelector('.col-name'))),
        锁定列都勾着: 锁定.every(r => r.querySelector('input').checked),
        必显标记数: all('#modal-root .modal .col-lock').length,
      };
      clickBtn(m, /恢复默认列/);
      await wait(1200);
      out.恢复后勾选数 = all('#modal-root .modal .col-row input:checked').length;
      out.锁定列仍勾着 = all('#modal-root .modal .col-row')
        .filter(r => r.querySelector('input').disabled)
        .every(r => r.querySelector('input').checked);
      clickBtn(m, /完成/);
      out.弹窗已关 = await waitModalClosed();
      await wait(600);
      const 表头 = all('#view table.items thead th').map(h => tx(h));
      out.恢复后表头 = 表头;
      out.必显列都在 = 表头.includes('物品') && 表头.includes('到期时间');
      return out;
    `,
    );

    await ev(
      '38_明细_新建物品表单',
      `${PRE}
      await resetFilters();
      clickBtn(one('#view .toolbar'), /新增物品/);
      const m = await waitFor('#modal-root .modal');
      await wait(500);
      const fields = all('#modal-root .modal .field');
      return {
        标题: tx(m.querySelector('h2')),
        宽弹窗: m.classList.contains('wide'),
        字段数: fields.length,
        字段标签: fields.map(f => tx(f.querySelector('.field-label'))).filter(Boolean),
        有批量勾选: !!m.querySelector('.check input[type=checkbox]'),
        有悬停提示: !!m.querySelector('.tip-dot'),
        悬停提示文案: m.querySelector('.tip-dot') ? m.querySelector('.tip-dot').getAttribute('aria-label') : null,
        按钮: btnTexts(m),
      };
    `,
    );

    await ev(
      '39_物品表单_批量联动',
      `${PRE}
      const m = need(modal(), '物品表单');
      const qty = m.querySelector('[name="quantity"]');
      const remain = m.querySelector('[name="remaining"]');
      const minS = m.querySelector('[name="min_stock"]');
      // 精确取"批量物品"那个勾选框：表单里还有"处方药""自动算总价"
      const bulkBox = Array.from(m.querySelectorAll('.check')).find(l => /批量物品/.test(l.textContent)).querySelector('input');
      const 前 = { 数量禁用: qty.disabled, 剩余禁用: remain.disabled, 最低禁用: minS.disabled, 数量值: qty.value, 最低值: minS.value };
      bulkBox.click();
      await wait(400);
      const 后 = { 数量禁用: qty.disabled, 剩余禁用: remain.disabled, 最低禁用: minS.disabled };
      setInput(qty, '3');
      setInput(m.querySelector('[name="unitPriceYuan"]'), '19.30');
      await wait(400);
      const 总价 = m.querySelector('[name="amountYuan"]');
      return { 前, 后, 总价: 总价.value, 总价禁用: 总价.disabled };
    `,
    );

    await ev(
      '3a_物品表单_长期清空到期日',
      `${PRE}
      const m = need(modal(), '物品表单');
      const exp = m.querySelector('[name="expires_on"]');
      setInput(exp, '2027-05-01');
      await wait(200);
      const lt = Array.from(m.querySelectorAll('.check input[type=checkbox]')).find(b => {
        const lab = b.closest('label');
        return lab && /长期/.test(lab.textContent);
      });
      const 有长期框 = !!lt;
      if (lt) lt.click();
      await wait(400);
      return { 有长期框, 勾选后到期日值: exp.value, 勾选后到期日禁用: exp.disabled };
    `,
    );

    await ev(
      '3b_关闭物品表单',
      `${PRE}
      await closeModal();
      return { 弹窗已关: !modal() };
    `,
    );

    // ════════════════ 5. 详情 ════════════════

    await ev(
      '40_详情_打开',
      `${PRE}
      await goto('明细');
      await resetFilters();
      /*
       * 点一个有出入库流水的物品（不是每件都有流水）。
       *
       * 工作区 id 从**界面上读**（顶栏那个下拉的 title / 列表里的当前项），
       * 不用 window.__dsh —— 那个调试钩子只有 React 版有。
       * 更稳的办法是干脆不传 wsId：item.list(null) 与 item.get(null, uuid)
       * 走的是"当前工作区"，跟界面看到的是同一个。
       */
      const list = await window.api.item.list(null, {});
      const 候选 = (list || []).slice(0, 12);
      if (候选.length === 0) throw new Error('这个工作区一件物品都没有');
      let 名字 = null;
      for (const it of 候选) {
        const d = await window.api.item.get(null, it.uuid);
        if (d.moves.length > 0) { 名字 = it.name; break; }
      }
      const 有流水 = !!名字;
      if (!名字) 名字 = 候选[0].name;
      const link = await waitUntil(() => all('#view table.items tbody a.link').find(a => tx(a) === 名字));
      need(link, '物品链接 ' + 名字).click();
      const m = await waitFor('#modal-root .modal');
      await wait(500);
      return {
        物品名: 名字,
        有流水的物品: 有流水,
        标题: tx(m.querySelector('h2')),
        宽弹窗: m.classList.contains('wide'),
        有到期提示条: !!m.querySelector('.alert-strip'),
        到期行数: m.querySelectorAll('.alert-line').length,
        字段对数: m.querySelectorAll('.kv .k').length,
        按钮: btnTexts(m),
        有流水区: /出入库流水/.test(m.textContent),
      };
    `,
    );

    await ev(
      '41_详情_字段与流水',
      `${PRE}
      const m = need(modal(), '详情弹窗');
      const kv = Array.from(m.querySelectorAll('.kv')).map(box => Array.from(box.children).map(c => tx(c)));
      const 流水表 = Array.from(m.querySelectorAll('table')).find(t => /变化/.test(t.textContent));
      return {
        字段: kv[0] ? kv[0] : [],
        流水表头: 流水表 ? Array.from(流水表.querySelectorAll('thead th')).map(h => ({ 文案: tx(h), 对齐: getComputedStyle(h).textAlign })) : [],
        流水行数: 流水表 ? 流水表.querySelectorAll('tbody tr').length : 0,
        分段标题: all('#modal-root h3').map(h => tx(h)),
      };
    `,
    );

    await ev(
      '42_详情_关闭',
      `${PRE}
      await closeModal();
      return { 已关: !modal() };
    `,
    );

    // ════════════════ 6. 工作区 ════════════════

    await ev(
      '50_工作区_进入与结构',
      `${PRE}
      /*
       * 先确保真的进了工作区页。
       *
       * 「返回箭头」在顶栏的工作区下拉里，点它是**唯一**进入工作区页的方式
       * （它不对应任何页签）。点完要等视图换掉 —— 否则会读到上一页的表格，
       * 表现成一堆"列名不对"的失败。
       */
      need(one('.wsp-back'), '返回箭头').click();
      const t = await waitUntil(() => {
        if (tx(one('#view .view-title')) !== '工作区') return null;
        return one('#view table');
      });
      need(t, '工作区列表（点返回箭头之后没进到工作区页）');
      await wait(300);
      const 首行 = t.querySelector('tbody tr');
      return {
        页面类: one('#view').className,
        有滚动容器: !!one('#view .view-scroll'),
        标题: tx(one('#view .view-title')),
        有悬停提示: !!one('#view .tip-dot'),
        工具栏按钮: all('#view .toolbar button').map(b => b.textContent.trim()),
        表头: Array.from(t.querySelectorAll('thead th')).map(h => ({ 文案: tx(h), 对齐: getComputedStyle(h).textAlign })),
        行数: t.querySelectorAll('tbody tr').length,
        第一行: 首行 ? Array.from(首行.children).map(c => tx(c)) : null,
        底栏文案: tx(one('#view .df-label')),
        底栏按钮: all('#view .df-right button').map(b => b.textContent.trim()),
        有数据目录: !!one('#view .df-path'),
      };
    `,
    );

    await ev(
      '51_工作区_无高亮页签',
      `${PRE}
      return {
        高亮页签: all('.tab.active').map(t => t.textContent.trim()),
        当前标记数: all('#view .active-dot').length,
        当前标记文本: all('#view .active-dot').map(e => tx(e)),
      };
    `,
    );

    await ev(
      '52_新建工作区弹窗',
      `${PRE}
      clickBtn(one('#view .toolbar'), /新建工作区/);
      const m = await waitFor('#modal-root .modal');
      await wait(400);
      const hint = m.querySelector('.modal-hint');
      const label = m.querySelector('.field-label');
      const out = {
        标题: tx(m.querySelector('h2')),
        有名称输入: !!m.querySelector('[name="name"]'),
        有说明: tx(hint),
        说明左边界: hint ? Math.round(hint.getBoundingClientRect().left * 100) / 100 : null,
        标签左边界: label ? Math.round(label.getBoundingClientRect().left * 100) / 100 : null,
        按钮: btnTexts(m),
        含演示字样: /演示数据|示例数据|种子/.test(m.textContent),
      };
      clickBtn(m, /创建/);
      await wait(600);
      out.空名称后还有弹窗 = !!modal();
      out.有提示 = !!one('.toast');
      await closeModal();
      return out;
    `,
    );

    await ev(
      '53_编辑工作区弹窗',
      `${PRE}
      clickBtn(one('#view tbody tr'), /编辑/);
      const m = await waitFor('#modal-root .modal');
      await wait(400);
      const out = {
        标题: tx(m.querySelector('h2')),
        名称值: (m.querySelector('[name="name"]') || {}).value,
        有说明输入: !!m.querySelector('[name="notes"]'),
        按钮: btnTexts(m),
      };
      await closeModal();
      out.已关 = !modal();
      return out;
    `,
    );

    await ev(
      '54_删除工作区确认框',
      `${PRE}
      clickBtn(one('#view tbody tr'), /删除/);
      const m = await waitFor('#modal-root .modal');
      await wait(400);
      const out = {
        标题: tx(m.querySelector('h2')),
        段落数: m.querySelectorAll('.modal-body p').length,
        有危险文案: !!m.querySelector('.danger-text'),
        按钮: btnTexts(m),
        危险按钮类: (btns(m).find(b => /确认删除/.test(b.textContent)) || {}).className,
      };
      await closeModal();
      return out;
    `,
    );

    // ════════════════ 7. 字段与格式 ════════════════

    await ev(
      '60_字段与格式的数据',
      `${PRE}
      /*
       * 「字段与格式」这一页**从界面上点不进去**，这是当前实现的既成事实：
       * wireChrome() 只给 .tab:not(.hidden) 绑点击事件，而这一页的页签
       * 是隐藏的 —— 它连监听器都没有。
       *
       * 所以这里不点页签，改成验**它背后的数据**：页签隐藏说明这一页属于
       * "排查问题时才看"的内部页面，而数据本身走 IPC 照样拿得到。
       * 这样既覆盖了真正有用的部分（字段定义能不能读到），又不会因为
       * "点不动一个隐藏按钮"而红 —— 那是在断言一个从未打算开放的能力。
       *
       * 想真正验证那一页的渲染，得先把页签改成可点（去掉隐藏或换个入口），
       * 那是产品决策，不该由测试倒逼。
       */
      const schema = await window.api.app.schema();
      const 表 = (schema && schema.tables) || [];
      return {
        页签: all('.tab').map(t => ({ 文案: t.textContent.trim(), 隐藏: t.classList.contains('hidden') })),
        schema可读: !!schema,
        表数: 表.length,
        表名: 表.map(t => t.name),
        第一表列数: 表[0] ? 表[0].columns.length : 0,
        第一表前几列: 表[0] ? 表[0].columns.slice(0, 3).map(c => c.name + ':' + c.kind) : [],
        枚举数: schema && schema.enums ? Object.keys(schema.enums).length : 0,
        分类数: schema && schema.categoryLeadDays ? Object.keys(schema.categoryLeadDays).length : 0,
        高亮页签: all('.tab.active').map(t => t.textContent.trim()),
        当前页: tx(one('#view .view-title')),
      };
    `,
    );

    // ════════════════ 8. 结构敏感选择器 ════════════════

    await ev(
      '70_结构敏感选择器',
      `${PRE}
      await resetGroups();
      /*
       * 每条选择器都要能匹配到东西。「最少」是期望的下限，
       * 0 表示"这条规则现在不该匹配到"（比如没有收起的组）。
       *
       * 注意表格的父元素是 .group-body-inner，**不是** .group-body：
       * 历史上有一条样式写的是 .group-section > .table-wrap，
       * 从写下那天起就没匹配上过。
       */
      const 检查 = [
        ['#topbar > *', 2],
        ['.group-section.collapsed > .group-head', 0],
        ['.group-section.pinned > .group-head', 1],
        ['.group-body > .group-body-inner > .table-wrap', 1],
        ['.group-body > .table-wrap', 0],
        ['.tip-dot:hover + .tip-text', 0],
        ['tr.batch-on > td', 0],
        ['.extra-row > td', 0],
        ['.expiry-cell > div', 1],
      ];
      const out = {};
      for (const pair of 检查) {
        const n = all(pair[0]).length;
        out[pair[0]] = { 匹配数: n, 最少: pair[1], 通过: n >= pair[1] };
      }
      const tipDot = one('.tip-dot');
      out['tip-dot 的相邻兄弟'] = tipDot ? (tipDot.nextElementSibling || {}).className : null;
      return out;
    `,
    );

    await ev(
      '71_表格对齐成对检查',
      `${PRE}
      /*
       * 判据是"有没有**显式**设过对齐"，不是比较 text-align 的字面值：
       * <th> 从 UA 样式拿到 left，没设过的 <td> 拿到 start，两者等价，
       * 直接比字符串会得到一堆假阳性。
       */
      const 显式对齐 = (el) => {
        let v = '';
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          for (const r of rules) {
            if (!r.selectorText || !r.style || !r.style.textAlign) continue;
            let hit = false;
            try { hit = el.matches(r.selectorText); } catch (e) { hit = false; }
            if (hit) v = r.style.textAlign;
          }
        }
        return v;
      };
      const 结果 = [];
      for (const 页签 of ['分组', '明细']) {
        await goto(页签);
        for (const t of all('#view table')) {
          const heads = Array.from(t.querySelectorAll('thead th'));
          const firstRow = t.querySelector('tbody tr');
          if (!firstRow) continue;
          heads.forEach((h, i) => {
            const cell = firstRow.children[i];
            if (!cell) return;
            /*
             * 只盯着"表头贴左、值贴右"这一种**真的会看出来**的错位。
             *
             * 为什么不做通用比较：
             *   - left 与 start 在从左到右的文档里等价，直接比会全是假阳性
             *   - 有些页面级规则会连带匹配到 th（比如 .group-head .group-label
             *     也能命中 th 里的 .th-label），于是"显式设过 left"到处都是，
             *     但那是**一致的**左对齐，不是 bug
             * 真正踩过的坑就是这一种：数值列表头没跟着右对齐，
             * 列一宽就能差出 248px，看着像"列宽算错了"。
             */
            const 右 = (v) => v === 'right' || v === 'end';
            const ha = 显式对齐(h);
            const ca = 显式对齐(cell);
            if (右(ha) !== 右(ca)) {
              结果.push({ 页: 页签, 列: tx(h) || '(空)', 表头: ha || '(默认)', 值: ca || '(默认)', 类: h.className });
            }
          });
        }
      }
      return { 不一致数: 结果.length, 明细: 结果.slice(0, 20) };
    `,
    );

    await ev('80_渲染层未捕获异常', `return { 异常: window.__errs || [], 数量: (window.__errs || []).length };`);

    finish();
  }, 7000);
});
