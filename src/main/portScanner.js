'use strict';

const { execFile } = require('node:child_process');
const http = require('node:http');
const { spawnEnv } = require('./env');

// lsof로 LISTEN 중인 TCP 포트를 스캔한다.
// 출력 예:
// node    12345 bamin0422   23u  IPv4 0x...  0t0  TCP *:3000 (LISTEN)
function scanPorts() {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '+c', '0'],
      { env: spawnEnv(), timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve([]);
          return;
        }
        resolve(parseLsof(stdout || ''));
      }
    );
  });
}

function parseLsof(stdout) {
  const lines = stdout.split('\n');
  // 포트 기준으로 묶는다 (IPv4/IPv6 중복 제거)
  const byPort = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // 마지막 컬럼 쪽에 "TCP *:3000 (LISTEN)" 형태가 들어있다.
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    const user = parts[2];
    // NAME 컬럼: "(LISTEN)" 바로 앞이 주소:포트
    const nameField = parts.slice(8).join(' ');
    const port = extractPort(nameField);
    if (!port) continue;

    if (!byPort.has(port)) {
      byPort.set(port, { port, pid, command, user, addresses: new Set() });
    }
    const entry = byPort.get(port);
    entry.addresses.add(nameField.replace(/\s*\(LISTEN\)\s*$/, ''));
  }

  return Array.from(byPort.values())
    .map((e) => ({
      port: e.port,
      pid: e.pid,
      command: e.command,
      user: e.user,
      addresses: Array.from(e.addresses),
    }))
    .sort((a, b) => a.port - b.port);
}

function extractPort(nameField) {
  // "*:3000", "127.0.0.1:3000", "[::1]:3000", "localhost:8080" 등
  const m = nameField.match(/:(\d+)\b(?!.*:\d)/);
  if (!m) return null;
  const p = parseInt(m[1], 10);
  return Number.isFinite(p) && p > 0 && p < 65536 ? p : null;
}

// 포트에 HTTP GET을 찔러 응답이 오면 web으로 판별한다.
function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 1200 },
      (res) => {
        const ct = res.headers['content-type'] || '';
        const isHtml = /html/i.test(ct);
        res.destroy();
        resolve({ port, web: true, html: isHtml, status: res.statusCode });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ port, web: false });
    });
    req.on('error', () => resolve({ port, web: false }));
  });
}

// 여러 포트를 동시에 프로브
async function probePorts(ports) {
  const results = await Promise.all(ports.map((p) => probeHttp(p)));
  const map = {};
  for (const r of results) map[r.port] = r;
  return map;
}

module.exports = { scanPorts, probeHttp, probePorts };
