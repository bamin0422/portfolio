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
// timeout은 "응답 없이 소켓이 조용한 시간"이라, TCP는 열려있지만 HTTP가 아닌 포트
// (DNS 53, DB 등)는 이 시간을 그대로 소모한다. 스캔 사이클을 지배하는 지점이므로
// 짧게 잡고, 대신 아래 캐시로 재프로브 자체를 없앤다.
// dev 서버는 첫 요청에서 SSR·컴파일을 하느라 수백 ms를 쓰는 일이 흔하므로 너무 짧으면
// 멀쩡한 웹 서버를 srv로 오판한다. 그렇다고 길게 잡으면 응답 없는 포트가 스캔 사이클을
// 잡아먹는다. 못 잡은 서버는 아래 재시도(retryDelay)가 곧 다시 확인하므로 중간값으로 둔다.
const PROBE_TIMEOUT = 1500;

function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout: PROBE_TIMEOUT,
        // 판별에 본문은 필요 없다. 커넥션을 재사용하지 않게 해 소켓이 TIME_WAIT로
        // 쌓이는 것도 줄인다.
        headers: { connection: 'close' },
      },
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

// 프로브 결과 캐시. 키는 port+pid — 같은 프로세스가 계속 리스닝 중이면 웹 여부는
// 변하지 않으므로 다시 찌르지 않는다.
//
// 캐시가 없으면 3초마다 전 포트에 GET / 이 날아가는데, 그 대가가 두 가지다.
//   1) 비HTTP 포트가 매번 타임아웃을 꽉 채워 스캔 사이클 전체를 지배한다.
//   2) 미리보기로 띄워둔 dev 서버가 3초마다 루트 요청을 받아 SSR/컴파일을 다시 돈다.
//      (미리보기 화면이 느려지는 직접 원인)
const probeCache = new Map(); // "port:pid" -> { result, at, misses }

const cacheKey = (port, pid) => `${port}:${pid}`;

// "웹이 맞다"는 결과는 프로세스가 살아있는 한 뒤집히지 않으니 그대로 믿는다.
// 하지만 "웹이 아니다"는 영구히 믿으면 안 된다 — 기동 중이라 아직 응답하지 못하는
// dev 서버가 그 순간 스캔되면 영원히 srv로 굳어버린다(실제로 그렇게 됐다).
// 그래서 실패는 다시 확인하되, 계속 실패하는 포트(DNS·DB 등)는 점점 뜸하게 본다.
function retryDelay(misses) {
  if (misses <= 1) return 10 * 1000;
  if (misses === 2) return 30 * 1000;
  return 5 * 60 * 1000;
}

// entries: [{ port, pid }] — force면 캐시를 무시하고 전부 다시 프로브한다(수동 새로고침).
async function probePorts(entries, { force = false } = {}) {
  const list = entries.map((e) =>
    typeof e === 'number' ? { port: e, pid: 0 } : { port: e.port, pid: e.pid }
  );

  // 이번 스캔에서 사라진 포트는 캐시에서 지운다 (장시간 구동 시 무한 증가 방지).
  const alive = new Set(list.map((e) => cacheKey(e.port, e.pid)));
  for (const key of probeCache.keys()) {
    if (!alive.has(key)) probeCache.delete(key);
  }

  const map = {};
  const todo = [];
  const now = Date.now();
  for (const e of list) {
    const entry = force ? null : probeCache.get(cacheKey(e.port, e.pid));
    let hit = null;
    if (entry) {
      if (entry.result.web) hit = entry.result;
      else if (now - entry.at < retryDelay(entry.misses)) hit = entry.result;
    }
    if (hit) map[e.port] = hit;
    else todo.push(e);
  }

  // 어떤 포트가 응답도 오류도 타임아웃도 주지 않고 매달리면 스캔 전체가 끝나지 않는다.
  // renderer는 스캔이 끝날 때까지 다음 주기를 건너뛰므로, 그 경우 자동 스캔이 영구히 멈춘다.
  // 소켓 타임아웃과 별개로 각 프로브에 확실한 상한을 둔다.
  const results = await Promise.all(
    todo.map((e) =>
      Promise.race([
        probeHttp(e.port),
        new Promise((resolve) =>
          setTimeout(() => resolve({ port: e.port, web: false }), PROBE_TIMEOUT + 400)
        ),
      ])
    )
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const key = cacheKey(todo[i].port, todo[i].pid);
    const prev = probeCache.get(key);
    probeCache.set(key, {
      result: r,
      at: Date.now(),
      misses: r.web ? 0 : (prev ? prev.misses : 0) + 1,
    });
    map[r.port] = r;
  }
  return map;
}

module.exports = { scanPorts, probeHttp, probePorts };
