'use strict';

// Portfolio webview 제어용 stdio MCP 서버 (의존성 0, raw JSON-RPC over stdio).
// Claude가 이 스크립트를 MCP 서버로 spawn하고, 요청을 앱의 로컬 HTTP 제어 서버로 포워드한다.
// env: PF_CTRL_URL (http://127.0.0.1:port), PF_TOKEN

const http = require('node:http');

const CTRL_URL = process.env.PF_CTRL_URL;
const TOKEN = process.env.PF_TOKEN || '';

const TOOLS = [
  {
    name: 'portfolio_list',
    description: '현재 앱에 탭으로 열려 있는 미리보기 포트 목록과 각 URL을 반환합니다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'portfolio_snapshot',
    description:
      '지정한 포트의 미리보기 화면에서 클릭/입력 가능한 요소(버튼·링크·입력창 등)의 목록과 텍스트를 반환합니다. 클릭 전에 먼저 호출해 대상 텍스트를 확인하세요.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number', description: '대상 포트 번호 (예: 3000)' } },
      required: ['port'],
    },
  },
  {
    name: 'portfolio_click',
    description: '지정한 포트 화면에서 주어진 텍스트와 일치(또는 포함)하는 요소를 클릭합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number' },
        text: { type: 'string', description: '클릭할 요소의 보이는 텍스트 (예: "메일쓰기")' },
      },
      required: ['port', 'text'],
    },
  },
  {
    name: 'portfolio_type',
    description: '지정한 포트 화면에서 CSS 셀렉터로 찾은 입력 요소에 텍스트를 입력합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number' },
        selector: { type: 'string', description: 'CSS 셀렉터 (예: input[name=subject])' },
        text: { type: 'string' },
      },
      required: ['port', 'selector', 'text'],
    },
  },
  {
    name: 'portfolio_eval',
    description:
      '지정한 포트 화면의 컨텍스트에서 JavaScript를 실행하고 결과를 반환합니다. 코드 본문만 넣으면 async로 감싸 실행됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number' },
        js: { type: 'string', description: '실행할 JS 코드 본문 (return 사용 가능)' },
      },
      required: ['port', 'js'],
    },
  },
  {
    name: 'portfolio_reload',
    description: '지정한 포트의 미리보기 화면을 새로고침합니다.',
    inputSchema: {
      type: 'object',
      properties: { port: { type: 'number' } },
      required: ['port'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function callControl(action, args) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ action, args });
    const u = new URL(CTRL_URL);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: '/',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'x-pf-token': TOKEN,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.ok) resolve(j.result);
            else reject(new Error(j.error || '제어 실패'));
          } catch (e) {
            reject(new Error('응답 파싱 실패: ' + body.slice(0, 120)));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error('앱 제어 서버 연결 실패: ' + e.message)));
    req.write(data);
    req.end();
  });
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'portfolio-webview', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await callControl(name, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: '오류: ' + e.message }], isError: true },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
