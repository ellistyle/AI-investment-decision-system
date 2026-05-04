// 封装 Python akshare 脚本调用，返回 JSON
const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');

const SCRIPT = path.join(__dirname, 'fetch_data.py');

function runPython(cmd, args = {}, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const argv = [SCRIPT, cmd];
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || v === '') continue;
      argv.push(`--${k}`, String(v));
    }
    let stdout = '';
    let stderr = '';
    const proc = spawn(config.python.bin, argv);
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        resolve({ ok: false, error: stderr || `python exit ${code}`, code: 'PY_EXIT' });
        return;
      }
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop();
        const parsed = JSON.parse(last);
        resolve(parsed);
      } catch (e) {
        resolve({ ok: false, error: `parse failed: ${e.message}; stdout=${stdout.slice(-500)}` });
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, code: 'PY_SPAWN' });
    });
  });
}

module.exports = { runPython };
