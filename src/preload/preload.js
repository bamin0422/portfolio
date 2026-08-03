'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// renderer에는 IPC를 감싼 안전한 API만 노출한다.
contextBridge.exposeInMainWorld('api', {
  // 포트
  // force=true면 웹 여부 프로브 캐시를 무시하고 전부 다시 확인한다 (수동 새로고침).
  scanPorts: (force = false) => ipcRenderer.invoke('ports:scan', { force }),
  killPort: (pid, force = false) => ipcRenderer.invoke('ports:kill', { pid, force }),

  // 관리 프로세스(앱이 직접 실행 → 로그 캡처)
  startProc: (opts) => ipcRenderer.invoke('proc:start', opts),
  stopProc: (id, force = false) => ipcRenderer.invoke('proc:stop', { id, force }),
  removeProc: (id) => ipcRenderer.invoke('proc:remove', { id }),
  listProcs: () => ipcRenderer.invoke('proc:list'),
  getProcLogs: (id) => ipcRenderer.invoke('proc:logs', { id }),
  onProcLog: (cb) => sub('proc:log', cb),
  onProcStatus: (cb) => sub('proc:status', cb),

  // claude
  runClaude: (prompt, cwd, skipPermissions, controlInternal) =>
    ipcRenderer.invoke('claude:run', { prompt, cwd, skipPermissions, controlInternal }),
  registerWebview: (port, wcId) => ipcRenderer.invoke('webview:register', { port, wcId }),
  unregisterWebview: (port) => ipcRenderer.invoke('webview:unregister', { port }),
  onShortcut: (cb) => sub('shortcut', cb),
  cancelClaude: (runId) => ipcRenderer.invoke('claude:cancel', { runId }),
  onClaudeEvent: (cb) => sub('claude:event', cb),

  // 새 버전
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  lastUpdate: () => ipcRenderer.invoke('update:last'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateAvailable: (cb) => sub('update:available', cb),

  // 기타
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  openUrl: (url, devtools = false) => ipcRenderer.invoke('window:openUrl', { url, devtools }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
});

// 구독 헬퍼: 해제 함수를 반환
function sub(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
