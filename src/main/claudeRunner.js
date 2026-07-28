'use strict';

const { spawn } = require('node:child_process');
const { spawnEnv, resolveClaude } = require('./env');

// claude CLI를 headless(-p)로 실행하고 stream-json 출력을 파싱해 이벤트로 흘려보낸다.
class ClaudeRunner {
  constructor() {
    this.runs = new Map(); // runId -> child
    this.seq = 0;
    this.onEvent = null; // (runId, event) => void
  }

  run({ prompt, cwd, skipPermissions, control }) {
    const runId = `claude-${++this.seq}`;
    const bin = resolveClaude();
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    // 내부 화면 제어: 앱 자체 webview 제어 MCP(브릿지)를 붙인다.
    let extraEnv = {};
    if (control) {
      const mcpConfig = JSON.stringify({
        mcpServers: {
          'portfolio-webview': {
            command: process.execPath, // Electron 바이너리를 node로 사용
            args: [control.bridgePath],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              PF_CTRL_URL: control.url,
              PF_TOKEN: control.token,
            },
          },
        },
      });
      args.push('--mcp-config', mcpConfig);
      // MCP 도구는 headless에서 승인창을 못 띄우므로 권한 우회가 필수.
      skipPermissions = true;
    }

    // headless(-p)에서는 권한 프롬프트를 띄울 수 없어 도구 사용이 막힌다.
    // 토글이 켜져 있으면 모든 권한 체크를 우회한다.
    if (skipPermissions) args.push('--dangerously-skip-permissions');

    const child = spawn(bin, args, {
      cwd: cwd || process.env.HOME,
      env: spawnEnv(extraEnv),
      // stdin을 닫아 claude가 stdin 입력을 3초간 대기(경고)하지 않게 한다.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.runs.set(runId, child);

    const emit = (event) => {
      if (this.onEvent) this.onEvent(runId, event);
    };

    emit({ type: 'start', runId, prompt, cwd });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        this.handleLine(line, emit);
      }
    });

    child.stderr.on('data', (chunk) => {
      emit({ type: 'stderr', text: chunk.toString() });
    });

    child.on('error', (e) => {
      emit({ type: 'error', text: e.message });
    });

    child.on('exit', (code) => {
      // 남은 버퍼 처리
      const rest = buffer.trim();
      if (rest) this.handleLine(rest, emit);
      emit({ type: 'end', code });
      this.runs.delete(runId);
    });

    return { runId };
  }

  handleLine(line, emit) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      emit({ type: 'text', text: line });
      return;
    }

    if (obj.type === 'assistant' && obj.message && obj.message.content) {
      const texts = obj.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
      const tools = obj.message.content
        .filter((c) => c.type === 'tool_use')
        .map((c) => `🔧 ${c.name}`)
        .join(' ');
      if (texts) emit({ type: 'text', text: texts });
      if (tools) emit({ type: 'tool', text: tools });
    } else if (obj.type === 'result') {
      emit({
        type: 'result',
        text: obj.result || '',
        isError: !!obj.is_error,
        durationMs: obj.duration_ms,
        cost: obj.total_cost_usd,
      });
    } else if (obj.type === 'system' && obj.subtype === 'init') {
      emit({ type: 'system', text: `session ${obj.session_id || ''}` });
    }
  }

  cancel(runId) {
    const child = this.runs.get(runId);
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {}
      this.runs.delete(runId);
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const child of this.runs.values()) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
    this.runs.clear();
  }
}

module.exports = new ClaudeRunner();
