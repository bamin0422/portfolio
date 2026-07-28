'use strict';
// IIFE로 감싸 전역(window.api)과의 식별자 충돌을 피하고 헬퍼들을 캡슐화한다.
(() => {
const api = window.api;

// ---- 저장소 (localStorage) ----
const store = {
  loadAliases() {
    try {
      return JSON.parse(localStorage.getItem('pc.aliases') || '{}');
    } catch {
      return {};
    }
  },
  saveAliases(a) {
    localStorage.setItem('pc.aliases', JSON.stringify(a));
  },
  loadUi() {
    try {
      return JSON.parse(localStorage.getItem('pc.ui') || '{}');
    } catch {
      return {};
    }
  },
  saveUi(u) {
    localStorage.setItem('pc.ui', JSON.stringify(u));
  },
  loadPinned() {
    try {
      return JSON.parse(localStorage.getItem('pc.pinned') || '[]');
    } catch {
      return [];
    }
  },
  savePinned(arr) {
    localStorage.setItem('pc.pinned', JSON.stringify(arr));
  },
  loadPortOrder() {
    try {
      return JSON.parse(localStorage.getItem('pc.portOrder') || '[]');
    } catch {
      return [];
    }
  },
  savePortOrder(arr) {
    localStorage.setItem('pc.portOrder', JSON.stringify(arr));
  },
};

// ---- 상태 ----
const state = {
  ports: [],
  procs: [],
  killSet: new Set(),
  tabs: [], // { id, kind:'port'|'proc', ref, subTab, el, panels, webview, hasPreview }
  activeTabId: null,
  claudeRunId: null,
  claudeCwd: null,
  claudeTarget: null, // 활성 포트 탭 → Claude 명령 대상
  search: '',
  typeFilter: 'all', // all | web | srv
  aliases: store.loadAliases(),
  ui: store.loadUi(),
  pinned: new Set(store.loadPinned()), // 상단 고정 포트 번호
  portOrder: store.loadPortOrder(), // 사용자 지정 포트 순서 (포트번호 배열)
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const aliasFor = (port) => state.aliases[port] || null;

// =====================================================================
//  포트 스캔 & 사이드바
// =====================================================================
function pulseScan() {
  const d = $('#scanDot');
  if (!d) return;
  d.classList.add('pulse');
  setTimeout(() => d.classList.remove('pulse'), 600);
}

async function refreshPorts() {
  try {
    state.ports = await api.scanPorts();
  } catch {
    state.ports = [];
  }
  pulseScan();
  renderPorts();
}

function matchesSearch(p) {
  if (state.typeFilter === 'web' && !p.web) return false;
  if (state.typeFilter === 'srv' && p.web) return false;
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  const alias = (aliasFor(p.port) || '').toLowerCase();
  return (
    String(p.port).includes(q) ||
    p.command.toLowerCase().includes(q) ||
    String(p.pid).includes(q) ||
    alias.includes(q)
  );
}

function matchesSearchPort(port) {
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return String(port).includes(q) || (aliasFor(port) || '').toLowerCase().includes(q);
}

function togglePin(port) {
  if (state.pinned.has(port)) state.pinned.delete(port);
  else state.pinned.add(port);
  store.savePinned([...state.pinned]);
  renderPorts();
}

function updateStats() {
  const webCount = state.ports.filter((p) => p.web).length;
  $('#statTotal').textContent = state.ports.length;
  $('#statWeb').textContent = webCount;
  $('#statSrv').textContent = state.ports.length - webCount;
  $('#statPin').textContent = state.pinned.size;
}

function setTypeFilter(type) {
  state.typeFilter = type;
  document
    .querySelectorAll('#typeFilter .tf-btn')
    .forEach((x) => x.classList.toggle('active', x.dataset.type === type));
  $('#statAll').classList.toggle('active', type === 'all');
  $('#statWebBtn').classList.toggle('active', type === 'web');
  $('#statSrvBtn').classList.toggle('active', type === 'srv');
  renderPorts();
}

// 사용자 지정 순서(portOrder)에 따라 정렬. 순서에 없는 포트는 뒤에 포트번호순.
function applyPortOrder(arr) {
  const idx = (port) => {
    const i = state.portOrder.indexOf(port);
    return i === -1 ? Infinity : i;
  };
  return [...arr].sort((a, b) => {
    const d = idx(a.port) - idx(b.port);
    return d !== 0 ? d : a.port - b.port;
  });
}

// 드래그 후 감지된 포트 목록의 DOM 순서를 portOrder에 저장
function commitPortOrder() {
  const list = $('#portList');
  const order = [...list.querySelectorAll('.port-item')]
    .map((li) => Number(li.dataset.port))
    .filter((n) => Number.isFinite(n));
  state.portOrder = order;
  store.savePortOrder(order);
  renderPorts();
}

function renderPorts() {
  // 이름 변경 input이 열려있으면 리스트를 다시 그리지 않는다 (input 유실 방지).
  if (state.renaming) {
    updateStats();
    return;
  }
  updateStats();
  const filtered = state.ports.filter(matchesSearch);
  const detectedPorts = new Set(state.ports.map((p) => p.port));

  const pinnedArr = [...state.pinned];
  const pinnedRunning = filtered
    .filter((p) => state.pinned.has(p.port))
    .sort((a, b) => pinnedArr.indexOf(a.port) - pinnedArr.indexOf(b.port));
  const rest = applyPortOrder(filtered.filter((p) => !state.pinned.has(p.port)));
  // 꺼진 고정 포트는 타입을 알 수 없으므로 '전체'일 때만 노출
  const offlinePinned =
    state.typeFilter === 'all'
      ? [...state.pinned]
          .filter((port) => !detectedPorts.has(port) && matchesSearchPort(port))
          .sort((a, b) => a - b)
      : [];

  // ---- 상단 고정 그룹 ----
  const pList = $('#pinnedList');
  pList.innerHTML = '';
  const pinnedTotal = pinnedRunning.length + offlinePinned.length;
  if (pinnedTotal === 0) {
    $('#pinnedHead').hidden = true;
  } else {
    $('#pinnedHead').hidden = false;
    $('#pinnedCount').textContent = pinnedTotal;
    for (const p of pinnedRunning) pList.appendChild(renderPortItem(p));
    for (const port of offlinePinned) pList.appendChild(renderOfflinePinned(port));
  }

  // ---- 감지된 포트 그룹 (고정 제외) ----
  const list = $('#portList');
  list.innerHTML = '';
  $('#portCount').textContent = state.search
    ? `${rest.length}/${state.ports.length}`
    : rest.length;

  if (rest.length === 0) {
    const hint = el('li', 'empty-hint');
    hint.textContent = state.search
      ? '검색 결과 없음'
      : state.ports.length
      ? '전부 상단 고정됨'
      : '리스닝 포트 없음';
    list.appendChild(hint);
  } else {
    for (const p of rest) list.appendChild(renderPortItem(p));
  }
}

// 꺼진(감지 안 되는) 고정 포트 항목
function renderOfflinePinned(port) {
  const li = el('li', 'port-item offline');
  const main = el('div', 'port-main');
  const title = el('div', 'port-title');
  const alias = aliasFor(port);
  if (alias) {
    const a = el('span', 'port-alias');
    a.textContent = alias;
    title.appendChild(a);
  }
  const num = el('span', 'port-num');
  num.textContent = `:${port}`;
  const badge = el('span', 'badge badge-off');
  badge.textContent = '꺼짐';
  title.appendChild(num);
  title.appendChild(badge);
  const cmd = el('div', 'port-cmd');
  cmd.textContent = '실행 중 아님';
  main.appendChild(title);
  main.appendChild(cmd);

  const actions = el('div', 'item-actions');
  const rename = el('button', 'icon-btn');
  rename.textContent = '이름';
  rename.onclick = (e) => {
    e.stopPropagation();
    startRename(li, main, { port });
  };
  const pin = el('button', 'icon-btn active');
  pin.textContent = '고정됨';
  pin.title = '고정 해제';
  pin.onclick = (e) => {
    e.stopPropagation();
    togglePin(port);
  };
  actions.appendChild(rename);
  actions.appendChild(pin);
  li.appendChild(main);
  li.appendChild(actions);
  return li;
}

function renderPortItem(p) {
  const li = el('li', 'port-item');
  if (isActiveRef('port', p.port)) li.classList.add('active');

  const chk = el('input');
  chk.type = 'checkbox';
  chk.checked = state.killSet.has(p.pid);
  chk.onclick = (e) => {
    e.stopPropagation();
    if (chk.checked) state.killSet.add(p.pid);
    else state.killSet.delete(p.pid);
    updateKillSelected();
  };

  const main = el('div', 'port-main');
  const title = el('div', 'port-title');
  const alias = aliasFor(p.port);
  if (alias) {
    const a = el('span', 'port-alias');
    a.textContent = alias;
    title.appendChild(a);
  }
  const num = el('span', 'port-num');
  num.textContent = `:${p.port}`;
  const badge = el('span', `badge ${p.web ? 'badge-web' : 'badge-srv'}`);
  badge.textContent = p.web ? 'web' : 'srv';
  title.appendChild(num);
  title.appendChild(badge);

  const cmd = el('div', 'port-cmd');
  cmd.textContent = `${p.command} · PID ${p.pid}`;
  main.appendChild(title);
  main.appendChild(cmd);

  const actions = el('div', 'item-actions');
  const rename = el('button', 'icon-btn');
  rename.textContent = '이름';
  rename.title = '이름 변경';
  rename.onclick = (e) => {
    e.stopPropagation();
    startRename(li, main, p);
  };
  const pinned = state.pinned.has(p.port);
  const pin = el('button', 'icon-btn' + (pinned ? ' active' : ''));
  pin.textContent = pinned ? '고정됨' : '고정';
  pin.title = pinned ? '고정 해제' : '상단 고정';
  pin.onclick = (e) => {
    e.stopPropagation();
    togglePin(p.port);
  };
  const kill = el('button', 'icon-btn danger');
  kill.textContent = '✕';
  kill.title = '종료';
  kill.onclick = (e) => {
    e.stopPropagation();
    killPort(p.pid);
  };
  actions.appendChild(rename);
  actions.appendChild(pin);
  actions.appendChild(kill);

  li.appendChild(chk);
  li.appendChild(main);
  li.appendChild(actions);
  li.onclick = () => openTab('port', p.port, p);

  // 드래그로 포트 순서 변경
  li.draggable = true;
  li.dataset.port = p.port;
  attachPortDrag(li);
  return li;
}

// 포트 항목 드래그 재정렬 (같은 리스트 안에서만)
function attachPortDrag(li) {
  li.addEventListener('dragstart', (e) => {
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.port);
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    const parent = li.parentElement;
    const dragging = parent.querySelector('.port-item.dragging');
    if (!dragging || dragging === li) return;
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    parent.insertBefore(dragging, after ? li.nextSibling : li);
  });
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    if (li.parentElement.id === 'pinnedList') commitPinnedOrder();
    else commitPortOrder();
  });
}

// 고정 리스트 드래그 후 순서를 pinned Set에 반영 (Set은 삽입순 유지)
function commitPinnedOrder() {
  const order = [...$('#pinnedList').querySelectorAll('.port-item')]
    .map((li) => Number(li.dataset.port))
    .filter((n) => Number.isFinite(n));
  // 꺼진 고정 포트는 DOM에 port-item이 아닐 수 있으니 기존 것 뒤에 유지
  const rest = [...state.pinned].filter((p) => !order.includes(p));
  state.pinned = new Set([...order, ...rest]);
  store.savePinned([...state.pinned]);
  renderPorts();
}

// 인라인 이름 변경
function startRename(li, main, p) {
  const input = el('input', 'rename-input');
  input.value = aliasFor(p.port) || '';
  input.placeholder = `별칭 (예: EP 프론트)`;
  const prevDisplay = main.style.display;
  main.style.display = 'none';
  li.insertBefore(input, main.nextSibling);
  input.focus();
  input.select();
  // 입력 중에는 자동 스캔 리렌더가 input을 지우지 못하게 막는다.
  state.renaming = true;

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    state.renaming = false;
    if (save) {
      const v = input.value.trim();
      if (v) state.aliases[p.port] = v;
      else delete state.aliases[p.port];
      store.saveAliases(state.aliases);
      renderTabbar(); // 열려있는 탭 라벨도 갱신
    }
    input.remove();
    main.style.display = prevDisplay;
    renderPorts();
  };

  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation(); // 전역 단축키로 이벤트가 새지 않게
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

function updateKillSelected() {
  $('#selCount').textContent = state.killSet.size;
  $('#killSelectedBtn').disabled = state.killSet.size === 0;
}

async function killPort(pid, force = false) {
  const res = await api.killPort(pid, force);
  if (!res.ok && !force) return killPort(pid, true);
  state.killSet.delete(pid);
  updateKillSelected();
  setTimeout(refreshPorts, 400);
}

async function killSelected() {
  for (const pid of Array.from(state.killSet)) await api.killPort(pid, false);
  state.killSet.clear();
  updateKillSelected();
  setTimeout(refreshPorts, 500);
}

// ---- 관리 프로세스 ----
function renderProcs() {
  const list = $('#procList');
  list.innerHTML = '';
  if (state.procs.length === 0) {
    const hint = el('li', 'empty-hint');
    hint.textContent = '실행 중인 서버 없음';
    list.appendChild(hint);
    return;
  }
  for (const proc of state.procs) {
    const li = el('li', 'proc-item');
    if (isActiveRef('proc', proc.id)) li.classList.add('active');

    const main = el('div', 'port-main');
    const title = el('div', 'port-title');
    const name = el('span', 'port-alias');
    name.textContent = proc.name;
    const badge = el(
      'span',
      `badge ${proc.status === 'running' ? 'badge-run' : 'badge-exit'}`
    );
    badge.textContent = proc.status === 'running' ? 'run' : 'exit';
    title.appendChild(name);
    title.appendChild(badge);
    const cmd = el('div', 'port-cmd');
    cmd.textContent = proc.command;
    main.appendChild(title);
    main.appendChild(cmd);

    const actions = el('div', 'item-actions');
    const kill = el('button', 'icon-btn danger');
    kill.textContent = proc.status === 'running' ? '■' : '✕';
    kill.title = proc.status === 'running' ? '중지' : '목록에서 제거';
    kill.onclick = async (e) => {
      e.stopPropagation();
      if (proc.status === 'running') await api.stopProc(proc.id);
      else {
        await api.removeProc(proc.id);
        state.procs = state.procs.filter((x) => x.id !== proc.id);
        closeTab(`proc:${proc.id}`);
        renderProcs();
      }
    };
    actions.appendChild(kill);

    li.appendChild(main);
    li.appendChild(actions);
    li.onclick = () => openTab('proc', proc.id, proc);
    list.appendChild(li);
  }
}

// =====================================================================
//  탭 시스템
// =====================================================================
function tabId(kind, ref) {
  return `${kind}:${ref}`;
}
function isActiveRef(kind, ref) {
  return state.activeTabId === tabId(kind, ref);
}
function findTab(id) {
  return state.tabs.find((t) => t.id === id);
}

function portData(port) {
  return state.ports.find((p) => p.port === port);
}
function procData(id) {
  return state.procs.find((p) => p.id === id);
}

function tabLabel(tab) {
  if (tab.kind === 'port') {
    const alias = aliasFor(tab.ref);
    return alias ? `${alias} :${tab.ref}` : `:${tab.ref}`;
  }
  const proc = procData(tab.ref);
  return proc ? proc.name : tab.ref;
}

function openTab(kind, ref, data) {
  const id = tabId(kind, ref);
  const existing = findTab(id);
  if (existing) {
    activateTab(id);
    return;
  }
  const hasPreview = kind === 'port' && !!(data && data.web);
  const tab = {
    id,
    kind,
    ref,
    hasPreview,
    subTab: hasPreview ? 'preview' : kind === 'proc' ? 'logs' : 'info',
    webview: null,
    panels: {},
    subEls: {},
  };
  buildTabContent(tab, data);
  state.tabs.push(tab);
  $('#editorBody').appendChild(tab.el);
  renderTabbar();
  activateTab(id);
}

function buildTabContent(tab, data) {
  const wrap = el('div', 'tab-content');
  wrap.hidden = true;

  // 서브탭 바
  const bar = el('div', 'subtabbar');
  const subtabs = [];
  if (tab.hasPreview) subtabs.push(['preview', '미리보기']);
  if (tab.kind === 'proc') subtabs.push(['logs', '로그']);
  else subtabs.push(['logs', '로그']);
  subtabs.push(['info', '정보']);
  // port는 로그가 안내문뿐이라 순서만 정리
  if (tab.kind === 'port') {
    // preview(있으면) → info → logs 순
    subtabs.length = 0;
    if (tab.hasPreview) subtabs.push(['preview', '미리보기']);
    subtabs.push(['info', '정보']);
    subtabs.push(['logs', '로그']);
  }

  for (const [key, label] of subtabs) {
    const b = el('button', 'subtab');
    b.textContent = label;
    b.onclick = () => setSubTab(tab, key);
    tab.subEls[key] = b;
    bar.appendChild(b);
  }

  // 주소창(편집 가능) — 로그/정보 서브탭 옆에 표시. web 탭만.
  if (tab.hasPreview) {
    const addr = el('input', 'addr-input');
    addr.value = `http://localhost:${tab.ref}/`;
    addr.spellcheck = false;
    addr.title = '주소 입력 후 Enter로 이동';
    addr.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateTab(tab, addr.value);
      }
    };
    tab._addrInput = addr;
    bar.appendChild(addr);
  } else {
    bar.appendChild(el('div', 'spacer'));
  }

  // 미리보기 도구 버튼
  if (tab.hasPreview) {
    const reload = el('button', 'btn btn-small');
    reload.textContent = '↻';
    reload.title = '새로고침';
    reload.onclick = () => tab.webview && tab.webview.reload();
    const dev = el('button', 'btn btn-small');
    dev.textContent = '개발자도구';
    dev.onclick = () => {
      ensureWebview(tab);
      if (tab.webview.isDevToolsOpened()) tab.webview.closeDevTools();
      else tab.webview.openDevTools();
    };
    const win = el('button', 'btn btn-small');
    win.textContent = '새 창 + 개발자도구';
    win.onclick = () => api.openUrl(`http://localhost:${tab.ref}/`, true);
    // 실제 브라우저(Chrome)로 열어 chrome-devtools 등 외부 도구가 접근 가능하게
    const ext = el('button', 'btn btn-small');
    ext.textContent = '브라우저에서 열기';
    ext.title = 'Chrome 등 기본 브라우저의 실제 탭으로 엽니다 (chrome-devtools 접근용)';
    ext.onclick = () => api.openExternal(`http://localhost:${tab.ref}/`);
    bar.appendChild(reload);
    bar.appendChild(dev);
    bar.appendChild(win);
    bar.appendChild(ext);
  }

  // 패널들
  const panels = el('div', 'tab-panels');

  if (tab.hasPreview) {
    const pv = el('div', 'tab-panel');
    pv.hidden = true;
    const wv = el('div', 'webview-wrap');
    pv.appendChild(wv);
    tab.panels.preview = pv;
    tab._webviewSlot = wv;
    panels.appendChild(pv);
  }

  const logs = el('div', 'tab-panel');
  logs.hidden = true;
  const pre = el('pre', 'log-view');
  logs.appendChild(pre);
  tab.panels.logs = logs;
  tab._logPre = pre;
  panels.appendChild(logs);

  const info = el('div', 'tab-panel');
  info.hidden = true;
  const table = el('table', 'info-table');
  info.appendChild(table);
  tab.panels.info = info;
  tab._infoTable = table;
  panels.appendChild(info);

  wrap.appendChild(bar);
  wrap.appendChild(panels);
  tab.el = wrap;

  // 초기 콘텐츠 채우기
  fillTabData(tab, data);
  setSubTab(tab, tab.subTab, true);
}

function fillTabData(tab, data) {
  if (tab.kind === 'port') {
    const p = data || portData(tab.ref) || { port: tab.ref };
    renderInfoTable(tab._infoTable, [
      ['별칭', aliasFor(p.port) || '-'],
      ['포트', p.port],
      ['PID', p.pid],
      ['프로세스', p.command],
      ['사용자', p.user],
      ['주소', (p.addresses || []).join(', ')],
      ['웹 응답', p.web ? `예 (HTTP ${p.httpStatus || '?'})` : '아니오'],
    ]);
    tab._logPre.textContent =
      `이 포트(:${p.port}, PID ${p.pid})는 앱 외부에서 실행된 프로세스입니다.\n` +
      `macOS에서는 외부 프로세스의 실시간 로그(stdout)를 가로챌 수 없습니다.\n\n` +
      `실시간 로그를 보려면 "앱에서 실행한 서버 → + 서버 실행"으로 띄워주세요.`;
  } else {
    const proc = data || procData(tab.ref);
    if (proc) {
      renderInfoTable(tab._infoTable, [
        ['이름', proc.name],
        ['명령어', proc.command],
        ['작업폴더', proc.cwd],
        ['PID', proc.pid],
        ['상태', proc.status],
      ]);
      api.getProcLogs(tab.ref).then((t) => {
        tab._logPre.textContent = t || '(로그 없음)';
        if (tab.subTab === 'logs') tab._logPre.scrollTop = tab._logPre.scrollHeight;
      });
    }
  }
}

function renderInfoTable(table, rows) {
  table.innerHTML = '';
  for (const [k, v] of rows) {
    const tr = el('tr');
    const td1 = el('td');
    td1.textContent = k;
    const td2 = el('td', 'mono');
    td2.textContent = v ?? '';
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
}

function ensureWebview(tab) {
  if (tab.webview || !tab.hasPreview) return;
  const wv = document.createElement('webview');
  const startUrl = tab._addrInput ? tab._addrInput.value : `http://localhost:${tab.ref}/`;
  wv.setAttribute('src', startUrl);
  tab._webviewSlot.appendChild(wv);
  tab.webview = wv;
  // 웹뷰가 이동하면 주소창을 동기화
  const sync = (e) => {
    if (tab._addrInput && e && e.url) tab._addrInput.value = e.url;
  };
  wv.addEventListener('did-navigate', sync);
  wv.addEventListener('did-navigate-in-page', sync);
  // 내부 화면 제어용: 포트↔webContentsId를 main에 등록
  wv.addEventListener('dom-ready', () => {
    try {
      api.registerWebview(tab.ref, wv.getWebContentsId());
    } catch {}
  });
}

// 주소창에서 입력한 URL로 웹뷰 이동
function navigateTab(tab, url) {
  url = (url || '').trim();
  if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'http://' + url;
  setSubTab(tab, 'preview'); // 미리보기로 전환하며 웹뷰 보장
  if (tab._addrInput) tab._addrInput.value = url;
  try {
    tab.webview.loadURL(url);
  } catch {
    tab.webview.setAttribute('src', url);
  }
}

function setSubTab(tab, key, silent) {
  tab.subTab = key;
  for (const [k, btn] of Object.entries(tab.subEls)) {
    btn.classList.toggle('active', k === key);
  }
  for (const [k, panel] of Object.entries(tab.panels)) {
    panel.hidden = k !== key;
  }
  if (key === 'preview') ensureWebview(tab);
  if (key === 'logs' && !silent) tab._logPre.scrollTop = tab._logPre.scrollHeight;
}

function renderTabbar() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  for (const tab of state.tabs) {
    const t = el('div', 'tab');
    if (tab.id === state.activeTabId) t.classList.add('active');
    const label = el('span', 'tab-label');
    label.textContent = tabLabel(tab);
    const close = el('button', 'tab-close');
    close.textContent = '×';
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    };
    t.appendChild(label);
    t.appendChild(close);
    t.onclick = () => activateTab(tab.id);

    // 드래그로 탭 순서 변경
    t.draggable = true;
    t.dataset.tabId = tab.id;
    t.addEventListener('dragstart', (e) => {
      t.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.id);
    });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    t.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = bar.querySelector('.tab.dragging');
      if (!dragging || dragging === t) return;
      const r = t.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      bar.insertBefore(dragging, after ? t.nextSibling : t);
    });
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      commitTabOrder();
    });

    bar.appendChild(t);
  }
  const hasTabs = state.tabs.length > 0;
  $('#welcome').hidden = hasTabs;
  bar.hidden = !hasTabs; // 탭 없으면 탭바 자체를 숨겨 빈 띠 제거
}

// 드래그 후 DOM 순서를 state.tabs에 반영
function commitTabOrder() {
  const bar = $('#tabbar');
  const order = [...bar.querySelectorAll('.tab')].map((t) => t.dataset.tabId);
  state.tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  renderTabbar();
}

function activateTab(id) {
  state.activeTabId = id;
  for (const tab of state.tabs) {
    tab.el.hidden = tab.id !== id;
  }
  renderTabbar();
  renderPorts();
  renderProcs();
  updateClaudeTarget();
}

// 활성 탭이 포트면 그 포트를 Claude 명령 대상으로 삼는다.
function updateClaudeTarget() {
  const chip = $('#claudeTarget');
  const tab = findTab(state.activeTabId);
  if (tab && tab.kind === 'port') {
    const p = portData(tab.ref);
    state.claudeTarget = {
      port: tab.ref,
      url: `http://localhost:${tab.ref}`,
      command: p ? p.command : null,
      pid: p ? p.pid : null,
      alias: aliasFor(tab.ref),
    };
    chip.textContent = `대상 :${tab.ref}`;
    chip.classList.add('has-target');
  } else {
    state.claudeTarget = null;
    chip.textContent = '대상 없음';
    chip.classList.remove('has-target');
  }
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = state.tabs.splice(idx, 1);
  if (tab.webview) {
    try {
      tab.webview.remove();
    } catch {}
  }
  tab.el.remove();

  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      activateTab(next.id); // 다음 탭을 정상 활성화(모든 표시 상태 재설정)
      return;
    }
    state.activeTabId = null;
  }
  renderTabbar();
  renderPorts();
  renderProcs();
  updateClaudeTarget();
}

// =====================================================================
//  Claude
// =====================================================================
function appendClaude(text) {
  const out = $('#claudeOutput');
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

async function runClaude() {
  const prompt = $('#claudePrompt').value.trim();
  if (!prompt || state.claudeRunId) return;
  // 접혀있으면 펼침
  if (document.body.classList.contains('claude-collapsed')) toggleClaude(true);

  // 대상 포트 컨텍스트 주입
  const useCtx = $('#claudeCtx').checked;
  const t = state.claudeTarget;
  let finalPrompt = prompt;
  let echo = prompt;
  if (useCtx && t) {
    finalPrompt =
      `[대상 포트 컨텍스트]\n` +
      `- 로컬 URL: ${t.url}\n` +
      `- 프로세스: ${t.command || '?'} (PID ${t.pid || '?'})\n` +
      (t.alias ? `- 별칭: ${t.alias}\n` : '') +
      `이 로컬 서버에 접근·확인이 필요하면 위 URL을 사용하세요.\n\n` +
      prompt;
    echo = `${prompt}   → 대상 ${t.url}`;
  }

  appendClaude(`\n\n$ ${echo}\n`);
  $('#claudePrompt').value = '';
  $('#claudeRunBtn').disabled = true;
  $('#claudeCancelBtn').disabled = false;

  const skipPerm = $('#claudeSkipPerm').checked;
  const controlInternal = $('#claudeControl').checked;

  // 내부 화면 제어 시, portfolio-webview MCP 도구 사용을 안내
  if (controlInternal) {
    const port = t ? t.port : '(대상 포트)';
    finalPrompt =
      `[내부 화면 제어 모드]\n` +
      `portfolio-webview MCP 도구로 앱 안의 미리보기 화면을 직접 조작할 수 있습니다.\n` +
      `대상 포트: ${port}. 먼저 portfolio_snapshot(port:${port})로 화면의 클릭 가능한 요소를\n` +
      `확인한 뒤, portfolio_click(port:${port}, text:"...")로 클릭하거나 portfolio_type으로 입력하세요.\n` +
      `필요하면 portfolio_eval로 임의 JS를 실행할 수 있습니다.\n\n` +
      finalPrompt;
  }

  const { runId } = await api.runClaude(finalPrompt, state.claudeCwd, skipPerm, controlInternal);
  state.claudeRunId = runId;
}

function onClaudeEvent({ runId, event }) {
  if (runId !== state.claudeRunId) return;
  switch (event.type) {
    case 'system':
      appendClaude(`[${event.text}]\n`);
      break;
    case 'tool':
      appendClaude(`\n${event.text}\n`);
      break;
    case 'text':
    case 'stderr':
      appendClaude(event.text);
      break;
    case 'result':
      appendClaude(
        `\n\n[완료${event.isError ? ' · 오류' : ''}${
          event.durationMs ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''
        }${event.cost ? ` · $${event.cost.toFixed(4)}` : ''}]\n`
      );
      break;
    case 'error':
      appendClaude(`\n[오류] ${event.text}\n`);
      break;
    case 'end':
      finishClaude();
      break;
  }
}

function finishClaude() {
  state.claudeRunId = null;
  $('#claudeRunBtn').disabled = false;
  $('#claudeCancelBtn').disabled = true;
}

async function cancelClaude() {
  if (state.claudeRunId) {
    await api.cancelClaude(state.claudeRunId);
    appendClaude('\n[중지됨]\n');
    finishClaude();
  }
}

// =====================================================================
//  서버 실행 모달
// =====================================================================
function openProcModal() {
  $('#procName').value = '';
  $('#procCommand').value = '';
  $('#procCwd').value = '';
  $('#procModal').showModal();
}

async function submitProc(e) {
  const command = $('#procCommand').value.trim();
  if (!command) {
    e.preventDefault();
    return;
  }
  const opts = {
    name: $('#procName').value.trim() || command,
    command,
    cwd: $('#procCwd').value.trim() || null,
  };
  const summary = await api.startProc(opts);
  state.procs.push(summary);
  renderProcs();
  openTab('proc', summary.id, summary);
}

// =====================================================================
//  패널 토글 (사이드바 / Claude)
// =====================================================================
function toggleSidebar() {
  document.body.classList.toggle('sidebar-collapsed');
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  $('#toggleSidebar').classList.toggle('active', !collapsed);
  state.ui.sidebarCollapsed = collapsed;
  store.saveUi(state.ui);
}

// 사이드바가 접혀있으면 펼치기만 (검색 포커스용)
function toggleSidebarOpen() {
  if (document.body.classList.contains('sidebar-collapsed')) toggleSidebar();
}

// 다음/이전 탭으로 순환 이동
function cycleTab(dir) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const next = (i + dir + state.tabs.length) % state.tabs.length;
  activateTab(state.tabs[next].id);
}

// 단축키 처리 (input: {key, control, meta, shift, alt}). 처리했으면 true 반환.
function handleShortcut(input) {
  const k = (input.key || '').toLowerCase();
  const meta = input.meta || input.control;

  // Ctrl+Tab / Ctrl+Shift+Tab → 다음/이전 탭
  if (input.control && input.key === 'Tab') {
    cycleTab(input.shift ? -1 : 1);
    return true;
  }
  if (!meta || input.alt || input.shift) return false;

  switch (k) {
    case 's':
      toggleSidebar();
      return true;
    case 'p':
      toggleClaude();
      return true;
    case 'w':
      if (state.activeTabId) {
        closeTab(state.activeTabId);
        return true;
      }
      return false;
    case 'f':
      toggleSidebarOpen();
      $('#portSearch').focus();
      $('#portSearch').select();
      return true;
    case 'r': {
      const tab = findTab(state.activeTabId);
      if (tab && tab.webview) {
        tab.webview.reload();
        return true;
      }
      return false;
    }
    case 'l': {
      const tab = findTab(state.activeTabId);
      if (tab && tab._addrInput) {
        tab._addrInput.focus();
        tab._addrInput.select();
        return true;
      }
      return false;
    }
    case 'k':
      if (document.body.classList.contains('claude-collapsed')) toggleClaude(true);
      $('#claudePrompt').focus();
      return true;
    default:
      if (/^[1-9]$/.test(k)) {
        const idx = Number(k) - 1;
        if (state.tabs[idx]) {
          activateTab(state.tabs[idx].id);
          return true;
        }
      }
      return false;
  }
}

// 사이드바 폭 / Claude 높이 드래그 리사이즈
function setupResizers() {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const startDrag = (handle, cursor, onMove) => (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    document.body.style.cursor = cursor;
    handle.classList.add('active');
    const up = () => {
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', up);
      const cs = getComputedStyle(document.documentElement);
      state.ui.sidebarW = cs.getPropertyValue('--sidebar-w').trim();
      state.ui.claudeH = cs.getPropertyValue('--claude-h').trim();
      store.saveUi(state.ui);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', up);
  };

  const rx = $('#resizerX');
  rx.addEventListener(
    'mousedown',
    startDrag(rx, 'col-resize', (ev) => {
      const w = clamp(ev.clientX, 190, 640);
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    })
  );

  const ry = $('#resizerY');
  ry.addEventListener(
    'mousedown',
    startDrag(ry, 'row-resize', (ev) => {
      const h = clamp(window.innerHeight - ev.clientY, 80, window.innerHeight - 180);
      document.documentElement.style.setProperty('--claude-h', h + 'px');
    })
  );
}

function toggleClaude(forceOpen) {
  if (forceOpen === true) document.body.classList.remove('claude-collapsed');
  else document.body.classList.toggle('claude-collapsed');
  const collapsed = document.body.classList.contains('claude-collapsed');
  $('#toggleClaude').classList.toggle('active', !collapsed);
  $('#claudeCollapse').textContent = collapsed ? '펼치기' : '접기';
  state.ui.claudeCollapsed = collapsed;
  store.saveUi(state.ui);
}

function applyUiPrefs() {
  if (state.ui.sidebarW)
    document.documentElement.style.setProperty('--sidebar-w', state.ui.sidebarW);
  if (state.ui.claudeH)
    document.documentElement.style.setProperty('--claude-h', state.ui.claudeH);
  if (state.ui.sidebarCollapsed) {
    document.body.classList.add('sidebar-collapsed');
    $('#toggleSidebar').classList.remove('active');
  }
  if (state.ui.claudeCollapsed) {
    document.body.classList.add('claude-collapsed');
    $('#toggleClaude').classList.remove('active');
    $('#claudeCollapse').textContent = '펼치기';
  }
}

// =====================================================================
//  바인딩
// =====================================================================
function bind() {
  $('#refreshBtn').onclick = refreshPorts;
  $('#killSelectedBtn').onclick = killSelected;
  $('#addProcBtn').onclick = openProcModal;

  $('#toggleSidebar').onclick = () => toggleSidebar();
  $('#toggleClaude').onclick = () => toggleClaude();
  $('#claudeCollapse').onclick = () => toggleClaude();

  // 전역 단축키 — DOM 이벤트(renderer 포커스)와 IPC(webview 포커스) 양쪽에서 처리
  document.addEventListener('keydown', (e) => {
    const handled = handleShortcut({
      key: e.key,
      control: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
    });
    if (handled) e.preventDefault();
  });
  // webview에 포커스가 있을 때 main이 가로채 전달한 단축키
  if (api.onShortcut) api.onShortcut((input) => handleShortcut(input));

  // 검색
  $('#portSearch').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderPorts();
  });

  // web/srv 타입 필터 (사이드바 버튼 + 상단 통계 클릭 공용)
  document.querySelectorAll('#typeFilter .tf-btn').forEach((b) => {
    b.onclick = () => setTypeFilter(b.dataset.type);
  });
  $('#statAll').onclick = () => setTypeFilter('all');
  $('#statWebBtn').onclick = () => setTypeFilter('web');
  $('#statSrvBtn').onclick = () => setTypeFilter('srv');

  // Claude
  $('#claudeRunBtn').onclick = runClaude;
  $('#claudeCancelBtn').onclick = cancelClaude;
  $('#claudeClearBtn').onclick = () => ($('#claudeOutput').textContent = '');
  $('#claudePrompt').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      // ⌘/Ctrl/Shift + Enter → 줄바꿈
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 1;
    } else {
      // 그냥 Enter → 실행
      e.preventDefault();
      runClaude();
    }
  });
  $('#claudeCwdBtn').onclick = async () => {
    const dir = await api.pickDir();
    if (dir) {
      state.claudeCwd = dir;
      $('#claudeCwd').textContent = dir.split('/').pop() || dir;
    }
  };
  // 대상 칩 클릭 → 프롬프트에 URL 삽입
  $('#claudeTarget').onclick = () => {
    if (!state.claudeTarget) return;
    const ta = $('#claudePrompt');
    const ins = state.claudeTarget.url + ' ';
    const s = ta.selectionStart ?? ta.value.length;
    const e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + ins.length;
  };

  // 모달
  $('#procCwdBtn').onclick = async () => {
    const dir = await api.pickDir();
    if (dir) $('#procCwd').value = dir;
  };
  $('#procSubmit').addEventListener('click', submitProc);

  // 실시간 구독
  api.onProcLog(({ id, chunk }) => {
    const tab = findTab(`proc:${id}`);
    if (tab) {
      tab._logPre.textContent += chunk;
      if (tab.id === state.activeTabId && tab.subTab === 'logs') {
        tab._logPre.scrollTop = tab._logPre.scrollHeight;
      }
    }
  });
  api.onProcStatus(({ id, status }) => {
    const proc = procData(id);
    if (proc) proc.status = status;
    renderProcs();
    renderTabbar();
  });
  api.onClaudeEvent(onClaudeEvent);
}

// ---- 자동 새로고침 ----
let autoTimer = null;
function setupAutoRefresh() {
  const cb = $('#autoRefresh');
  const apply = () => {
    if (autoTimer) clearInterval(autoTimer);
    if (cb.checked) autoTimer = setInterval(refreshPorts, 3000);
  };
  cb.onchange = apply;
  apply();
}

// ---- 시작 ----
applyUiPrefs();
bind();
setupResizers();
renderTabbar(); // 초기 상태: 탭 없으면 탭바 숨김 + welcome 표시
setupAutoRefresh();
refreshPorts();
renderProcs();
})();
