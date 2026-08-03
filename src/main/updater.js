'use strict';

// 새 버전 확인기.
//
// electron-updater를 쓰지 않는다. macOS 자동 설치(Squirrel.Mac)는 Developer ID 서명을
// 검증하는데 이 앱은 ad-hoc 서명이라 어차피 적용되지 않고, 런타임 의존성 0이라는 이 앱의
// 전제도 깨진다. 그래서 GitHub Releases API만 직접 조회해 "새 버전이 있다"는 사실을 알리고
// 다운로드는 사용자가 누르게 한다. node:https 외에는 아무것도 필요하지 않다.

const https = require('node:https');
const { app } = require('electron');

const REPO = 'bamin0422/portfolio';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6시간마다
const FIRST_CHECK_DELAY = 8 * 1000; // 시작 직후는 피한다 (기동 부하와 겹치지 않게)

let timer = null;
let lastResult = null; // { available, version, url, notes } | null
let onUpdate = null; // (result) => void

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // GitHub API는 User-Agent가 없으면 403을 준다.
          'user-agent': `Portfolio/${app.getVersion()}`,
          accept: 'application/vnd.github+json',
        },
        timeout: 10000,
      },
      (res) => {
        // 릴리스가 하나도 없으면 404다 — 오류로 시끄럽게 굴 이유는 없다.
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('응답 파싱 실패'));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('시간 초과'));
    });
    req.on('error', reject);
  });
}

// "0.1.10" > "0.1.9" 가 되도록 숫자 단위로 비교한다 (문자열 비교면 뒤집힌다).
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '0')
      .replace(/^v/i, '')
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// 지금 돌고 있는 플랫폼에 맞는 설치 파일을 고른다. 없으면 릴리스 페이지로 보낸다.
function pickAsset(assets) {
  const list = assets || [];
  if (process.platform === 'darwin') {
    const arm = process.arch === 'arm64';
    return (
      list.find((a) =>
        arm ? /arm64\.dmg$/i.test(a.name) : /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name)
      ) || list.find((a) => /\.dmg$/i.test(a.name))
    );
  }
  if (process.platform === 'win32') {
    return list.find((a) => /\.exe$/i.test(a.name));
  }
  return list.find((a) => /\.AppImage$/i.test(a.name));
}

async function check({ silent = true } = {}) {
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    const available = latest && compareVersions(latest, current) > 0;

    const asset = available ? pickAsset(rel.assets) : null;
    lastResult = {
      available: !!available,
      version: latest,
      current,
      // 플랫폼용 파일이 아직 안 올라온 릴리스도 있다 (예: Windows 빌드가 늦게 붙는 경우).
      url: asset ? asset.browser_download_url : rel.html_url,
      hasAsset: !!asset,
      notes: (rel.body || '').slice(0, 400),
      checkedAt: Date.now(),
    };
    if (available && onUpdate) onUpdate(lastResult);
    return lastResult;
  } catch (e) {
    // 네트워크가 없거나 API가 막힌 경우는 조용히 넘어간다 — 수동 확인일 때만 사유를 돌려준다.
    const failed = { available: false, error: e.message, current: app.getVersion() };
    if (!silent) return failed;
    return failed;
  }
}

function start() {
  if (timer) return;
  setTimeout(() => check({ silent: true }), FIRST_CHECK_DELAY);
  timer = setInterval(() => check({ silent: true }), CHECK_INTERVAL);
  // 앱이 이 타이머 때문에 종료를 못 하는 일이 없게 한다.
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  check,
  getLast: () => lastResult,
  set onUpdate(fn) {
    onUpdate = fn;
  },
  compareVersions, // 테스트용
};
