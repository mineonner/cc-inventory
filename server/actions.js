import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudePaths, readJson, writeJsonAtomic, exists, listDir } from './paths.js';
import { parseFrontmatter } from './frontmatter.js';
import { run } from './cli.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GIT_URL_RE = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~@%+-]+|git@[\w.-]+:[\w./~-]+)$/;

export function createActions({ env = process.env, cli = run } = {}) {
  const p = claudePaths(env);
  const storeFile = path.join(p.dataDir, 'disabled.json');
  const store = () => readJson(storeFile, {}) || {};
  const saveStore = (s) => writeJsonAtomic(storeFile, s);
  const claude = (args, opts = {}) => cli('claude', args, { cwd: opts.cwd || os.homedir(), ...opts });
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

  function backup(target) {
    if (!exists(target)) return null;
    const dest = path.join(p.dataDir, 'backups', stamp(), path.resolve(target).replace(/^([A-Za-z]):/, '$1').replace(/^[\\/]+/, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // dereference: a symlinked skill must be backed up as its content, not as a dangling link.
    fs.cpSync(target, dest, { recursive: true, dereference: true });
    return dest;
  }

  // Move <root>/<sub>/<rel> <-> <root>/<sub>-disabled/<rel>.
  function swapDir(file, from, to) {
    const parts = path.resolve(file).split(path.sep);
    const i = parts.lastIndexOf(from);
    if (i < 0) throw new Error(`ไม่พบโฟลเดอร์ ${from} ใน path`);
    parts[i] = to;
    const dest = parts.join(path.sep);
    if (exists(dest)) throw new Error(`มีไฟล์ชื่อเดียวกันอยู่แล้วที่ ${dest}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(file, dest);
    return dest;
  }

  const SUB = { skill: 'skills', agent: 'agents', command: 'commands', outputstyle: 'output-styles' };

  function guard(ext, action) {
    if (ext.readOnly) throw new Error(ext.readOnlyReason || 'แก้ไขรายการนี้ไม่ได้');
    if (ext.facts?.brokenLink !== undefined && action !== 'delete') throw new Error('ลิงก์เสีย — ทำได้อย่างเดียวคือลบลิงก์');
  }

  // ---------- disable / enable ----------

  async function disable(ext, { projectDir } = {}) {
    guard(ext, 'disable');
    if (ext.status !== 'active') throw new Error('รายการนี้ไม่ได้เปิดอยู่');
    switch (ext.kind) {
      case 'plugin': return pluginCmd('disable', ext, projectDir);
      case 'skill': swapDir(ext.dir, 'skills', 'skills-disabled'); return 'ย้ายไป skills-disabled แล้ว';
      case 'agent': case 'command': case 'outputstyle': swapDir(ext.path, SUB[ext.kind], `${SUB[ext.kind]}-disabled`); return `ย้ายไป ${SUB[ext.kind]}-disabled แล้ว`;
      case 'hook': return moveHook(ext, 'out');
      case 'statusline': return moveStatusLine(ext, 'out');
      case 'mcp': return disableMcp(ext, projectDir);
      default: throw new Error(`ปิด ${ext.kind} ไม่ได้`);
    }
  }

  async function enable(ext, { projectDir } = {}) {
    guard(ext, 'enable');
    if (ext.status !== 'disabled') throw new Error('รายการนี้ไม่ได้ถูกปิด');
    switch (ext.kind) {
      case 'plugin': return pluginCmd('enable', ext, projectDir);
      case 'skill': swapDir(ext.dir, 'skills-disabled', 'skills'); return 'เปิดใช้แล้ว';
      case 'agent': case 'command': case 'outputstyle': swapDir(ext.path, `${SUB[ext.kind]}-disabled`, SUB[ext.kind]); return 'เปิดใช้แล้ว';
      case 'hook': return moveHook(ext, 'in');
      case 'statusline': return moveStatusLine(ext, 'in');
      case 'mcp': return enableMcp(ext, projectDir);
      default: throw new Error(`เปิด ${ext.kind} ไม่ได้`);
    }
  }

  async function remove(ext, { projectDir } = {}) {
    guard(ext, 'delete');
    switch (ext.kind) {
      case 'plugin': return pluginCmd('uninstall', ext, projectDir);
      case 'skill': {
        if (ext.facts.brokenLink !== undefined) { fs.unlinkSync(ext.dir); return `ลบลิงก์เสียแล้ว (เคยชี้ไปที่ ${ext.facts.brokenLink})`; }
        const b = backup(ext.dir);
        if (fs.lstatSync(ext.dir).isSymbolicLink()) {
          const real = fs.realpathSync(ext.dir);
          fs.unlinkSync(ext.dir);
          return `ลบลิงก์แล้ว — ไฟล์จริงที่ ${real} ยังอยู่ (สำรองไว้ที่ ${b})`;
        }
        fs.rmSync(ext.dir, { recursive: true, force: true });
        return `ลบแล้ว (สำรองไว้ที่ ${b})`;
      }
      case 'agent': case 'command': case 'outputstyle': { const b = backup(ext.path); fs.rmSync(ext.path, { force: true }); return `ลบแล้ว (สำรองไว้ที่ ${b})`; }
      case 'hook':
        if (ext.facts.stored) { dropStored('hooks', ext); return 'ลบแล้ว'; }
        await moveHook(ext, 'out');
        dropStored('hooks', ext, true);
        return 'ลบแล้ว (settings เดิมสำรองไว้ใน backups)';
      case 'statusline':
        if (ext.facts.stored) { dropStored('statusLine', ext); return 'ลบแล้ว'; }
        await moveStatusLine(ext, 'out');
        dropStored('statusLine', ext, true);
        return 'ลบแล้ว (settings เดิมสำรองไว้ใน backups)';
      case 'mcp':
        if (ext.facts.stored) { dropStored('mcp', ext); return 'ลบแล้ว'; }
        backup(ext.path);
        await claude(['mcp', 'remove', ext.name, '-s', ext.scope], { cwd: projectDir || undefined });
        return 'ลบแล้ว (config เดิมสำรองไว้ใน backups)';
      default: throw new Error(`ลบ ${ext.kind} ไม่ได้`);
    }
  }

  async function pluginCmd(verb, ext, projectDir) {
    const args = ['plugin', verb, ext.name];
    if (ext.scope && ext.scope !== 'builtin') args.push('--scope', ext.scope);
    const r = await claude(args, { cwd: projectDir || undefined });
    return r.stdout.trim() || `${verb} แล้ว`;
  }

  // ---------- hooks / status line (settings.json edits) ----------

  function moveHook(ext, dir) {
    const s = store();
    s.hooks ||= [];
    if (dir === 'out') {
      const file = ext.path;
      const data = readJson(file, null);
      if (!data?.hooks) throw new Error('ไม่พบ hooks ใน settings');
      const { event, matcher, hook } = ext.facts.raw;
      const groups = data.hooks[event] || [];
      let removed = false;
      for (const g of groups) {
        if ((g.matcher || '') !== (matcher || '')) continue;
        const i = (g.hooks || []).findIndex((h) => JSON.stringify(h) === JSON.stringify(hook));
        if (i >= 0) { g.hooks.splice(i, 1); removed = true; break; }
      }
      if (!removed) throw new Error('หา hook นี้ใน settings ไม่เจอ (อาจถูกแก้ไปแล้ว) — กดรีเฟรช');
      data.hooks[event] = groups.filter((g) => (g.hooks || []).length);
      if (!data.hooks[event].length) delete data.hooks[event];
      if (!Object.keys(data.hooks).length) delete data.hooks;
      backup(file);
      writeJsonAtomic(file, data);
      s.hooks.push({ scope: ext.scope, file, event, matcher: matcher || '', hook, storedAt: Date.now() });
      saveStore(s);
      return 'ปิดแล้ว — เก็บ hook ไว้ใน cc-inventory/disabled.json';
    }
    const idx = s.hooks.findIndex((h) => ext.id.endsWith(`:d${h.storedAt}`));
    if (idx < 0) throw new Error('ไม่พบ hook ที่เก็บไว้');
    const h = s.hooks[idx];
    const data = readJson(h.file, {}) || {};
    data.hooks ||= {};
    data.hooks[h.event] ||= [];
    let g = data.hooks[h.event].find((x) => (x.matcher || '') === h.matcher);
    if (!g) { g = h.matcher ? { matcher: h.matcher, hooks: [] } : { hooks: [] }; data.hooks[h.event].push(g); }
    g.hooks.push(h.hook);
    backup(h.file);
    writeJsonAtomic(h.file, data);
    s.hooks.splice(idx, 1);
    saveStore(s);
    return 'เปิดใช้แล้ว';
  }

  function moveStatusLine(ext, dir) {
    const s = store();
    s.statusLine ||= [];
    if (dir === 'out') {
      const data = readJson(ext.path, {}) || {};
      if (!data.statusLine) throw new Error('ไม่พบ statusLine ใน settings');
      s.statusLine.push({ scope: ext.scope, file: ext.path, value: data.statusLine, storedAt: Date.now() });
      delete data.statusLine;
      backup(ext.path);
      writeJsonAtomic(ext.path, data);
      saveStore(s);
      return 'ปิดแล้ว';
    }
    const idx = s.statusLine.findIndex((x) => ext.id.endsWith(`:d${x.storedAt}`));
    if (idx < 0) throw new Error('ไม่พบ status line ที่เก็บไว้');
    const it = s.statusLine[idx];
    const data = readJson(it.file, {}) || {};
    if (data.statusLine) throw new Error('มี status line อื่นเปิดอยู่ — ปิดตัวนั้นก่อน');
    data.statusLine = it.value;
    backup(it.file);
    writeJsonAtomic(it.file, data);
    s.statusLine.splice(idx, 1);
    saveStore(s);
    return 'เปิดใช้แล้ว';
  }

  function dropStored(key, ext, latest = false) {
    const s = store();
    const list = s[key] || [];
    const idx = latest ? list.length - 1 : list.findIndex((x) => ext.id.endsWith(`:d${x.storedAt}`));
    if (idx >= 0) list.splice(idx, 1);
    saveStore(s);
  }

  // ---------- MCP ----------

  async function disableMcp(ext, projectDir) {
    if (ext.scope === 'project') {
      const file = path.join(projectDir, '.claude', 'settings.local.json');
      const data = readJson(file, {}) || {};
      data.disabledMcpjsonServers = [...new Set([...(data.disabledMcpjsonServers || []), ext.name])];
      data.enabledMcpjsonServers = (data.enabledMcpjsonServers || []).filter((n) => n !== ext.name);
      backup(file);
      writeJsonAtomic(file, data);
      return 'ปิดแล้ว (บันทึกใน .claude/settings.local.json ของโปรเจกต์)';
    }
    // user/local servers have no native off switch: keep the config, remove, re-add on enable.
    const cj = readJson(p.claudeJson, {}) || {};
    const config = ext.scope === 'local' ? cj.projects?.[projectDir]?.mcpServers?.[ext.name] : cj.mcpServers?.[ext.name];
    if (!config) throw new Error('หา config ของ MCP นี้ไม่เจอ');
    const s = store();
    s.mcp ||= [];
    s.mcp.push({ name: ext.name, scope: ext.scope, projectDir: ext.scope === 'local' ? projectDir : null, config, storedAt: Date.now() });
    saveStore(s);
    await claude(['mcp', 'remove', ext.name, '-s', ext.scope], { cwd: projectDir || undefined });
    const oauth = config.type === 'http' || config.type === 'sse' || config.url;
    return `ปิดแล้ว${oauth ? ' — ถ้า server นี้ login ด้วย OAuth อาจต้อง login ใหม่ตอนเปิดกลับ' : ''}`;
  }

  async function enableMcp(ext, projectDir) {
    if (ext.scope === 'project') {
      const file = path.join(projectDir, '.claude', 'settings.local.json');
      const data = readJson(file, {}) || {};
      data.disabledMcpjsonServers = (data.disabledMcpjsonServers || []).filter((n) => n !== ext.name);
      data.enabledMcpjsonServers = [...new Set([...(data.enabledMcpjsonServers || []), ext.name])];
      backup(file);
      writeJsonAtomic(file, data);
      return 'เปิดใช้แล้ว';
    }
    const s = store();
    const idx = (s.mcp || []).findIndex((m) => ext.id.endsWith(`:d${m.storedAt}`));
    if (idx < 0) throw new Error('ไม่พบ config ที่เก็บไว้');
    const m = s.mcp[idx];
    await claude(['mcp', 'add-json', m.name, JSON.stringify(m.config), '-s', m.scope], { cwd: m.projectDir || projectDir || undefined });
    s.mcp.splice(idx, 1);
    saveStore(s);
    return 'เปิดใช้แล้ว';
  }

  // ---------- install ----------

  async function installMcp({ name, type = 'stdio', command = '', url = '', env: envPairs = [], headers = [], scope = 'user' }, { projectDir } = {}) {
    if (!NAME_RE.test(name || '')) throw new Error('ชื่อใช้ได้เฉพาะ a-z A-Z 0-9 _ . - และยาวไม่เกิน 64 ตัว');
    if (!['user', 'project', 'local'].includes(scope)) throw new Error('scope ไม่ถูกต้อง');
    if (scope !== 'user' && !projectDir) throw new Error('เลือกโปรเจกต์ก่อนติดตั้งแบบ project/local');
    const args = ['mcp', 'add', '-s', scope];
    if (type === 'stdio') {
      const parts = splitCommand(command);
      if (!parts.length) throw new Error('ใส่คำสั่งที่ใช้รัน MCP server');
      for (const { key, value } of envPairs) {
        if (!key) continue;
        if (!ENV_KEY_RE.test(key)) throw new Error(`ชื่อ env "${key}" ไม่ถูกต้อง`);
        args.push('-e', `${key}=${value ?? ''}`);
      }
      args.push(name, '--', ...parts);
    } else {
      if (!['http', 'sse'].includes(type)) throw new Error('ประเภทไม่ถูกต้อง');
      let u;
      try { u = new URL(url); } catch { throw new Error('URL ไม่ถูกต้อง'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('URL ต้องเป็น http หรือ https');
      args.push('--transport', type);
      for (const { key, value } of headers) if (key) args.push('--header', `${key}: ${value ?? ''}`);
      args.push(name, u.toString());
    }
    await claude(args, { cwd: projectDir || undefined });
    const check = await claude(['mcp', 'get', name], { cwd: projectDir || undefined }).catch((e) => ({ stdout: e.message }));
    return check.stdout.trim();
  }

  function mcpPreview(form) {
    const masked = { ...form, env: (form.env || []).map((e) => ({ key: e.key, value: e.value ? '••••' : '' })), headers: (form.headers || []).map((h) => ({ key: h.key, value: h.value ? '••••' : '' })) };
    const args = [];
    if (masked.type === 'stdio') {
      for (const e of masked.env) if (e.key) args.push('-e', `${e.key}=${e.value}`);
      return `claude mcp add -s ${masked.scope} ${args.join(' ')} ${masked.name || '<ชื่อ>'} -- ${masked.command || '<คำสั่ง>'}`.replace(/\s+/g, ' ');
    }
    for (const h of masked.headers) if (h.key) args.push('--header', `"${h.key}: ${h.value}"`);
    return `claude mcp add -s ${masked.scope} --transport ${masked.type} ${args.join(' ')} ${masked.name || '<ชื่อ>'} ${masked.url || '<url>'}`.replace(/\s+/g, ' ');
  }

  async function installPlugin({ id, scope = 'user' }, { projectDir } = {}) {
    if (!/^[\w.-]+(@[\w.-]+)?$/.test(id || '')) throw new Error('ชื่อ plugin ไม่ถูกต้อง');
    const r = await claude(['plugin', 'install', id, '--scope', scope], { cwd: projectDir || undefined, timeoutMs: 300000 });
    return r.stdout.trim() || 'ติดตั้งแล้ว';
  }

  async function addMarketplace({ source }) {
    if (!/^([\w.-]+\/[\w.-]+|https:\/\/\S+|git@\S+)$/.test(source || '')) throw new Error('ใส่ owner/repo หรือ git URL');
    const r = await claude(['plugin', 'marketplace', 'add', source], { timeoutMs: 300000 });
    return r.stdout.trim() || 'เพิ่ม marketplace แล้ว';
  }

  let catalogCache = null;
  async function pluginCatalog() {
    if (catalogCache && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.data;
    const r = await claude(['plugin', 'list', '--json', '--available'], { timeoutMs: 120000 });
    const data = JSON.parse(r.stdout);
    catalogCache = { at: Date.now(), data };
    return data;
  }

  // Skill install is two-step: preview clones/reads the source and lists skills; install copies chosen ones.
  const previews = new Map();
  async function skillPreview({ source }) {
    let root, cleanup = null;
    if (GIT_URL_RE.test(source || '')) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-inventory-'));
      cleanup = root;
      await cli('git', ['clone', '--depth', '1', '--', source, root], { timeoutMs: 180000 });
    } else if (source && path.isAbsolute(source) && exists(source)) {
      root = source;
    } else {
      throw new Error('ใส่ git URL (https:// หรือ git@) หรือ path แบบเต็มของโฟลเดอร์ในเครื่อง');
    }
    const found = [];
    findSkills(root, 0, found);
    if (!found.length) throw new Error('ไม่พบ SKILL.md ในแหล่งนี้');
    const token = Math.random().toString(36).slice(2);
    previews.set(token, { root, cleanup, skills: found, at: Date.now() });
    return { token, skills: found.map((s) => ({ name: s.name, description: s.description, rel: path.relative(root, s.dir) })) };
  }

  function findSkills(dir, depth, out) {
    if (depth > 4) return;
    for (const d of listDir(dir)) {
      if (!d.isDirectory() || d.name === '.git' || d.name === 'node_modules') continue;
      const sub = path.join(dir, d.name);
      const file = path.join(sub, 'SKILL.md');
      if (exists(file)) {
        const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        out.push({ name: String(data.name || d.name), description: String(data.description || ''), dir: sub });
      } else findSkills(sub, depth + 1, out);
    }
  }

  async function skillInstall({ token, names = [], scope = 'user' }, { projectDir } = {}) {
    const pv = previews.get(token);
    if (!pv) throw new Error('หมดเวลา — กดดูรายการ skill ใหม่อีกครั้ง');
    const targetRoot = scope === 'project' ? (projectDir && path.join(projectDir, '.claude', 'skills')) : path.join(p.configDir, 'skills');
    if (!targetRoot) throw new Error('เลือกโปรเจกต์ก่อนติดตั้งแบบ project');
    const done = [];
    for (const s of pv.skills.filter((x) => names.includes(x.name))) {
      if (!NAME_RE.test(s.name)) throw new Error(`ชื่อ skill "${s.name}" ไม่ปลอดภัย`);
      const dest = path.join(targetRoot, s.name);
      if (exists(dest)) throw new Error(`มี skill ชื่อ ${s.name} อยู่แล้ว — ลบหรือปิดตัวเดิมก่อน`);
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.cpSync(s.dir, dest, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
      done.push(s.name);
    }
    if (pv.cleanup) fs.rmSync(pv.cleanup, { recursive: true, force: true });
    previews.delete(token);
    return `ติดตั้ง ${done.length} skill: ${done.join(', ')}`;
  }

  return { disable, enable, remove, installMcp, mcpPreview, installPlugin, addMarketplace, pluginCatalog, skillPreview, skillInstall };
}

// ponytail: shell-like split on spaces with "double" / 'single' quotes; no escapes or $vars,
// which MCP launch commands don't need.
export function splitCommand(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
