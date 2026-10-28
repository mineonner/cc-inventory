// Overlap = Active Extensions Claude chooses between by reading name + description:
// skills, subagents, commands, output styles. Hooks/MCP/status lines are not "picked" by the model.
const PICKABLE = new Set(['skill', 'agent', 'command', 'outputstyle']);

const STOP = new Set(('a an and are as at be by for from has have if in into is it its of on or that the this to use used uses using when with you your ' +
  'user users claude me skill skills agent agents command commands task tasks file files any all can do does not only also should must will ' +
  'trigger triggers triggered asks ask wants want mention mentions mentioned e g eg etc like such via before after them they their then than ' +
  'จะ ที่ และ ใน ให้ ของ เป็น ได้ มี การ ไม่ ว่า หรือ กับ แล้ว ก็ ตาม เมื่อ').split(/\s+/));

const segmenter = new Intl.Segmenter('th', { granularity: 'word' });

export function tokenize(text) {
  const out = [];
  for (const s of segmenter.segment(String(text || '').toLowerCase().replace(/[_/:-]/g, ' '))) {
    if (!s.isWordLike) continue;
    const w = stem(s.segment);
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

// ponytail: crude English suffix strip so review/reviews/reviewer/reviewing meet; a real stemmer
// only if overlap results look noisy.
function stem(w) {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w;
  return w.replace(/(ing|ers|er|ed|es|s)$/, '');
}

function shortName(e) {
  return e.name.split(':').pop().toLowerCase();
}

export function findOverlaps(extensions, { threshold = 0.3 } = {}) {
  const items = extensions.filter((e) => e.status === 'active' && PICKABLE.has(e.kind));
  const groups = [];

  // Pass 1: same bare name at different places — the strongest, cheapest signal.
  const byName = new Map();
  for (const e of items) {
    const k = shortName(e);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const nameGrouped = new Set();
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    list.forEach((e) => nameGrouped.add(e.id));
    groups.push({ id: `name:${name}`, reason: 'name', members: list.map((e) => e.id), score: 1, terms: [name] });
  }

  // Pass 2: half name-token overlap (intent is mostly in the name), half TF-IDF cosine of descriptions.
  const nameSets = items.map((e) => new Set(tokenize(e.name.split(':').pop())));
  const docs = items.map((e) => tokenize(e.description));
  const df = new Map();
  docs.forEach((d) => new Set(d).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const N = docs.length;
  const vecs = docs.map((d) => {
    const tf = new Map();
    d.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log(1 + N / (df.get(t) || 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });

  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // Components of one plugin are designed together; the author already chose between them.
      if (items[i].pluginId && items[i].pluginId === items[j].pluginId) continue;
      const [a, b] = vecs[i].size < vecs[j].size ? [vecs[i], vecs[j]] : [vecs[j], vecs[i]];
      let cos = 0;
      const shared = [];
      for (const [t, w] of a) {
        const w2 = b.get(t);
        if (w2) { cos += w * w2; shared.push([t, w * w2]); }
      }
      const na = nameSets[i], nb = nameSets[j];
      const common = [...na].filter((t) => nb.has(t));
      const nameScore = common.length ? common.length / new Set([...na, ...nb]).size : 0;
      const score = 0.5 * nameScore + 0.5 * cos;
      if (score >= threshold) {
        const terms = [...common, ...shared.sort((x, y) => y[1] - x[1]).map((s) => s[0]).filter((t) => !common.includes(t))].slice(0, 5);
        pairs.push({ a: i, b: j, score, terms });
      }
    }
  }

  // ponytail: union-find over pairs; chains can merge loosely related items, so each group keeps
  // its weakest link score visible. Switch to per-item neighbour lists if groups get too broad.
  const parent = items.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const p of pairs) parent[find(p.a)] = find(p.b);
  const clusters = new Map();
  for (const p of pairs) {
    const r = find(p.a);
    if (!clusters.has(r)) clusters.set(r, { members: new Set(), pairs: [] });
    const c = clusters.get(r);
    c.members.add(p.a).add(p.b);
    c.pairs.push(p);
  }
  for (const c of clusters.values()) {
    const members = [...c.members].map((i) => items[i].id);
    if (members.every((id) => nameGrouped.has(id))) continue;
    const termScore = new Map();
    c.pairs.forEach((p) => p.terms.forEach((t, k) => termScore.set(t, (termScore.get(t) || 0) + (5 - k))));
    groups.push({
      id: `sim:${members[0]}`,
      reason: 'similar',
      members,
      score: Math.max(...c.pairs.map((p) => p.score)),
      minScore: Math.min(...c.pairs.map((p) => p.score)),
      pairs: c.pairs.map((p) => ({ a: items[p.a].id, b: items[p.b].id, score: round(p.score), terms: p.terms })),
      terms: [...termScore].sort((x, y) => y[1] - x[1]).slice(0, 6).map((t) => t[0]),
    });
  }

  groups.forEach((g) => { g.score = round(g.score); if (g.minScore != null) g.minScore = round(g.minScore); });
  groups.sort((x, y) => y.score - x.score);
  return groups;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
