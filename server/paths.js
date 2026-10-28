import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Claude Code honours CLAUDE_CONFIG_DIR; when set, .claude.json lives inside it.
export function claudePaths(env = process.env) {
  const home = os.homedir();
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const claudeJson = env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  const dataDir = path.join(configDir, 'cc-inventory');
  return { home, configDir, claudeJson, dataDir };
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// Write via temp file + rename so a crash never leaves half a settings.json.
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // 0600: these files can hold the server token or stored MCP configs with secrets.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
