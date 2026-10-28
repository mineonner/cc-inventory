import { spawn } from 'node:child_process';

// Runs a CLI without a shell so user-supplied text (MCP names, URLs, JSON) is never parsed by one.
// On Windows the native installer ships claude.exe, which libuv finds on PATH without a shell.
// npm installs ship claude.cmd, which Node can only start through cmd.exe; there we fall back to a
// shell but refuse arguments containing cmd metacharacters rather than trying to escape them.
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

export function run(cmd, args, { cwd, input, timeoutMs = 120000 } = {}) {
  return attempt(cmd, args, { cwd, input, timeoutMs, shell: false }).catch((err) => {
    if (process.platform !== 'win32' || err.code !== 'ENOENT') throw err;
    const bad = args.find((a) => CMD_UNSAFE.test(a));
    if (bad !== undefined) throw new Error(`ค่าที่มีอักขระพิเศษส่งผ่าน ${cmd}.cmd ไม่ได้ — ติดตั้ง Claude Code แบบ native (claude.exe) แล้วลองใหม่`);
    return attempt(cmd, args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)), { cwd, input, timeoutMs, shell: true });
  });
}

function attempt(cmd, args, { cwd, input, timeoutMs, shell }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error(`${cmd} หมดเวลา`), { code: 'ETIMEDOUT' })); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(Object.assign(new Error((err || out).trim() || `${cmd} exit ${code}`), { code: 'EXIT', exitCode: code }));
      resolve({ stdout: out, stderr: err });
    });
    child.stdin.end(input ?? '');
  });
}
