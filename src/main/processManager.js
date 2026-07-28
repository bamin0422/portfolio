'use strict';

const { spawn } = require('node:child_process');
const { spawnEnv } = require('./env');

// 앱이 직접 실행한 서버 프로세스를 관리한다.
// 이 경우에만 stdout/stderr 실시간 로그 캡처가 가능하다.
class ProcessManager {
  constructor() {
    this.procs = new Map(); // id -> { id, name, command, cwd, child, logs[], status }
    this.seq = 0;
    this.onLog = null; // (id, chunk) => void
    this.onStatus = null; // (id, status, code?) => void
  }

  start({ name, command, cwd }) {
    const id = `proc-${++this.seq}`;
    const child = spawn(command, {
      cwd: cwd || process.env.HOME,
      env: spawnEnv({ FORCE_COLOR: '0' }),
      shell: true, // 사용자가 "npm run dev" 같은 문자열을 그대로 넣을 수 있게
    });

    const rec = {
      id,
      name: name || command,
      command,
      cwd: cwd || process.env.HOME,
      child,
      pid: child.pid,
      logs: [],
      status: 'running',
    };
    this.procs.set(id, rec);

    const push = (chunk) => {
      const text = chunk.toString();
      rec.logs.push(text);
      if (rec.logs.length > 2000) rec.logs.shift();
      if (this.onLog) this.onLog(id, text);
    };

    child.stdout.on('data', push);
    child.stderr.on('data', push);

    child.on('error', (e) => {
      push(`\n[프로세스 오류] ${e.message}\n`);
      rec.status = 'error';
      if (this.onStatus) this.onStatus(id, 'error');
    });

    child.on('exit', (code, signal) => {
      rec.status = 'exited';
      rec.exitCode = code;
      push(`\n[종료] code=${code} signal=${signal || '-'}\n`);
      if (this.onStatus) this.onStatus(id, 'exited', code);
    });

    return this.summary(rec);
  }

  stop(id, force = false) {
    const rec = this.procs.get(id);
    if (!rec || !rec.child) return false;
    try {
      rec.child.kill(force ? 'SIGKILL' : 'SIGTERM');
      if (!force) {
        setTimeout(() => {
          if (rec.status === 'running') {
            try {
              rec.child.kill('SIGKILL');
            } catch {}
          }
        }, 3000);
      }
      return true;
    } catch {
      return false;
    }
  }

  remove(id) {
    const rec = this.procs.get(id);
    if (rec && rec.status === 'running') this.stop(id, true);
    this.procs.delete(id);
  }

  getLogs(id) {
    const rec = this.procs.get(id);
    return rec ? rec.logs.join('') : '';
  }

  list() {
    return Array.from(this.procs.values()).map((r) => this.summary(r));
  }

  summary(rec) {
    return {
      id: rec.id,
      name: rec.name,
      command: rec.command,
      cwd: rec.cwd,
      pid: rec.pid,
      status: rec.status,
      exitCode: rec.exitCode,
    };
  }

  killAll() {
    for (const id of this.procs.keys()) this.stop(id, true);
  }
}

module.exports = new ProcessManager();
