const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const ROOT = join(__dirname, '..');
require(join(ROOT, 'dist', 'main', 'main.js'));
app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const out = {};
    try {
      out.title = win.getTitle();
      out.bounds = win.getBounds();
      // 渲染层实际生效的主题变量
      out.css = await win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          bg: cs.getPropertyValue('--bg').trim(),
          fg: cs.getPropertyValue('--fg').trim(),
          colorScheme: cs.colorScheme,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          docTitle: document.title,
        };
      })()`);
      const img = await win.webContents.capturePage();
      writeFileSync(join(ROOT, '_shot.png'), img.toPNG());
      out.shot = true;
    } catch (e) { out.err = String(e.message); }
    writeFileSync(join(ROOT, '_t.json'), JSON.stringify(out, null, 2), 'utf8');
    app.exit(0);
  }, 9000);
});
