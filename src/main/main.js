'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { scanPorts, probePorts } = require('./portScanner');
const processManager = require('./processManager');
const claudeRunner = require('./claudeRunner');
const webviewControl = require('./webviewControl');

app.setName('Portfolio');

// 내부 화면 제어 브릿지 스크립트 경로.
// 패키징 시 소스는 app.asar 안에 묶이지만, 이 스크립트는 Claude가 외부 프로세스로
// spawn하므로 asar에서 꺼내둔(asarUnpack) 실제 파일 경로를 가리켜야 한다.
const BRIDGE_PATH = path
  .join(__dirname, '..', 'mcp', 'bridge.js')
  .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Portfolio',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 관리 프로세스 로그/상태를 renderer로 흘려보낸다.
processManager.onLog = (id, chunk) => {
  if (mainWindow) mainWindow.webContents.send('proc:log', { id, chunk });
};
processManager.onStatus = (id, status, code) => {
  if (mainWindow) mainWindow.webContents.send('proc:status', { id, status, code });
};

// claude 실행 이벤트를 renderer로 흘려보낸다.
claudeRunner.onEvent = (runId, event) => {
  if (mainWindow) mainWindow.webContents.send('claude:event', { runId, event });
};

// ---- IPC 핸들러 ----

ipcMain.handle('ports:scan', async () => {
  const ports = await scanPorts();
  const probes = await probePorts(ports.map((p) => p.port));
  return ports.map((p) => ({
    ...p,
    web: probes[p.port]?.web || false,
    html: probes[p.port]?.html || false,
    httpStatus: probes[p.port]?.status,
  }));
});

ipcMain.handle('ports:kill', async (_e, { pid, force }) => {
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    if (!force) {
      setTimeout(() => {
        try {
          process.kill(pid, 0); // 살아있는지 확인
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 이미 죽음 */
        }
      }, 2500);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('proc:start', (_e, opts) => processManager.start(opts));
ipcMain.handle('proc:stop', (_e, { id, force }) => processManager.stop(id, force));
ipcMain.handle('proc:remove', (_e, { id }) => processManager.remove(id));
ipcMain.handle('proc:list', () => processManager.list());
ipcMain.handle('proc:logs', (_e, { id }) => processManager.getLogs(id));

ipcMain.handle('claude:run', (_e, opts) => {
  // 내부 화면 제어가 켜져 있으면 제어 서버를 켜고 브릿지 MCP 정보를 함께 넘긴다.
  let control = null;
  if (opts.controlInternal) {
    const info = webviewControl.getInfo(); // { port, token } | null
    if (info) {
      control = { url: `http://127.0.0.1:${info.port}`, token: info.token, bridgePath: BRIDGE_PATH };
    }
  }
  return claudeRunner.run({ ...opts, control });
});
ipcMain.handle('claude:cancel', (_e, { runId }) => claudeRunner.cancel(runId));

// renderer가 webview 생성 시 포트↔webContentsId를 등록
ipcMain.handle('webview:register', (_e, { port, wcId }) => {
  webviewControl.register(port, wcId);
  return { ok: true };
});
ipcMain.handle('webview:unregister', (_e, { port }) => {
  webviewControl.unregister(port);
  return { ok: true };
});

ipcMain.handle('dialog:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// 실제 기본 브라우저(Chrome 등)로 열어 chrome-devtools 같은 외부 도구가
// 이 로컬 페이지에 바로 접근할 수 있게 한다.
ipcMain.handle('shell:openExternal', (_e, { url }) => {
  shell.openExternal(url);
  return { ok: true };
});

// 프론트를 별도 창에서 열고 개발자도구까지 붙일 수 있게 한다.
ipcMain.handle('window:openUrl', (_e, { url, devtools }) => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: url,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  if (devtools) win.webContents.openDevTools({ mode: 'right' });
  return { ok: true };
});

// 편집 단축키(복사/붙여넣기/실행취소 등)는 유지하되, ⌘W(창 닫기)·⌘R(창 리로드) 같은
// 기본 accelerator는 제거해 renderer의 커스텀 단축키(탭 닫기/미리보기 새로고침)가 먹게 한다.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '전체 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'togglefullscreen', label: '전체 화면' },
        { role: 'minimize', label: '최소화' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// webview에 포커스가 있으면 앱 단축키가 renderer로 안 올라온다.
// 앱 단축키에 해당하는 키만 main에서 가로채 renderer로 전달한다.
// (복사/붙여넣기 등 편집 단축키는 건드리지 않는다.)
function isAppShortcut(input) {
  const k = (input.key || '').toLowerCase();
  if (input.control && input.key === 'Tab') return true; // ⌃Tab / ⌃⇧Tab
  if ((input.meta || input.control) && !input.alt && !input.shift) {
    if (['w', 'f', 'l', 'r', 'k', 's', 'p'].includes(k)) return true;
    if (/^[1-9]$/.test(k)) return true;
  }
  return false;
}

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!isAppShortcut(input)) return;
    event.preventDefault();
    if (mainWindow) {
      mainWindow.webContents.send('shortcut', {
        key: input.key,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
      });
    }
  });
});

app.whenReady().then(async () => {
  buildMenu();
  await webviewControl.startServer(); // 내부 화면 제어용 로컬 서버 준비
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  processManager.killAll();
  claudeRunner.cancelAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  processManager.killAll();
  claudeRunner.cancelAll();
});
