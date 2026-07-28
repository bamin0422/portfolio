'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { webContents } = require('electron');

// 포트별로 열린 미리보기 webview의 webContentsId를 등록해두고,
// 로컬 HTTP 제어 서버를 통해 그 webview를 직접 조작한다.
// (외부 CDP 클라이언트는 Electron webview를 page로 인식 못 하므로 자체 제어)

const registry = new Map(); // port(number) -> webContentsId

function register(port, wcId) {
  registry.set(Number(port), wcId);
}
function unregister(port) {
  registry.delete(Number(port));
}

function wcFor(port) {
  const id = registry.get(Number(port));
  if (!id) {
    throw new Error(
      `포트 ${port}의 미리보기 탭이 열려있지 않습니다. 앱에서 해당 포트를 탭으로 먼저 여세요.`
    );
  }
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed()) {
    registry.delete(Number(port));
    throw new Error(`포트 ${port}의 webview가 이미 닫혔습니다.`);
  }
  return wc;
}

// 인터랙티브 요소 스냅샷 (버튼/링크/입력 등)
const SNAPSHOT_JS = `(() => {
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[onclick],[contenteditable=true]';
  const els = [...document.querySelectorAll(sel)];
  const out = [];
  let i = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const label = (el.innerText || el.value || el.placeholder ||
      el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    if (!label) continue;
    out.push({ i: i++, tag: el.tagName.toLowerCase(), type: el.type || undefined, text: label, id: el.id || undefined });
    if (out.length >= 150) break;
  }
  return { title: document.title, url: location.href, count: out.length, elements: out };
})()`;

function clickJS(text) {
  return `(() => {
    const t = ${JSON.stringify(String(text))};
    const cand = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[onclick],[contenteditable=true]')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const norm = e => (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim();
    let el = cand.find(e => norm(e) === t) || cand.find(e => norm(e).includes(t));
    if (!el) return { ok: false, msg: "'" + t + "' 텍스트의 클릭 요소를 못 찾음" };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, msg: '클릭됨: ' + norm(el).slice(0, 50) };
  })()`;
}

function typeJS(selector, text) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return { ok: false, msg: '셀렉터 요소 없음: ${String(selector).replace(/'/g, "")}' };
    el.focus();
    const v = ${JSON.stringify(String(text))};
    if ('value' in el) {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = v;
    }
    return { ok: true, msg: '입력됨' };
  })()`;
}

async function runAction(action, args = {}) {
  const wc = wcFor(args.port);
  switch (action) {
    case 'portfolio_snapshot':
      return await wc.executeJavaScript(SNAPSHOT_JS);
    case 'portfolio_click':
      return await wc.executeJavaScript(clickJS(args.text));
    case 'portfolio_type':
      return await wc.executeJavaScript(typeJS(args.selector, args.text));
    case 'portfolio_eval':
      return await wc.executeJavaScript(`(async () => { ${args.js} })()`);
    case 'portfolio_reload':
      wc.reload();
      return { ok: true };
    case 'portfolio_screenshot': {
      const img = await wc.capturePage();
      return { dataUrl: 'data:image/png;base64,' + img.toPNG().toString('base64') };
    }
    default:
      throw new Error('알 수 없는 action: ' + action);
  }
}

// 열린 미리보기 포트 목록 (브릿지가 참고용으로 조회)
function listPorts() {
  const ports = [];
  for (const [port, id] of registry) {
    const wc = webContents.fromId(id);
    if (wc && !wc.isDestroyed()) ports.push({ port, url: wc.getURL() });
  }
  return ports;
}

let server = null;
let info = null; // { port, token }

function startServer() {
  if (info) return Promise.resolve(info);
  return new Promise((resolve) => {
    const token = crypto.randomBytes(18).toString('hex');
    server = http.createServer((req, res) => {
      if (req.headers['x-pf-token'] !== token) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { action, args } = JSON.parse(body || '{}');
          const result =
            action === 'portfolio_list' ? listPorts() : await runAction(action, args);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    });
    // 127.0.0.1 랜덤 포트 — listen 완료 후 실제 포트 확보
    server.listen(0, '127.0.0.1', () => {
      info = { port: server.address().port, token };
      resolve(info);
    });
  });
}

function getInfo() {
  return info; // startServer()가 앱 시작 시 미리 호출돼 준비됨 (없으면 null)
}

module.exports = { register, unregister, startServer, getInfo, listPorts };
