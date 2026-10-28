import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scan } from '../server/scan.js';
import { findOverlaps, tokenize } from '../server/overlap.js';
import { createActions, splitCommand } from '../server/actions.js';
import { createExplainer } from '../server/explain.js';
import { createApp } from '../server/server.js';
import { parseFrontmatter } from '../server/frontmatter.js';

const w = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); };
const skill = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n# ${name}\nBody.\n`;

// A throwaway ~/.claude that exercises every category.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cci-test-'));
  const cfg = path.join(root, 'claude');
  const proj = path.join(root, 'proj');
  const plug = path.join(cfg, 'plugins', 'cache', 'mk', 'demo', '1.0.0');
  w(path.join(cfg, 'skills', 'grilling', 'SKILL.md'), skill('grilling', 'Grill the user relentlessly about a plan or decision to stress-test their thinking.'));
  w(path.join(cfg, 'skills', 'grill-me', 'SKILL.md'), skill('grill-me', 'A relentless interview to sharpen a plan or design.'));
  w(path.join(cfg, 'skills', 'grill-me', 'notes.txt'), 'keep me');
  w(path.join(cfg, 'skills', 'weather', 'SKILL.md'), skill('weather', 'Fetch the weather forecast for a city.', 'allowed-tools: Bash, Read\n'));
  w(path.join(cfg, 'skills-disabled', 'old', 'SKILL.md'), skill('old', 'Something old.'));
  w(path.join(cfg, 'agents', 'reviewer.md'), skill('reviewer', 'Reviews code for bugs.'));
  w(path.join(cfg, 'commands', 'git', 'ship.md'), '---\ndescription: Ship it\nargument-hint: <branch>\n---\nDo it.');
  w(path.join(cfg, 'mcp.json'), { mcpServers: { ghost: { command: 'npx', args: ['ghost@latest'] } } });
  w(path.join(cfg, 'settings.json'), {
    enabledPlugins: { 'demo@mk': true },
    statusLine: { type: 'command', command: 'echo hi' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.js' }, { type: 'command', command: 'echo second' }] }] },
  });
  w(path.join(cfg, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'demo@mk': [{ scope: 'user', installPath: plug, version: '1.0.0' }] } });
  w(path.join(plug, '.claude-plugin', 'plugin.json'), { name: 'demo', description: 'Demo plugin', hooks: './hooks/h.json' });
  w(path.join(plug, 'skills', 'grilling', 'SKILL.md'), skill('grilling', 'Plugin flavoured grilling of plans.'));
  w(path.join(plug, 'hooks', 'h.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/start.js"' }] }] } });
  w(path.join(cfg, '.claude.json'), {
    mcpServers: { local1: { type: 'stdio', command: 'my-mcp', env: { SECRET: 'shh' } } },
    projects: { [proj]: { mcpServers: {}, disabledMcpjsonServers: [] } },
    skillUsage: { grilling: { usageCount: 4, lastUsedAt: 1 } },
  });
  w(path.join(proj, '.mcp.json'), { mcpServers: { teamdb: { type: 'http', url: 'https://db.example.com/mcp' } } });
  w(path.join(proj, '.claude', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploy the app.'));
  return { root, cfg, proj, env: { CLAUDE_CONFIG_DIR: cfg } };
}

const find = (r, id) => r.extensions.find((e) => e.id === id);

test('scan finds every category with the right status and scope', () => {
  const f = fixture();
  const r = scan({ projectDir: f.proj, env: f.env });
  const ids = r.extensions.map((e) => e.id);
  assert.ok(ids.includes('skill:user:grilling'));
  assert.equal(find(r, 'skill:user-disabled:old').status, 'disabled');
  assert.ok(ids.includes('agent:user:reviewer'));
  assert.equal(find(r, 'command:user:git:ship').facts.argumentHint, '<branch>');
  assert.equal(find(r, 'skill:project:deploy').scope, 'project');
  const plug = find(r, 'plugin:demo@mk');
  assert.equal(plug.status, 'active');
  assert.deepEqual(plug.facts.components, { skill: 1, hook: 1 });
  const pskill = find(r, 'skill:plugin:demo@mk:demo:grilling');
  assert.ok(pskill.readOnly);
  assert.equal(r.extensions.filter((e) => e.kind === 'hook' && e.scope === 'user').length, 2);
  const ghost = r.extensions.find((e) => e.name === 'ghost');
  assert.equal(ghost.status, 'ignored');
  const local1 = r.extensions.find((e) => e.name === 'local1');
  assert.deepEqual(local1.facts.envKeys, ['SECRET']);
  assert.ok(!JSON.stringify(local1).includes('shh'), 'MCP env values must never leave the scanner');
  assert.ok(find(r, 'mcp:project:teamdb').warnings.some((x) => x.includes('db.example.com')));
  assert.equal(find(r, 'skill:user:grilling').usage.count, 4);
  assert.ok(find(r, 'skill:user:weather').warnings.some((x) => x.includes('Bash')));
  assert.ok(ids.includes('statusline:user'));
  assert.ok(ids.includes('skill:builtin:simplify'));
});

test('overlap groups same names and similar descriptions, skips disabled', () => {
  const f = fixture();
  const { extensions } = scan({ projectDir: f.proj, env: f.env });
  const groups = findOverlaps(extensions);
  const all = groups.flatMap((g) => g.members);
  const named = groups.find((g) => g.reason === 'name' && g.terms[0] === 'grilling');
  assert.ok(named, 'user grilling and plugin grilling share a name');
  assert.ok(groups.some((g) => g.members.includes('skill:user:grill-me') && g.members.includes('skill:user:grilling')));
  assert.ok(!all.includes('skill:user-disabled:old'));
  assert.ok(!all.includes('skill:user:weather'));
});

test('tokenize segments Thai text without spaces', () => {
  const t = tokenize('ตรวจสอบโค้ดก่อนรวมเข้าระบบ');
  assert.ok(t.length >= 3, `got ${t.join('|')}`);
});

test('skill disable then enable restores the folder untouched', async () => {
  const f = fixture();
  const a = createActions({ env: f.env });
  let e = find(scan({ env: f.env }), 'skill:user:grill-me');
  await a.disable(e);
  assert.ok(fs.existsSync(path.join(f.cfg, 'skills-disabled', 'grill-me', 'notes.txt')));
  e = find(scan({ env: f.env }), 'skill:user-disabled:grill-me');
  assert.equal(e.status, 'disabled');
  await a.enable(e);
  assert.equal(fs.readFileSync(path.join(f.cfg, 'skills', 'grill-me', 'notes.txt'), 'utf8'), 'keep me');
});

test('hook disable then enable gives back identical settings', async () => {
  const f = fixture();
  const file = path.join(f.cfg, 'settings.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = createActions({ env: f.env });
  const hook = scan({ env: f.env }).extensions.find((e) => e.kind === 'hook' && e.facts.command === 'node guard.js');
  await a.disable(hook);
  const mid = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(mid.hooks.PreToolUse[0].hooks.length, 1);
  const stored = scan({ env: f.env }).extensions.find((e) => e.kind === 'hook' && e.status === 'disabled');
  assert.equal(stored.facts.command, 'node guard.js');
  await a.enable(stored);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(new Set(after.hooks.PreToolUse[0].hooks.map((h) => h.command)), new Set(before.hooks.PreToolUse[0].hooks.map((h) => h.command)));
  assert.equal(scan({ env: f.env }).extensions.filter((e) => e.kind === 'hook' && e.status === 'disabled').length, 0);
});

test('status line disable/enable round-trips', async () => {
  const f = fixture();
  const a = createActions({ env: f.env });
  await a.disable(find(scan({ env: f.env }), 'statusline:user'));
  const off = scan({ env: f.env }).extensions.find((e) => e.kind === 'statusline');
  assert.equal(off.status, 'disabled');
  await a.enable(off);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.cfg, 'settings.json'), 'utf8')).statusLine, { type: 'command', command: 'echo hi' });
});

test('delete backs up before removing', async () => {
  const f = fixture();
  const a = createActions({ env: f.env });
  const msg = await a.remove(find(scan({ env: f.env }), 'skill:user:weather'));
  assert.ok(!fs.existsSync(path.join(f.cfg, 'skills', 'weather')));
  const backupPath = msg.match(/สำรองไว้ที่ (.+)\)/)[1];
  assert.ok(fs.existsSync(path.join(backupPath, 'SKILL.md')));
});

test('symlinked skill: disable/enable keeps the link, delete removes only the link', async () => {
  const f = fixture();
  const real = path.join(f.root, 'shared', 'linked');
  w(path.join(real, 'SKILL.md'), skill('linked', 'Lives elsewhere.'));
  // 'junction' lets Windows CI create a directory link without admin rights; ignored elsewhere.
  fs.symlinkSync(real, path.join(f.cfg, 'skills', 'linked'), 'junction');
  const a = createActions({ env: f.env });
  let e = find(scan({ env: f.env }), 'skill:user:linked');
  assert.equal(e.facts.linkTarget, fs.realpathSync(real));
  await a.disable(e);
  await a.enable(find(scan({ env: f.env }), 'skill:user-disabled:linked'));
  e = find(scan({ env: f.env }), 'skill:user:linked');
  assert.equal(e.status, 'active');
  const msg = await a.remove(e);
  assert.ok(fs.existsSync(path.join(real, 'SKILL.md')), 'real content must survive');
  assert.ok(!fs.existsSync(path.join(f.cfg, 'skills', 'linked')));
  const backupPath = msg.match(/สำรองไว้ที่ (.+)\)/)[1];
  assert.ok(fs.statSync(path.join(backupPath, 'SKILL.md')).isFile(), 'backup holds content, not a link');
});

test('same name in skills/ and skills-disabled/ stays two separate items', async () => {
  const f = fixture();
  w(path.join(f.cfg, 'skills-disabled', 'grill-me', 'SKILL.md'), skill('grill-me', 'Older copy.'));
  const a = createActions({ env: f.env });
  const r = scan({ env: f.env });
  const ids = r.extensions.filter((e) => e.name === 'grill-me').map((e) => e.id);
  assert.deepEqual(ids.sort(), ['skill:user-disabled:grill-me', 'skill:user:grill-me']);
  await a.remove(find(r, 'skill:user-disabled:grill-me'));
  assert.ok(fs.existsSync(path.join(f.cfg, 'skills', 'grill-me', 'SKILL.md')), 'active copy must survive deleting the disabled one');
  assert.ok(!fs.existsSync(path.join(f.cfg, 'skills-disabled', 'grill-me')));
});

test('broken skill links are listed and can only be deleted', async () => {
  const f = fixture();
  const gone = path.join(f.root, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(f.cfg, 'skills-disabled', 'deadlink'), 'junction');
  fs.rmSync(gone, { recursive: true });
  const a = createActions({ env: f.env });
  const e = find(scan({ env: f.env }), 'skill:user-disabled:deadlink');
  assert.ok(e.warnings[0].includes('ลิงก์เสีย'));
  await assert.rejects(a.enable(e), /ลิงก์เสีย/);
  await a.remove(e);
  assert.equal(scan({ env: f.env }).extensions.filter((x) => x.name === 'deadlink').length, 0);
});

test('read-only extensions refuse changes', async () => {
  const f = fixture();
  const a = createActions({ env: f.env });
  const r = scan({ env: f.env });
  await assert.rejects(a.disable(find(r, 'skill:plugin:demo@mk:demo:grilling')), /Plugin/);
  await assert.rejects(a.remove(r.extensions.find((e) => e.name === 'ghost')), /ไม่อ่าน/);
});

test('user MCP disable stores config and enable re-adds it via the CLI', async () => {
  const f = fixture();
  const calls = [];
  const cli = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };
  const a = createActions({ env: f.env, cli });
  await a.disable(find(scan({ env: f.env }), 'mcp:user:local1'));
  assert.deepEqual(calls[0], ['claude', 'mcp', 'remove', 'local1', '-s', 'user']);
  // The real CLI would have removed it from .claude.json; mimic that.
  const cj = JSON.parse(fs.readFileSync(path.join(f.cfg, '.claude.json'), 'utf8'));
  delete cj.mcpServers.local1;
  fs.writeFileSync(path.join(f.cfg, '.claude.json'), JSON.stringify(cj));
  const off = scan({ env: f.env }).extensions.find((e) => e.name === 'local1');
  assert.equal(off.status, 'disabled');
  await a.enable(off);
  assert.equal(calls[1][2], 'add-json');
  assert.deepEqual(JSON.parse(calls[1][4]), { type: 'stdio', command: 'my-mcp', env: { SECRET: 'shh' } });
});

test('project MCP disable writes settings.local.json', async () => {
  const f = fixture();
  const a = createActions({ env: f.env, cli: async () => ({ stdout: '' }) });
  await a.disable(find(scan({ projectDir: f.proj, env: f.env }), 'mcp:project:teamdb'), { projectDir: f.proj });
  assert.equal(find(scan({ projectDir: f.proj, env: f.env }), 'mcp:project:teamdb').status, 'disabled');
});

test('MCP install validates input and builds args without a shell', async () => {
  const f = fixture();
  const calls = [];
  const a = createActions({ env: f.env, cli: async (cmd, args) => { calls.push(args); return { stdout: 'ok' }; } });
  await assert.rejects(a.installMcp({ name: 'bad name; rm -rf', command: 'x' }), /ชื่อ/);
  await assert.rejects(a.installMcp({ name: 'x', command: 'y', env: [{ key: 'A B', value: '1' }] }), /env/);
  await a.installMcp({ name: 'gh', command: 'npx -y "@scope/server gh"', env: [{ key: 'TOKEN', value: 'a b' }] });
  assert.deepEqual(calls[0], ['mcp', 'add', '-s', 'user', '-e', 'TOKEN=a b', 'gh', '--', 'npx', '-y', '@scope/server gh']);
  assert.ok(!a.mcpPreview({ name: 'gh', type: 'stdio', command: 'x', env: [{ key: 'TOKEN', value: 'secret' }], scope: 'user' }).includes('secret'));
});

test('skill install from a local folder copies chosen skills and refuses duplicates', async () => {
  const f = fixture();
  const src = path.join(f.root, 'repo');
  w(path.join(src, 'skills', 'tdd', 'SKILL.md'), skill('tdd', 'Test-driven development.'));
  w(path.join(src, 'skills', 'grill-me', 'SKILL.md'), skill('grill-me', 'Dup.'));
  const a = createActions({ env: f.env });
  const pv = await a.skillPreview({ source: src });
  assert.deepEqual(pv.skills.map((s) => s.name).sort(), ['grill-me', 'tdd']);
  await a.skillInstall({ token: pv.token, names: ['tdd'] });
  assert.ok(fs.existsSync(path.join(f.cfg, 'skills', 'tdd', 'SKILL.md')));
  const pv2 = await a.skillPreview({ source: src });
  await assert.rejects(a.skillInstall({ token: pv2.token, names: ['grill-me'] }), /อยู่แล้ว/);
  await assert.rejects(a.skillPreview({ source: 'file:///etc' }), /git URL/);
});

test('explainer caches results and reports errors', async () => {
  const f = fixture();
  const ex = createExplainer({ env: f.env, run: async () => '{"what":"w","does":"d","how":"h","example":"e"}' });
  const e = find(scan({ env: f.env }), 'skill:user:grilling');
  ex.enqueue(e);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ex.cached(e).what, 'w');
  assert.equal(ex.status(e), 'done');
  const bad = createExplainer({ env: f.env, run: async () => 'no json here' });
  const e2 = find(scan({ env: f.env }), 'skill:user:weather');
  bad.enqueue(e2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bad.status(e2), 'error');
});

test('server rejects missing token, foreign origin and foreign host', async () => {
  const f = fixture();
  const app = createApp({ token: 'tok', projectDir: f.proj, env: f.env, explainer: createExplainer({ env: f.env, run: async () => '{}' }), actions: createActions({ env: f.env, cli: async () => ({ stdout: '' }) }) });
  const port = await app.listen(0);
  const req = (p, headers = {}, method = 'GET') => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.end();
  });
  try {
    assert.equal((await req('/api/state')).status, 403);
    assert.equal((await req('/api/state', { 'x-token': 'tok', origin: 'http://evil.example' })).status, 403);
    assert.equal((await req('/api/state', { 'x-token': 'tok', host: 'evil.example' })).status, 403);
    assert.equal((await req('/')).status, 403);
    assert.equal((await req('/?t=tok')).status, 200);
    const ok = await req('/api/state', { 'x-token': 'tok' });
    assert.equal(ok.status, 200);
    assert.ok(JSON.parse(ok.body).extensions.length > 5);
    assert.equal((await req('/api/state?project=/etc', { 'x-token': 'tok' })).status, 400);
    assert.equal((await req('/api/action', { 'x-token': 'tok', 'content-type': 'text/plain' }, 'POST')).status, 415);
  } finally { app.close(); }
});

test('frontmatter parser handles block scalars, lists and quotes', () => {
  const { data } = parseFrontmatter('---\nname: "x"\ndescription: >\n  line one\n  line two\ntools:\n  - Read\n  - Bash\nflag: false\n---\nbody');
  assert.equal(data.name, 'x');
  assert.equal(data.description, 'line one line two');
  assert.deepEqual(data.tools, ['Read', 'Bash']);
  assert.equal(data.flag, false);
});

test('splitCommand keeps quoted arguments together', () => {
  assert.deepEqual(splitCommand(`npx -y "a b" 'c d' e`), ['npx', '-y', 'a b', 'c d', 'e']);
});
