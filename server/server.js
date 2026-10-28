import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scan } from './scan.js';
import { findOverlaps } from './overlap.js';
import { howToUse } from './howto.js';
import { createExplainer, sourceFor } from './explain.js';
import { createActions } from './actions.js';
import { claudePaths, writeJsonAtomic, readJson } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', 'web', 'index.html');
const MAX_BODY = 1024 * 1024;

export function createApp({ token, projectDir = null, env = process.env, idleMs = 60000, explainer, actions, onIdle } = {}) {
  explainer ||= createExplainer({ env });
  actions ||= createActions({ env });
  let lastBeat = Date.now();
  let autoQueued = false;
  let port = 0;

  const knownProjects = () => new Set([projectDir, ...scan({ env }).meta.projects].filter(Boolean));
  function resolveProject(q) {
    if (q === undefined || q === null || q === '' || q === 'null') return projectDir;
    if (q === 'none') return null;
    if (!knownProjects().has(q)) throw httpError(400, 'ไม่รู้จักโปรเจกต์นี้');
    return q;
  }

  function state(proj) {
    const { extensions, meta } = scan({ projectDir: proj, env });
    const groups = findOverlaps(extensions);
    const groupOf = new Map();
    groups.forEach((g) => g.members.forEach((id) => groupOf.set(id, [...(groupOf.get(id) || []), g.id])));
    if (!autoQueued) {
      autoQueued = true;
      for (const e of extensions) explainer.enqueue(e);
    }
    return {
      meta: { ...meta, startProject: projectDir },
      extensions: extensions.map((e) => ({
        ...e,
        howto: howToUse(e),
        explanation: explainer.cached(e),
        explainStatus: explainer.status(e),
        explainError: explainer.error(e.id),
        overlaps: groupOf.get(e.id) || [],
      })),
      overlaps: groups,
      progress: explainer.progress(),
    };
  }

  function find(id, proj) {
    const e = scan({ projectDir: proj, env }).extensions.find((x) => x.id === id);
    if (!e) throw httpError(404, 'ไม่พบรายการนี้ — กดรีเฟรช');
    return e;
  }

  const routes = {
    'GET /api/state': (q) => state(resolveProject(q.project)),
    'POST /api/heartbeat': () => ({ ok: true }),
    'GET /api/source': (q) => {
      const e = find(q.id, resolveProject(q.project));
      return { path: e.path || null, text: sourceFor(e) };
    },
    'POST /api/action': async (q, b) => {
      const proj = resolveProject(b.project);
      const e = find(b.id, proj);
      const fn = { disable: actions.disable, enable: actions.enable, delete: actions.remove }[b.action];
      if (!fn) throw httpError(400, 'action ไม่ถูกต้อง');
      return { message: await fn(e, { projectDir: proj }) };
    },
    'POST /api/explain': (q, b) => {
      const proj = resolveProject(b.project);
      const exts = scan({ projectDir: proj, env }).extensions;
      explainer.resume();
      const targets = b.id ? exts.filter((e) => e.id === b.id) : exts;
      targets.forEach((e) => explainer.enqueue(e, { force: !!b.force }));
      return explainer.progress();
    },
    'POST /api/explain/stop': () => { explainer.stop(); return explainer.progress(); },
    'POST /api/judge': async (q, b) => {
      const proj = resolveProject(b.project);
      const { extensions } = scan({ projectDir: proj, env });
      const g = findOverlaps(extensions).find((x) => x.id === b.groupId);
      if (!g) throw httpError(404, 'ไม่พบกลุ่มนี้');
      return explainer.judge(g.members.map((id) => extensions.find((e) => e.id === id)));
    },
    // Overlap check for things not installed yet (plugin catalog entries, skills in a repo).
    'POST /api/overlap/check': (q, b) => {
      const { extensions } = scan({ projectDir: resolveProject(b.project), env });
      const candidates = (b.items || []).slice(0, 100).map((it, i) => ({ id: `candidate:${i}`, kind: 'skill', name: String(it.name || ''), description: String(it.description || ''), status: 'active' }));
      const groups = findOverlaps([...extensions, ...candidates]);
      const byId = new Map(extensions.map((e) => [e.id, e]));
      return candidates.map((c) => {
        const hits = groups.filter((g) => g.members.includes(c.id));
        // Only direct neighbours — a union-find group can chain in unrelated items.
        const direct = hits.flatMap((g) => g.reason === 'name' ? g.members : g.pairs.filter((p) => p.a === c.id || p.b === c.id).flatMap((p) => [p.a, p.b]));
        const others = [...new Set(direct)].filter((id) => byId.has(id)).map((id) => byId.get(id).name);
        return { sameName: hits.some((g) => g.reason === 'name'), similar: others };
      });
    },
    'GET /api/catalog': () => actions.pluginCatalog(),
    'POST /api/install/plugin': async (q, b) => ({ message: await actions.installPlugin(b, { projectDir: resolveProject(b.project) }) }),
    'POST /api/install/marketplace': async (q, b) => ({ message: await actions.addMarketplace(b) }),
    'POST /api/mcp/preview': (q, b) => ({ command: actions.mcpPreview(b) }),
    'POST /api/install/mcp': async (q, b) => ({ message: await actions.installMcp(b, { projectDir: resolveProject(b.project) }) }),
    'POST /api/skill/preview': async (q, b) => actions.skillPreview(b),
    'POST /api/install/skill': async (q, b) => ({ message: await actions.skillInstall(b, { projectDir: resolveProject(b.project) }) }),
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      checkHost(req, port);
      if (req.method === 'GET' && url.pathname === '/') {
        if (!safeEqual(url.searchParams.get('t'), token)) throw httpError(403, 'ต้องเปิดผ่านลิงก์จาก /cc-inventory:inventory');
        lastBeat = Date.now();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(fs.readFileSync(INDEX));
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw httpError(404, 'not found');
      if (!safeEqual(req.headers['x-token'], token)) throw httpError(403, 'token ไม่ถูกต้อง');
      lastBeat = Date.now();
      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'ต้องเป็น JSON');
        body = await readBody(req);
      }
      const out = await handler(Object.fromEntries(url.searchParams), body);
      send(res, 200, out);
    } catch (err) {
      send(res, err.status || 500, { error: err.message || String(err) });
    }
  });

  const timer = setInterval(() => {
    if (Date.now() - lastBeat > idleMs) { clearInterval(timer); server.close(); onIdle?.(); }
  }, Math.min(10000, idleMs));
  timer.unref();

  return {
    server,
    listen(p = 0) {
      return new Promise((resolve) => server.listen(p, '127.0.0.1', () => { port = server.address().port; resolve(port); }));
    },
    close() { clearInterval(timer); server.close(); },
  };
}

// Blocks DNS-rebinding (foreign Host) and cross-site requests (foreign Origin).
function checkHost(req, port) {
  const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!okHosts.includes(req.headers.host)) throw httpError(403, 'host ไม่ถูกต้อง');
  const origin = req.headers.origin;
  if (origin && !okHosts.map((h) => `http://${h}`).includes(origin)) throw httpError(403, 'origin ไม่ถูกต้อง');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(httpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- entry point (spawned detached by start.js) ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const { dataDir } = claudePaths();
  const lock = path.join(dataDir, 'server.json');
  const token = process.env.CC_INVENTORY_TOKEN || crypto.randomBytes(24).toString('hex');
  const project = arg('--project') || null;
  const cleanup = () => { if (readJson(lock, {})?.pid === process.pid) fs.rmSync(lock, { force: true }); };
  const app = createApp({ token, projectDir: project, idleMs: Number(arg('--idle') || 60000), onIdle: () => { cleanup(); process.exit(0); } });
  const port = await app.listen(Number(arg('--port') || 0));
  writeJsonAtomic(lock, { port, token, pid: process.pid, project, startedAt: new Date().toISOString(), host: os.hostname() });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
}
