const { app, BrowserWindow } = require('electron');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');

// 直接运行生产关闭监听器，使用真实 Electron 事件顺序；不启动应用服务或读取用户数据。
const directory = mkdtempSync(path.join(os.tmpdir(), 'cos-remote-close-'));
app.setPath('userData', directory);
app.on('quit', () => rmSync(directory, { recursive: true, force: true }));
const timeout = setTimeout(() => { console.error('Window closed without reaching application shutdown'); app.exit(1); }, 8000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  const source = readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf("  window.on('close', (event) => {");
  assert(start >= 0);
  const listener = source.slice(start, source.indexOf('\n  });', start) + 6);
  let managed = false, closed = false;
  const context = vm.createContext({ window, app, setImmediate, quitting: false,
    hasManagedRemoteHosts: () => managed, getConfig: () => ({ ui: { minimizeToTray: true } }) });
  vm.runInContext(listener, context);
  app.on('before-quit', () => { context.quitting = true; });
  window.on('closed', () => { closed = true; });
  app.on('will-quit', event => {
    event.preventDefault();
    assert(closed, 'Application shutdown must follow native window closure');
    clearTimeout(timeout);
    console.log('Managed remote close reaches application shutdown; ordinary close-to-tray stays intact.');
    app.exit(0);
  });
  await window.loadURL('data:text/html,<title>Remote close verification</title>');
  window.show();
  window.close();
  assert(!window.isDestroyed(), 'Ordinary close-to-tray must retain its window');
  managed = true;
  window.show();
  window.close();
}).catch(error => { console.error(error); app.exit(1); });
