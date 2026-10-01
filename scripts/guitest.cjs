/**
 * 功能测试装置（桌面端）。
 *
 * 每一步单独一次 executeJavaScript：哪一步失败就能精确归因，
 * 而不是整块脚本抛一个「Cannot read properties of undefined」。
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
setTimeout(() => finish({ timeout: true, stuckAt: current }), 140000);

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) consoleErrors.push(message);
    });

    /** 跑一段渲染层代码，出错就记下来并抛出 */
    async function ev(label, code) {
      current = label;
      try {
        results[label] = await win.webContents.executeJavaScript(`(async () => { ${code} })()`);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        failed.push({ label, error: msg });
        results[label] = { __failed: msg };
      }
    }

    const PRELUDE = `
      const $ = (s) => document.querySelector(s);
      const $$ = (s) => Array.from(document.querySelectorAll(s));
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const tab = (t) => $$('.tab').find(b => b.textContent.trim().startsWith(t));
      const modal = () => $('#modal-root .modal');
      const need = (v, what) => { if (!v) throw new Error('找不到: ' + what); return v; };
      const clickButton = (scope, re) => {
        const btns = Array.from(scope.querySelectorAll('button'));
        const b = btns.find(x => re.test(x.textContent.trim()));
        if (!b) throw new Error('没有匹配 ' + re + ' 的按钮，现有: ' + btns.map(x => x.textContent.trim()).filter(Boolean).join(' / '));
        b.click(); return true;
      };
    `;

    // 渲染层异常挂到 window 上
    await win.webContents
      .executeJavaScript(`(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.error && e.error.stack || e.message).split('\\n').slice(0,2).join(' | '))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + String(e.reason && e.reason.stack || e.reason).split('\\n').slice(0,2).join(' | '))); return true; })()`)
      .catch(() => {});

    // ── 1. 概览 ──
    await ev('01_概览', `${PRELUDE}
      need(tab('概览'), '概览页签').click();
      await wait(900);
      return {
        hasAlertStrip: !!$('#view .alert-strip'),
        cardTitles: $$('#view .card-title').map(c => c.textContent.trim()).slice(0, 8),
        text: $('#view').textContent.trim().slice(0, 120),      };
    `);

    // ── 2. 物品页 ──
    await ev('02_物品页', `${PRELUDE}
      need(tab('物品'), '物品页签').click();
      await wait(900);
      return {
        headers: $$('#view thead th').map(th => th.textContent.trim()),
        rows: $$('#view tbody tr').length,
        searchPlaceholder: $('#view [name=search]') ? $('#view [name=search]').placeholder : null,
        buttons: $$('#view button').map(b => b.textContent.trim()).filter(Boolean).slice(0, 10),
      };
    `);

    await ev('03_按型号搜索', `${PRELUDE}
      const s = need($('#view [name=search]'), '搜索框');
      s.value = 'MX';
      s.dispatchEvent(new Event('input'));
      await wait(1000);
      const hits = $$('#view tbody tr').map(tr => tr.children[1].textContent.trim());
      s.value = '';
      s.dispatchEvent(new Event('input'));
      await wait(900);
      return { hits };
    `);

    // ── 3. 新增：打开表单 ──
    await ev('04_打开新增表单', `${PRELUDE}
      clickButton($('#view'), /新增物品/);
      await wait(800);
      const m = need(modal(), '新增弹窗');
      return {
        fieldNames: Array.from(m.querySelectorAll('[name]')).map(x => x.getAttribute('name')),
        labels: Array.from(m.querySelectorAll('.field-label')).map(l => l.textContent.trim()),
        buttons: Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim()).filter(Boolean),
      };
    `);

    await ev('05_填写并创建', `${PRELUDE}
      const m = need(modal(), '新增弹窗');
      const set = (name, v) => {
        const i = m.querySelector('[name=' + name + ']');
        if (!i) throw new Error('弹窗没有字段 ' + name);
        i.value = v;
        i.dispatchEvent(new Event('input'));
        i.dispatchEvent(new Event('change'));
      };
      set('name', '界面新增测试');
      set('category', 'digital');
      set('brand', '测试品牌');
      set('model', 'TM-1');
      set('spec', '规格X');
      set('expires_on', '2029-03-05');
      clickButton(m, /创建|保存|确定/);
      await wait(1400);
      // 关弹窗是加 hidden 类，不是从 DOM 移除
      const still = modal();
      return { modalHidden: still ? still.parentElement.classList.contains('hidden') : true, modalPresent: !!still };
    `);

    // 契约：item.list 直接返回数组；item.save 返回 { created, item }
    await ev('06_核对新增结果', `
      const arr = await window.api.item.list(null, { search: '界面新增测试' });
      const it = (arr || [])[0];
      return it ? {
        count: arr.length, uuid: it.uuid, brand: it.brand, model: it.model,
        spec: it.spec, expiresOn: it.expiresOn, category: it.category,
      } : { count: 0 };
    `);

    // ── 4. 详情 ──
    await ev('07_详情三行分开', `${PRELUDE}
      await wait(500);
      const row = need($$('#view tbody tr').find(tr => tr.textContent.includes('界面新增测试')), '新增的行');
      row.querySelector('a.link').click();
      await wait(900);
      const kv = {};
      const ks = $$('#modal-root .kv .k');
      const vs = $$('#modal-root .kv .v');
      ks.forEach((k, i) => { kv[k.textContent.trim()] = vs[i] ? vs[i].textContent.trim() : null; });
      // 详情弹窗顶部应当有到期情况条
      const strip = $('#modal-root .alert-strip');
      const stripLines = $('#modal-root .alert-strip') ? Array.from($('#modal-root .alert-strip').querySelectorAll('.alert-line')).map(x => x.textContent.trim()) : [];
      clickButton(need(modal(), '详情弹窗'), /关闭|取消|确定/);
      await wait(600);
      return {
        brand: kv['品牌'], model: kv['型号'], spec: kv['规格'], title: kv['分类'],
        hasAlertStrip: !!strip, alertLines: stripLines.slice(0, 3),
      };
    `);

    // ── 5. 编辑：只改名字 ──
    await ev('08_只改名字', `
      const before = (await window.api.item.list(null, { search: '界面新增测试' }))[0];
      const res = await window.api.item.save(null, { uuid: before.uuid, name: '界面新增测试改名' });
      const after = (await window.api.item.list(null, { search: '界面新增测试改名' }))[0];
      return {
        created: res.created, model: after.model, spec: after.spec, expiresOn: after.expiresOn, brand: after.brand,
        unchanged: after.model === before.model && after.spec === before.spec && after.expiresOn === before.expiresOn,
      };
    `);

    // ── 6. 消耗 ──
    await ev('09_消耗', `
      const it = (await window.api.item.list(null, { search: '界面新增测试改名' }))[0];
      await window.api.item.consume(null, it.uuid, 1, 'consume');
      const after = (await window.api.item.list(null, { search: '界面新增测试改名', all: true }))[0];
      return {
        remaining: after ? after.remaining : null,
        status: after ? after.status : null,
        listShape: Array.isArray(await window.api.item.list(null, {})),
      };
    `);

    // ── 7. 分组页 ──
    await ev('10_分组页一级', `${PRELUDE}
      need(tab('分组'), '分组页签').click();
      await wait(1700);
      const first = $('#view .group-section');
      return {
        sections: $$('#view .group-section').length,
        lv1: $$('#view .group-section.lv-1').length,
        pinned: $$('#view .group-section.pinned').length,
        firstIsPinned: first ? first.classList.contains('pinned') : null,
        firstLabel: $('#view .group-label') ? $('#view .group-label').textContent.trim() : null,
        draggableGroups: $$('#view .group-head[draggable=true]').length,
        draggableItems: $$('#view tr.item-row[draggable=true]').length,
        levelButtons: $$('#view .seg-btn').map(b => b.textContent.trim()),
        activeLevel: ($('#view .seg-btn.active') || {}).textContent,
        sortSwitchOn: $('#view .sort-switch input') ? $('#view .sort-switch input').checked : null,
        hasUncatBanner: !!$('#view .uncat-banner'),
      };
    `);

    await ev('11_三级分组', `${PRELUDE}
      need($$('#view .seg-btn').find(b => b.textContent.trim() === '3 级'), '3 级按钮').click();
      await wait(1700);
      return {
        activeLevel: ($('#view .seg-btn.active') || {}).textContent,
        lv1: $$('#view .group-section.lv-1').length,
        lv2: $$('#view .group-section.lv-2').length,
        lv3: $$('#view .group-section.lv-3').length,
        labels: $$('#view .group-label').map(l => l.textContent.trim()).slice(0, 12),
      };
    `);

    await ev('12_收起展开', `${PRELUDE}
      const before = $$('#view tr.item-row').length;
      const heads = $$('#view .group-head');
      if (heads[1]) heads[1].click();
      await wait(800);
      const afterCollapse = $$('#view tr.item-row').length;
      const collapsed = $$('#view .caret.collapsed');
      if (collapsed[0]) collapsed[0].click();
      await wait(800);
      const afterExpand = $$('#view tr.item-row').length;
      need($$('#view .seg-btn').find(b => b.textContent.trim() === '1 级'), '1 级按钮').click();
      await wait(1400);
      return { before, afterCollapse, afterExpand, collapseChanged: afterCollapse !== before, expandRestored: afterExpand === before };
    `);

    await ev('13_开启排序禁用拖动', `${PRELUDE}
      const sw = need($('#view .sort-switch input'), '排序开关');
      const beforeItems = $$('#view tr.item-row[draggable=true]').length;
      sw.click();
      await wait(1700);
      return {
        switchOn: $('#view .sort-switch input').checked,
        draggableBefore: beforeItems,
        draggableAfter: $$('#view tr.item-row[draggable=true]').length,
        handlesAfter: $$('#view td.drag-handle').length,
        sortField: $('#view [name=sortField]') ? $('#view [name=sortField]').value : null,
      };
    `);

    await ev('14_关掉排序恢复拖动', `${PRELUDE}
      $('#view .sort-switch input').click();
      await wait(1700);
      return {
        switchOn: $('#view .sort-switch input').checked,
        draggable: $$('#view tr.item-row[draggable=true]').length,
        handles: $$('#view td.drag-handle').length,
      };
    `);

    // ── 8. 时间轴 ──
    await ev('15_时间轴', `${PRELUDE}
      need(tab('时间轴'), '时间轴页签').click();
      await wait(1800);
      return {
        slots: $$('#view .tl-slot').length,
        bars: $$('#view .tl-bar').length,
        rows: $$('#view .tl-row').length,
        hasToday: !!$('#view .tl-today'),
        granularities: $$('#view .seg-btn').map(b => b.textContent.trim()),
        categoryOptions: $$('#view [name=tlCat] option').length,
        scrollWidth: $('#view .tl-scroll') ? $('#view .tl-scroll').scrollWidth : null,
      };
    `);

    await ev('16_时间轴换粒度', `${PRELUDE}
      const btns = $$('#view .seg-btn');
      const day = btns.find(b => /日/.test(b.textContent));
      if (day) day.click();
      await wait(1500);
      const daySlots = $$('#view .tl-slot').length;
      const year = $$('#view .seg-btn').find(b => /年/.test(b.textContent));
      if (year) year.click();
      await wait(1500);
      return { daySlots, yearSlots: $$('#view .tl-slot').length };
    `);

    // ── 9. 工作区页 ──
    await ev('17_工作区页', `${PRELUDE}
      need(tab('工作区'), '工作区页签').click();
      await wait(1400);
      return {
        rows: $$('#view tbody tr').length,
        picker: !!$('#ws-picker'),
        pickerText: $('#ws-picker') ? $('#ws-picker').textContent.trim().slice(0, 40) : null,
        pickerOptions: $$('#ws-picker [role=option], #ws-picker li, #ws-picker .wsp-item').length,
        dataFooter: !!$('#view .data-footer'),
        footerText: $('#view .data-footer') ? $('#view .data-footer').textContent.trim().slice(0, 80) : null,
        buttons: $$('#view button').map(b => b.textContent.trim()).filter(Boolean).slice(0, 14),
      };
    `);

    // ── 10. 字段与格式 ──
    await ev('18_字段与格式', `${PRELUDE}
      need(tab('字段与格式'), '字段与格式页签').click();
      await wait(1300);
      return {
        sectionTitles: $$('#view h2').map(t => t.textContent.trim()).filter(Boolean).slice(0, 8),
        mentionsModel: $('#view').textContent.includes('型号'),
        mentionsSortOrder: $('#view').textContent.includes('手动顺序'),
        mentionsModelHint: $('#view').textContent.includes('与规格') || $('#view').textContent.includes('哪一款'),
        tableCount: $$('#view table').length,
      };
    `);

    await ev('19_渲染层异常', `return { errs: (window.__errs || []).slice(0, 8) };`);

    finish();
  }, 9000);
});
