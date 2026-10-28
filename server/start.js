import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudePaths, readJson } from './paths.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.log(`cc-inventory ต้องใช้ Node 20 ขึ้นไป (เครื่องนี้มี ${process.versions.node}) — ติดตั้งจาก https://nodejs.org แล้วลองใหม่`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const noOpen = process.argv.includes('--no-open') || process.env.CC_INVENTORY_NO_OPEN === '1';
// process.cwd() rather than $PWD: Git Bash on Windows hands out /c/... paths Node can't use.
const cwd = process.cwd();
const project = path.resolve(cwd) === path.resolve(os.homedir()) ? null : cwd;
const lock = path.join(claudePaths().dataDir, 'server.json');

let info = await reusable();
if (!info) {
  fs.rmSync(lock, { force: true });
  const args = [path.join(HERE, 'server.js')];
  if (project) args.push('--project', project);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 50 && !info; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const l = readJson(lock, null);
    if (l?.pid === child.pid) info = l;
  }
  if (!info) { console.log('เปิด server ไม่สำเร็จ — ลองรัน node server/server.js เพื่อดู error'); process.exit(1); }
}

const url = `http://127.0.0.1:${info.port}/?t=${info.token}${project ? `&project=${encodeURIComponent(project)}` : ''}`;
if (!noOpen) openBrowser(url);
console.log(`cc-inventory เปิดแล้ว: ${url}`);

async function reusable() {
  const l = readJson(lock, null);
  if (!l?.port || !l?.token) return null;
  try { process.kill(l.pid, 0); } catch { return null; }
  const ok = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: l.port, path: '/api/heartbeat', method: 'POST', headers: { 'x-token': l.token, 'content-type': 'application/json' }, timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end('{}');
  });
  return ok ? l : null;
}

function openBrowser(u) {
  // rundll32 takes the URL as one argument, so "&" in the query never meets cmd.exe.
  const [cmd, args] = process.platform === 'darwin' ? ['open', [u]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', u]]
    : ['xdg-open', [u]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* print URL instead */ }
}
