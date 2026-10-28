import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudePaths, readJson, readText, listDir, exists } from './paths.js';
import { parseFrontmatter, toList } from './frontmatter.js';

const BUILTINS = readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), 'builtins.json'), { skills: [], agents: [] });

// Hook events that fire without any tool call, i.e. on every session / every message.
const ALWAYS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PreCompact', 'Notification', 'SubagentStop']);
const RISKY_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export function scan({ projectDir = null, env = process.env } = {}) {
  const p = claudePaths(env);
  const cj = readJson(p.claudeJson, {}) || {};
  const disabledStore = readJson(path.join(p.dataDir, 'disabled.json'), {}) || {};
  const ctx = { p, cj, projectDir, disabledStore, out: [], notes: [] };

  const userSettingsFile = path.join(p.configDir, 'settings.json');
  const settingsFiles = [{ file: userSettingsFile, scope: 'user' }];
  if (projectDir) {
    settingsFiles.push({ file: path.join(projectDir, '.claude', 'settings.json'), scope: 'project' });
    settingsFiles.push({ file: path.join(projectDir, '.claude', 'settings.local.json'), scope: 'local' });
  }
  ctx.settings = settingsFiles.map((s) => ({ ...s, data: readJson(s.file, null) })).filter((s) => s.data);

  scanPlugins(ctx);
  const roots = [{ dir: p.configDir, scope: 'user' }];
  if (projectDir) roots.push({ dir: path.join(projectDir, '.claude'), scope: 'project' });
  for (const r of roots) {
    scanSkillDirs(ctx, r.dir, r.scope);
    scanMdDir(ctx, 'agent', r.dir, 'agents', r.scope);
    scanMdDir(ctx, 'command', r.dir, 'commands', r.scope);
    scanMdDir(ctx, 'outputstyle', r.dir, 'output-styles', r.scope);
  }
  scanSynced(ctx);
  scanHooks(ctx);
  scanMcp(ctx);
  scanStatusLine(ctx);
  scanBuiltins(ctx);
  attachUsage(ctx);

  return {
    extensions: ctx.out,
    meta: {
      configDir: p.configDir,
      projectDir,
      projects: Object.keys(cj.projects || {}).filter((d) => exists(d)).sort(),
      notes: ctx.notes,
      builtinsCheckedWith: BUILTINS.checkedWithClaudeCode,
    },
  };
}

function add(ctx, ext) {
  ext.facts ||= {};
  ext.warnings ||= [];
  ext.status ||= 'active';
  ctx.out.push(ext);
  return ext;
}

// ---------- plugins ----------

function enabledPluginMap(ctx) {
  const map = {};
  for (const s of ctx.settings) Object.assign(map, s.data.enabledPlugins || {});
  return map;
}

function scanPlugins(ctx) {
  const installed = readJson(path.join(ctx.p.configDir, 'plugins', 'installed_plugins.json'), {}) || {};
  const entries = installed.version === 2 || installed.plugins ? installed.plugins || {} : installed;
  if (installed.version && installed.version !== 2) ctx.notes.push(`installed_plugins.json version ${installed.version} — อ่านแบบเดาโครงสร้าง อาจไม่ครบ`);
  const enabled = enabledPluginMap(ctx);

  for (const [id, installs] of Object.entries(entries)) {
    const list = Array.isArray(installs) ? installs : [installs];
    // A plugin can be installed at several scopes; the user-scope copy (or first) represents it.
    const inst = list.find((i) => i.scope === 'user') || list[0];
    if (!inst) continue;
    const manifest = readJson(path.join(inst.installPath || '', '.claude-plugin', 'plugin.json'), {}) || {};
    const isOn = enabled[id] === true;
    const plugin = add(ctx, {
      id: `plugin:${id}`,
      kind: 'plugin',
      name: id,
      scope: inst.scope || 'user',
      status: isOn ? 'active' : 'disabled',
      description: manifest.description || '',
      path: inst.installPath,
      facts: { version: inst.version || manifest.version, author: manifest.author?.name, homepage: manifest.homepage || manifest.repository, installedAt: inst.installedAt },
    });
    const components = scanPluginComponents(ctx, plugin, inst.installPath, manifest, isOn);
    plugin.facts.components = components;
  }

  for (const id of Object.keys(enabled)) {
    if (!id.endsWith('@builtin') || entries[id]) continue;
    add(ctx, {
      id: `plugin:${id}`, kind: 'plugin', name: id, scope: 'builtin',
      status: enabled[id] ? 'active' : 'disabled',
      description: 'Plugin ที่มากับ Claude Code (builtin) — ไฟล์อยู่ในตัวโปรแกรม จึงดูส่วนประกอบไม่ได้',
      facts: { components: {} },
    });
  }
}

function scanPluginComponents(ctx, plugin, root, manifest, isOn) {
  if (!root) return {};
  const short = plugin.name.split('@')[0];
  const before = ctx.out.length;
  const common = { scope: 'plugin', pluginId: plugin.id, status: isOn ? 'active' : 'disabled' };
  scanSkillDirs(ctx, root, 'plugin', { prefix: short, common });
  scanMdDir(ctx, 'agent', root, 'agents', 'plugin', { prefix: short, common });
  scanMdDir(ctx, 'command', root, 'commands', 'plugin', { prefix: short, common });
  scanMdDir(ctx, 'outputstyle', root, 'output-styles', 'plugin', { prefix: short, common });

  let hooks = manifest.hooks;
  if (typeof hooks === 'string') hooks = readJson(path.join(root, hooks), {})?.hooks;
  else if (hooks && hooks.hooks) hooks = hooks.hooks;
  if (!hooks) hooks = readJson(path.join(root, 'hooks', 'hooks.json'), {})?.hooks;
  if (hooks) addHookEntries(ctx, hooks, { ...common, source: `${short} (plugin)`, file: root, idBase: `hook:${plugin.id}` }, root);

  let mcp = manifest.mcpServers;
  if (typeof mcp === 'string') mcp = readJson(path.join(root, mcp), {})?.mcpServers;
  if (!mcp) mcp = readJson(path.join(root, '.mcp.json'), {})?.mcpServers;
  for (const [name, cfg] of Object.entries(mcp || {})) addMcp(ctx, name, cfg, { ...common, idScope: plugin.id, path: root });

  const counts = {};
  for (const e of ctx.out.slice(before)) counts[e.kind] = (counts[e.kind] || 0) + 1;
  return counts;
}

// ---------- skills / agents / commands / output styles ----------

function scanSkillDirs(ctx, root, scope, opts = {}) {
  const sets = [{ dir: path.join(root, 'skills'), status: undefined }];
  if (scope !== 'plugin') sets.push({ dir: path.join(root, 'skills-disabled'), status: 'disabled' });
  for (const set of sets) {
    for (const d of listDir(set.dir)) {
      const dir = path.join(set.dir, d.name);
      // lstat, not the Dirent: Windows junctions don't always report as symlinks there.
      const isLink = safeIsLink(dir);
      if (!d.isDirectory() && !isLink) continue;
      if (d.name === 'synced' && scope !== 'plugin') continue;
      const file = path.join(dir, 'SKILL.md');
      const text = readText(file);
      if (text == null) {
        if (isLink && !targetExists(dir)) addBrokenLink(ctx, dir, d.name, scope, set.status);
        continue;
      }
      addSkillLike(ctx, 'skill', file, text, d.name, scope, { ...opts, status: set.status, dir });
    }
  }
}

// statSync follows the link; accessSync on Windows can succeed on a junction whose target is gone.
function targetExists(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

function safeIsLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// A skill symlink whose target is gone: Claude Code can't load it, and it's easy to miss.
function addBrokenLink(ctx, dir, name, scope, status) {
  let target = '';
  try { target = fs.readlinkSync(dir); } catch { /* unreadable */ }
  add(ctx, {
    id: `skill:${scope}${status === 'disabled' ? '-disabled' : ''}:${name}`,
    kind: 'skill', name, scope,
    status: status || 'ignored',
    description: `ลิงก์เสีย — ชี้ไปที่ ${target} ซึ่งไม่มีอยู่แล้ว`,
    dir,
    facts: { brokenLink: target },
    warnings: [`ลิงก์เสีย: ${target} ไม่มีอยู่ — Claude Code โหลดไม่ได้ ลบลิงก์นี้ทิ้งได้อย่างปลอดภัย`],
  });
}

function scanMdDir(ctx, kind, root, sub, scope, opts = {}) {
  const sets = [{ dir: path.join(root, sub), status: undefined }];
  if (scope !== 'plugin') sets.push({ dir: path.join(root, `${sub}-disabled`), status: 'disabled' });
  for (const set of sets) walkMd(set.dir, '', (file, rel) => {
    const base = rel.replace(/\.md$/i, '').split(/[\\/]/).join(':');
    addSkillLike(ctx, kind, file, readText(file), base, scope, { ...opts, status: set.status });
  });
}

function walkMd(dir, rel, fn) {
  for (const d of listDir(dir)) {
    const r = rel ? path.join(rel, d.name) : d.name;
    if (d.isDirectory()) walkMd(path.join(dir, d.name), r, fn);
    else if (/\.md$/i.test(d.name)) fn(path.join(dir, d.name), r);
  }
}

function addSkillLike(ctx, kind, file, text, baseName, scope, opts) {
  const { data, body } = parseFrontmatter(text || '');
  const short = (kind === 'agent' && data.name) || (kind === 'skill' && data.name) || baseName;
  const name = opts.prefix ? `${opts.prefix}:${short}` : short;
  const status = opts.status || opts.common?.status || 'active';
  const ext = {
    // The same name can sit in both skills/ and skills-disabled/; the id must tell them apart.
    id: `${kind}:${opts.common?.pluginId || scope}${opts.status === 'disabled' ? '-disabled' : ''}:${name}`,
    kind, name, scope,
    status,
    description: String(data.description || firstLine(body)),
    path: file,
    dir: opts.dir,
    pluginId: opts.common?.pluginId,
    readOnly: scope === 'plugin' || scope === 'synced',
    facts: {},
    warnings: [],
  };
  if (scope === 'plugin') ext.readOnlyReason = 'อยู่ใน Plugin — ปิดหรือลบได้เฉพาะทั้ง Plugin';
  const tools = toList(data['allowed-tools'] ?? data.tools);
  if (tools.length) ext.facts.tools = tools;
  if (data.model) ext.facts.model = data.model;
  if (data['argument-hint']) ext.facts.argumentHint = data['argument-hint'];
  if (data['disable-model-invocation'] === true) ext.facts.manualOnly = true;
  if (data['user-invocable'] === false) ext.facts.autoOnly = true;
  ext.facts.bodyChars = (body || '').length;
  if (opts.dir) {
    try { if (fs.lstatSync(opts.dir).isSymbolicLink()) ext.facts.linkTarget = fs.realpathSync(opts.dir); } catch { /* broken link */ }
  }

  const risky = tools.filter((t) => RISKY_TOOLS.some((r) => t === r || t.startsWith(`${r}(`)));
  if (risky.length) ext.warnings.push(`ได้รับสิทธิ์ใช้ ${risky.join(', ')} — รันคำสั่ง/แก้ไฟล์ได้`);
  if (kind === 'agent' && !tools.length) ext.warnings.push('ไม่ได้จำกัด tools — Subagent ใช้ได้ทุก tool รวมถึงแก้ไฟล์และรันคำสั่ง');
  if ((kind === 'skill' || kind === 'agent') && ext.description.length > 600) ext.warnings.push(`description ยาว ${ext.description.length} ตัวอักษร — ถูกโหลดเข้า context ทุก session`);
  return add(ctx, ext);
}

function firstLine(body) {
  return (body || '').split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
}

// claude.ai skills are synced by the desktop app into one folder per session; show the newest.
function scanSynced(ctx) {
  const base = path.join(ctx.p.configDir, 'skills', 'synced');
  const dirs = listDir(base).filter((d) => d.isDirectory())
    .map((d) => ({ dir: path.join(base, d.name), mtime: safeMtime(path.join(base, d.name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!dirs.length) return;
  for (const d of listDir(dirs[0].dir)) {
    if (!d.isDirectory()) continue;
    const file = path.join(dirs[0].dir, d.name, 'SKILL.md');
    const text = readText(file);
    if (text == null) continue;
    const ext = addSkillLike(ctx, 'skill', file, text, d.name, 'synced', { prefix: 'anthropic-skills' });
    ext.readOnlyReason = 'Sync มาจาก claude.ai ทุก session — ปิดได้ที่การตั้งค่า Skills บน claude.ai';
  }
}

function safeMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// ---------- hooks ----------

function scanHooks(ctx) {
  for (const s of ctx.settings) {
    if (s.data.hooks) addHookEntries(ctx, s.data.hooks, { scope: s.scope, source: s.file, file: s.file, idBase: `hook:${s.scope}` });
    if (s.data.disableAllHooks === true) ctx.notes.push(`${s.file} ตั้ง disableAllHooks: true — Hook ทั้งหมดถูกปิด`);
  }
  for (const h of ctx.disabledStore.hooks || []) {
    if (!h || !h.hook) continue;
    const ext = hookExt(ctx, h.event, h.matcher, h.hook, { scope: h.scope, source: h.file, file: h.file, idBase: `hook:${h.scope}` }, `d${h.storedAt}`);
    ext.status = 'disabled';
    ext.facts.stored = true;
  }
}

function addHookEntries(ctx, hooks, base, pluginRoot) {
  for (const [event, groups] of Object.entries(hooks || {})) {
    (groups || []).forEach((g, gi) => (g.hooks || []).forEach((h, hi) => hookExt(ctx, event, g.matcher, h, base, `${gi}.${hi}`, pluginRoot)));
  }
}

function hookExt(ctx, event, matcher, h, base, key, pluginRoot) {
  const cmd = h.command || h.prompt || '';
  const label = describeHookCommand(cmd, pluginRoot);
  const ext = add(ctx, {
    id: `${base.idBase}:${event}:${key}`,
    kind: 'hook',
    name: `${event}${matcher ? ` [${matcher}]` : ''} · ${label}`,
    scope: base.scope,
    status: base.status,
    description: h.statusMessage || `รัน ${h.type === 'prompt' ? 'prompt' : 'คำสั่ง'}: ${cmd.slice(0, 160)}`,
    path: base.file,
    pluginId: base.pluginId,
    readOnly: base.scope === 'plugin',
    facts: { event, matcher: matcher || '', type: h.type || 'command', command: cmd, timeout: h.timeout, raw: { event, matcher, hook: h } },
  });
  if (ext.readOnly) ext.readOnlyReason = 'อยู่ใน Plugin — ปิดหรือลบได้เฉพาะทั้ง Plugin';
  if (ALWAYS_EVENTS.has(event)) ext.warnings.push(`ทำงานอัตโนมัติทุกครั้งที่เกิด ${event} — ไม่ต้องเรียก`);
  if (/^(Pre|Post)ToolUse$/.test(event) && (!matcher || matcher === '*')) ext.warnings.push('ทำงานกับทุก tool call — อาจทำให้ช้าลง');
  if (event === 'SessionStart' || event === 'UserPromptSubmit') ext.warnings.push('ผลลัพธ์ของคำสั่งอาจถูกใส่เข้า context ทุกครั้ง');
  return ext;
}

function describeHookCommand(cmd, root) {
  const script = cmd.match(/[\w.-]+\.(?:js|mjs|sh|py|ts|cmd|ps1)\b/);
  if (script) return script[0];
  const word = cmd.trim().split(/\s+/)[0] || '(empty)';
  return word.length > 40 ? `${word.slice(0, 40)}…` : word;
}

// ---------- MCP ----------

function scanMcp(ctx) {
  const { cj, projectDir, p } = ctx;
  for (const [n, c] of Object.entries(cj.mcpServers || {})) addMcp(ctx, n, c, { scope: 'user', path: p.claudeJson });
  if (projectDir) {
    const proj = cj.projects?.[projectDir] || {};
    for (const [n, c] of Object.entries(proj.mcpServers || {})) addMcp(ctx, n, c, { scope: 'local', path: p.claudeJson });
    const mcpFile = path.join(projectDir, '.mcp.json');
    // Approval lists live both in ~/.claude.json (set by the trust prompt) and in settings files.
    const fromSettings = (k) => ctx.settings.flatMap((s) => s.data[k] || []);
    const disabled = new Set([...(proj.disabledMcpjsonServers || []), ...fromSettings('disabledMcpjsonServers')]);
    const approved = new Set([...(proj.enabledMcpjsonServers || []), ...fromSettings('enabledMcpjsonServers')]);
    const allApproved = proj.enableAllProjectMcpServers === true || ctx.settings.some((s) => s.data.enableAllProjectMcpServers === true);
    for (const [n, c] of Object.entries(readJson(mcpFile, {})?.mcpServers || {})) {
      const ext = addMcp(ctx, n, c, { scope: 'project', path: mcpFile, status: disabled.has(n) ? 'disabled' : 'active' });
      if (!disabled.has(n) && !approved.has(n) && !allApproved) {
        ext.warnings.push('ยังไม่ได้อนุมัติใน Claude Code — จะถามตอนเปิดโปรเจกต์ครั้งถัดไป');
      }
    }
  }
  for (const m of ctx.disabledStore.mcp || []) {
    if (m.scope === 'local' && m.projectDir !== projectDir) continue;
    const ext = addMcp(ctx, m.name, m.config, { scope: m.scope, path: p.claudeJson, status: 'disabled', key: `d${m.storedAt}` });
    ext.facts.stored = true;
  }
  // Files people often create by mistake; Claude Code never reads them.
  const ignoredFiles = [path.join(p.configDir, 'mcp.json'), path.join(p.configDir, '.mcp.json')];
  for (const f of ignoredFiles) {
    for (const [n, c] of Object.entries(readJson(f, {})?.mcpServers || {})) {
      const ext = addMcp(ctx, n, c, { scope: 'user', path: f, status: 'ignored', key: path.basename(f) });
      ext.readOnly = true;
      ext.readOnlyReason = `ตั้งค่าไว้ใน ${f} ซึ่ง Claude Code ไม่อ่าน — ติดตั้งใหม่ผ่านหน้า "ติดตั้ง MCP" แล้วลบไฟล์นี้`;
      ext.warnings.unshift('Ignored — ไม่ถูกโหลด');
    }
  }
  for (const s of ctx.settings) {
    for (const [n, c] of Object.entries(s.data.mcpServers || {})) {
      const ext = addMcp(ctx, n, c, { scope: s.scope, path: s.file, status: 'ignored', key: 'settings' });
      ext.readOnly = true;
      ext.readOnlyReason = 'mcpServers ใน settings.json ไม่ถูกอ่าน — Claude Code อ่าน MCP จาก ~/.claude.json และ .mcp.json';
      ext.warnings.unshift('Ignored — ไม่ถูกโหลด');
    }
  }
}

function addMcp(ctx, name, cfg = {}, o) {
  const type = cfg.type || (cfg.url ? 'http' : 'stdio');
  const facts = { type, command: cfg.command, args: cfg.args || [], url: cfg.url, envKeys: Object.keys(cfg.env || {}), headerKeys: Object.keys(cfg.headers || {}) };
  const ext = add(ctx, {
    id: `mcp:${o.idScope || o.scope}:${name}${o.key ? `:${o.key}` : ''}`,
    kind: 'mcp', name, scope: o.scope,
    status: o.status || 'active',
    description: type === 'stdio' ? `${cfg.command || ''} ${(cfg.args || []).join(' ')}`.trim() : cfg.url || '',
    path: o.path,
    pluginId: o.pluginId,
    readOnly: o.scope === 'plugin',
    facts,
  });
  if (ext.readOnly && !ext.readOnlyReason) ext.readOnlyReason = 'อยู่ใน Plugin — ปิดหรือลบได้เฉพาะทั้ง Plugin';
  if (type !== 'stdio' && cfg.url) {
    try { ext.warnings.push(`ส่งข้อมูลออกนอกเครื่องไปที่ ${new URL(cfg.url).host}`); } catch { /* bad url */ }
  }
  if ((cfg.args || []).some((a) => /@latest\b/.test(a))) ext.warnings.push('ใช้ @latest — ดาวน์โหลดโค้ดเวอร์ชันล่าสุดทุกครั้งที่เริ่ม');
  return ext;
}

// ---------- status line ----------

function scanStatusLine(ctx) {
  for (const s of ctx.settings) {
    if (!s.data.statusLine) continue;
    const cmd = s.data.statusLine.command || '';
    add(ctx, {
      id: `statusline:${s.scope}`, kind: 'statusline', name: `Status line (${s.scope})`, scope: s.scope,
      description: `รันคำสั่งเพื่อสร้างแถบสถานะ: ${cmd.slice(0, 160)}`,
      path: s.file, facts: { command: cmd, raw: s.data.statusLine },
      warnings: ['รันคำสั่งนี้ซ้ำทุกครั้งที่หน้าจอ CLI อัปเดต'],
    });
  }
  for (const s of ctx.disabledStore.statusLine || []) {
    add(ctx, {
      id: `statusline:${s.scope}:d${s.storedAt}`, kind: 'statusline', name: `Status line (${s.scope})`, scope: s.scope, status: 'disabled',
      description: `รันคำสั่งเพื่อสร้างแถบสถานะ: ${(s.value?.command || '').slice(0, 160)}`,
      path: s.file, facts: { command: s.value?.command, raw: s.value, stored: true },
    });
  }
}

// ---------- built-ins ----------

function scanBuiltins(ctx) {
  for (const s of BUILTINS.skills) {
    add(ctx, { id: `skill:builtin:${s.name}`, kind: 'skill', name: s.name, scope: 'builtin', description: s.description, readOnly: true, readOnlyReason: 'มากับ Claude Code — ปิดหรือลบไม่ได้', facts: {} });
  }
  for (const a of BUILTINS.agents) {
    add(ctx, { id: `agent:builtin:${a.name}`, kind: 'agent', name: a.name, scope: 'builtin', description: a.description, readOnly: true, readOnlyReason: 'มากับ Claude Code — ปิดหรือลบไม่ได้', facts: {} });
  }
}

// ---------- usage ----------

function attachUsage(ctx) {
  const usage = ctx.cj.skillUsage || {};
  for (const e of ctx.out) {
    if (e.kind !== 'skill' && e.kind !== 'command') continue;
    // Usage keys are bare names for user/project skills and "plugin:name" for plugin ones.
    const u = usage[e.name] || (e.scope === 'synced' ? usage[e.name.split(':').pop()] : null);
    if (u) e.usage = { count: u.usageCount || 0, lastUsedAt: u.lastUsedAt || null };
  }
}
