'use strict';

/**
 * src/opon/fixtures/strip.js — shape-stripped test fixtures (brief v3 lines
 * 738-744; Phase 1 slice A9; P1-9). A raw recording stays on the machine that
 * made it; what leaves is its shape.
 *
 *   stripEvents(events)        { events, kept }: today's events with every
 *                              name, path segment, command argument, host, id
 *                              and fingerprint swapped for a stable
 *                              placeholder (the same real value always gets the
 *                              same one), and all content masked to the same
 *                              length (lines and their +/- markers kept).
 *                              Kept as is: order, timing, counts, sizes, exit
 *                              statuses and codes (null stays null), event
 *                              types, flags, operators, file extensions, common
 *                              program names and public tool names. `kept` is
 *                              that vocabulary, for the leak check.
 *   leakCheck(raw, stripped)   the private tokens of the raw events that still
 *                              appear in the stripped ones ([] when clean)
 *   relevance(raw, stripped)   whether both translate (A8) to the same marks,
 *                              kinds and counts: the mark-level half of test 50
 *
 * The mapping from real to placeholder lives only in memory and is never
 * returned or written.
 */

const crypto = require('crypto');
const { translateEvents } = require('../intake/adapters/events-v0');

const PROGRAMS = new Set(
  ('npm npx node git gh python python3 pip cat ls cd grep rg sed awk echo bash sh zsh make yarn pnpm go cargo java mvn docker ' +
    'kubectl curl wget rm mv cp mkdir touch head tail wc find jq tsc eslint prettier jest pytest printf test true false env export ' +
    'sleep kill ps chmod date open diff sort uniq xargs tee shasum').split(' '),
);
const OPERATORS = new Set(['|', '||', '&&', ';', '>', '>>', '<', '2>&1', '&', '2>', '--']);
// Kept words come from public lists only; anything else derived from raw data is replaced.
const EXTENSIONS = new Set(
  ('js mjs cjs ts tsx jsx json jsonl md txt html css scss py rb go rs java kt c h cc cpp hpp sh zsh bash yml yaml toml ini cfg ' +
    'lock log csv tsv xml svg png jpg jpeg gif pdf sql env example tmp bak orig diff patch map gz zip tar').split(' '),
);
const FLAGS = new Set(
  ('-a -c -d -e -f -h -i -l -m -n -o -p -q -r -s -t -u -v -x -y -z -rf -la -sb ' +
    '--all --check --json --session --gate --global --root --out --help --version --verbose --quiet --force --yes --dry-run ' +
    '--watch --grep --stat --oneline --format --no-verify --facts-only --with-gate --gate-only --include --keep --agent').split(' '),
);
const FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/;
const HEX = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const KEEP_FIELDS = new Set(['ts', 'type', 'source', 'agent', 'turn_id', 'failed', 'exit_code', 'read_kind', 'change_kind', 'binary', 'bytes', 'result_bytes', 'channel', 'claim_unconfirmed', 'redactions', 'sub_agent_type']);
const ID_FIELDS = new Set(['session_id', 'call_id', 'sub_agent_id']);
const PATH_FIELDS = new Set(['path', 'rel_path', 'output_path']);
const HASH_FIELDS = new Set(['hash', 'hash_before', 'hash_after', 'head_sha', 'merged_sha']);
const TEXT_FIELDS = new Set(['text', 'stdout_excerpt', 'result_excerpt', 'diff']);

function stripEvents(events) {
  const maps = { s: new Map(), a: new Map(), h: new Map(), id: new Map(), x: new Map() };
  const kept = new Set();
  const ph = (kind, real) => {
    const m = maps[kind];
    if (!m.has(real)) {
      const n = m.size + 1;
      m.set(real, kind === 'h' ? `h${n}.example` : kind === 'x' ? crypto.createHash('sha256').update(`placeholder:${real.length}:${n}`).digest('hex').slice(0, real.length) : `${kind}${n}`);
      keep(m.get(real)); // a placeholder the stripper emits is not a leak, whatever raw text happens to hold
    }
    return m.get(real);
  };
  const keep = (w) => {
    for (const x of words(w, 1)) kept.add(x);
    return w;
  };
  keep('mcp example'); // the placeholders' own fixed words
  const mask = (s) => String(s).replace(/[^\n ]/g, 'x');
  const maskDiff = (s) =>
    String(s)
      .split('\n')
      .map((l) => (l ? l[0] + mask(l.slice(1)) : l))
      .join('\n');

  const segment = (seg) => {
    if (seg === '' || seg === '.' || seg === '..' || seg === '~') return seg;
    const dot = seg.lastIndexOf('.');
    if (dot > 0 && EXTENSIONS.has(seg.slice(dot + 1).toLowerCase())) return ph('s', seg.slice(0, dot)) + '.' + keep(seg.slice(dot + 1));
    if (seg.startsWith('.') && seg.length > 1) return '.' + ph('s', seg.slice(1));
    return ph('s', seg);
  };
  const stripPath = (p) => String(p).split('/').map(segment).join('/');

  const stripCommand = (cmd) => {
    let first = true;
    return String(cmd)
      .split(' ')
      .map((w) => {
        if (w === '') return w;
        if (OPERATORS.has(w)) {
          first = true;
          return keep(w);
        }
        const isFirst = first;
        first = false;
        const flag = (f) => keep(FLAGS.has(f) ? f : f.match(/^-+/)[0] + ph('a', f.replace(/^-+/, '')));
        if (FLAG.test(w)) return flag(w);
        const eq = w.indexOf('=');
        if (eq > 0 && FLAG.test(w.slice(0, eq))) return flag(w.slice(0, eq)) + '=' + ph('a', w.slice(eq + 1));
        if (isFirst && PROGRAMS.has(w)) return keep(w);
        if (w.includes('/')) return stripPath(w);
        return ph('a', w);
      })
      .join(' ');
  };

  const stripUrl = (u) => {
    let url;
    try {
      url = new URL(String(u));
    } catch {
      return mask(u);
    }
    const p = url.pathname.split('/').map((s) => (s ? ph('s', s) : s)).join('/');
    return `${keep(url.protocol)}//${ph('h', url.host)}${p}${url.search ? '?' + mask(url.search.slice(1)) : ''}`;
  };

  const stripValue = (v) => {
    if (typeof v === 'string') return mask(v);
    if (typeof v === 'number') return 0;
    if (Array.isArray(v)) return v.map(stripValue);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[keep(k)] = stripValue(x);
      return o;
    }
    return v;
  };

  const stripToolName = (n) => {
    const s = String(n);
    if (s.startsWith('mcp__')) return 'mcp__' + s.slice(5).split('__').map((p) => ph('a', p)).join('__');
    return keep(s);
  };

  const out = events.map((e) => {
    const o = {};
    for (const [k, v] of Object.entries(e)) {
      keep(k);
      if (v === null || v === undefined) o[k] = v;
      else if (KEEP_FIELDS.has(k)) o[k] = Array.isArray(v) ? v.map(keep) : (typeof v === 'string' && keep(v), v);
      else if (ID_FIELDS.has(k)) o[k] = ph('id', String(v));
      else if (PATH_FIELDS.has(k)) o[k] = stripPath(v);
      else if (HASH_FIELDS.has(k)) o[k] = HEX.test(String(v)) ? ph('x', String(v)) : mask(v);
      else if (k === 'diff') o[k] = maskDiff(v);
      else if (TEXT_FIELDS.has(k)) o[k] = mask(v);
      else if (k === 'command') o[k] = stripCommand(v);
      else if (k === 'host') o[k] = ph('h', String(v));
      else if (k === 'target') o[k] = stripUrl(v);
      else if (k === 'tool_name') o[k] = stripToolName(v);
      else o[k] = stripValue(v);
    }
    return o;
  });
  return { events: out, kept };
}

/** The strings in a value (keys and string values), never its JSON text, whose escapes (\n) would fuse words. */
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.push(k), strings(x, out));
  return out;
}

/** Words (lower case, 3+ characters) in a value. */
function words(v, min = 3) {
  return strings(v)
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .flatMap((w) => [w, ...w.split(/[-_]/)])
    .filter((w) => w.length >= min);
}

function leakCheck(raw, stripped) {
  const privateWords = new Set();
  for (const e of raw) {
    for (const [k, v] of Object.entries(e)) {
      if (v === null || v === undefined || KEEP_FIELDS.has(k)) continue;
      for (const w of words(v)) privateWords.add(w);
    }
  }
  const out = new Set(words(stripped.events));
  // Not private: numbers, JSON's own literals, and runs of the mask character.
  const notPrivate = (w) => /^[0-9]+$/.test(w) || /^x+$/.test(w) || w === 'true' || w === 'false' || w === 'null';
  return [...privateWords].filter((w) => out.has(w) && !stripped.kept.has(w) && !notPrivate(w)).sort();
}

function summary(events) {
  const r = translateEvents(events, { sessionId: 'relevance-check' });
  const kinds = r.marks
    .map(({ mark: m }) => [m.source, m.says, m.target && m.target.kind, m.detail && m.detail.exit_status, m.detail && m.detail.read_kind].join('|'))
    .sort();
  return { marks: r.marks.length, rejects: r.rejects.length, kinds };
}

function relevance(raw, strippedEvents) {
  const a = summary(raw);
  const b = summary(strippedEvents);
  const same = a.marks === b.marks && a.rejects === b.rejects && a.kinds.join('\n') === b.kinds.join('\n');
  return { same, raw: { marks: a.marks, rejects: a.rejects }, stripped: { marks: b.marks, rejects: b.rejects } };
}

module.exports = { stripEvents, leakCheck, relevance };
