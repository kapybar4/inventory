// 只探 IPC/API 契约，不碰 DOM
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
require(join(ROOT, 'dist', 'main', 'main.js'));

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const out = {};
    const run = async (label, code) => {
      try {
        out[label] = await win.webContents.executeJavaScript(`(async () => { ${code} })()`);
      } catch (e) {
        out[label] = { __err: String(e.message) };
      }
    };

    await run('a_list无参', `
      const r = await window.api.item.list(null, {});
      return { keys: Object.keys(r || {}), count: r && r.items ? r.items.length : null };
    `);
    await run('b_list带search', `
      const r = await window.api.item.list(null, { search: '布洛芬' });
      return { keys: Object.keys(r || {}), count: r && r.items ? r.items.length : null,
               names: r && r.items ? r.items.map(i => i.name) : null };
    `);
    await run('c_创建', `
      const r = await window.api.item.save(null, { name: '契约测试物', category: 'digital', brand: 'B', model: 'M' });
      return { keys: Object.keys(r || {}), uuid: r && r.uuid, name: r && r.name, model: r && r.model };
    `);
    await run('d_按名字查', `
      const r = await window.api.item.list(null, { search: '契约测试物' });
      return { count: r && r.items ? r.items.length : null, first: r && r.items && r.items[0] ? r.items[0].name : null };
    `);
    await run('e_按uuid查', `
      const all = await window.api.item.list(null, {});
      const found = (all.items || []).find(i => i.name === '契约测试物');
      if (!found) return { found: false };
      const g = await window.api.item.get(null, found.uuid);
      return { found: true, keys: Object.keys(g || {}), name: g && g.name };
    `);
    await run('f_消耗', `
      const all = await window.api.item.list(null, {});
      const found = (all.items || []).find(i => i.name === '契约测试物');
      if (!found) return { found: false };
      const r = await window.api.item.consume(null, found.uuid, 1, 'consume');
      return { keys: Object.keys(r || {}), remaining: r && r.remaining, status: r && r.status };
    `);
    await run('g_未分类创建', `
      const r = await window.api.item.save(null, { name: '未分类契约物', category: '' });
      return { uuid: r && r.uuid, category: r && r.category };
    `);

    writeFileSync(join(ROOT, '_api.json'), JSON.stringify(out, null, 2), 'utf8');
    app.exit(0);
  }, 8000);
});
