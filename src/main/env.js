'use strict';

const { execSync } = require('node:child_process');

// GUI로 실행된 Electron 앱은 로그인 셸의 PATH를 물려받지 못한다.
// 로그인 셸을 한 번 띄워 실제 PATH를 읽어와 spawn 환경에 주입한다.
let cachedPath = null;

function loginShellPath() {
  if (cachedPath) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execSync(`${shell} -lic 'echo -n "$PATH"'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedPath = out || process.env.PATH || '';
  } catch {
    cachedPath = process.env.PATH || '';
  }
  return cachedPath;
}

// spawn에 넘길 환경(PATH 보강)
function spawnEnv(extra = {}) {
  return { ...process.env, PATH: loginShellPath(), ...extra };
}

// claude 실행 파일 절대경로 확보 (PATH 문제 대비)
let cachedClaude = null;
function resolveClaude() {
  if (cachedClaude) return cachedClaude;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execSync(`${shell} -lic 'command -v claude'`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedClaude = out || 'claude';
  } catch {
    cachedClaude = 'claude';
  }
  return cachedClaude;
}

module.exports = { loginShellPath, spawnEnv, resolveClaude };
