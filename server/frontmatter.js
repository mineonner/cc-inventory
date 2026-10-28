// ponytail: minimal YAML frontmatter reader — flat keys, quoted strings, block scalars (| >)
// and "- item" lists. Enough for SKILL.md / agent / command headers; swap for a YAML lib if
// a real file needs nested maps.
export function parseFrontmatter(text) {
  if (!text) return { data: {}, body: '' };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value = raw.trim();
    if (value === '' || value === '|' || value === '>' || /^[|>][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i]);
      const items = block.filter((l) => /^\s*-\s+/.test(l));
      if (value === '' && items.length && items.length === block.filter((l) => l.trim()).length) {
        data[key] = items.map((l) => unquote(l.replace(/^\s*-\s+/, '').trim()));
        continue;
      }
      const joined = block.map((l) => l.trim());
      value = value.startsWith('|') ? joined.join('\n').trim() : joined.join(' ').replace(/\s+/g, ' ').trim();
      data[key] = value;
      continue;
    }
    data[key] = unquote(value);
  }
  return { data, body: m[2] };
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

export function toList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) return [];
  return v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}
