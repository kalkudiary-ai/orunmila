'use strict';

/**
 * scripts/turbo/plan.js — TURBO's plan: the Leopard test list as data, and the
 * queue of what needs O (LD108).
 *
 * The plan lives in <TURBO_HOME>/plan.json (default: .turbo/ in this repo,
 * gitignored). Every save also writes approvals.md, the queue for O to read; O
 * answers in inbox.md, and a session applies the answer with `answer`.
 *
 * A slice: { id, title, phase, kind: strike|closeout|evidence-fix, test, depends_on[],
 *            blocked_by[], status: todo|done|dropped, session, commits[], notes[] }
 * A queue item: { id: Q<n>, slice, kind, title, ask, blocking, phase,
 *                 status: open|answered, answer, opened, answered_at }
 *
 * The next slice is the first todo slice, in list order, whose dependencies
 * are all done and which no open blocking item holds. So work goes around
 * whatever waits on O, and a slice that depends on held work waits with it.
 *
 *   node scripts/turbo/plan.js show | next | counts | validate
 *   node scripts/turbo/plan.js add '<slice json>' [--front]
 *   node scripts/turbo/plan.js status <id> <todo|done|dropped> [--session s] [--commit sha]...
 *   node scripts/turbo/plan.js note <id> '<text>'
 *   node scripts/turbo/plan.js queue '<item json>'      prints the new item's id
 *   node scripts/turbo/plan.js answer <Q-id> '<text>'
 *
 * Exit 0 on success, 1 when validate finds errors, 2 on a usage error.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STATUSES = ['todo', 'done', 'dropped'];
const KINDS = ['strike', 'closeout', 'evidence-fix'];

function home() {
  return process.env.TURBO_HOME || path.join(ROOT, '.turbo');
}

function empty() {
  return { version: 1, slices: [], queue: [] };
}

function find(p, id) {
  return p.slices.find((s) => s.id === id) || null;
}

function item(p, id) {
  return p.queue.find((q) => q.id === id) || null;
}

function normalise(s) {
  if (!s || typeof s.id !== 'string' || !s.id) throw new Error('a slice needs a string id');
  return {
    id: s.id,
    title: s.title || '',
    phase: s.phase === undefined || s.phase === null ? null : String(s.phase),
    kind: s.kind || 'strike',
    test: s.test || null,
    depends_on: Array.isArray(s.depends_on) ? [...s.depends_on] : [],
    blocked_by: Array.isArray(s.blocked_by) ? [...s.blocked_by] : [],
    status: s.status || 'todo',
    session: s.session || null,
    commits: Array.isArray(s.commits) ? [...s.commits] : [],
    notes: Array.isArray(s.notes) ? [...s.notes] : [],
  };
}

function addSlice(p, s, { front = false } = {}) {
  const n = normalise(s);
  if (find(p, n.id)) throw new Error(`duplicate slice id ${n.id}`);
  if (front) p.slices.unshift(n);
  else p.slices.push(n);
  return n;
}

function setStatus(p, id, status, { session, commits } = {}) {
  const s = find(p, id);
  if (!s) throw new Error(`unknown slice ${id}`);
  if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
  s.status = status;
  if (session) s.session = session;
  if (commits && commits.length) s.commits.push(...commits);
  return s;
}

function isHeld(p, s) {
  return s.blocked_by.some((qid) => {
    const q = item(p, qid);
    return q && q.status === 'open' && q.blocking !== false;
  });
}

function eligible(p, s) {
  if (s.status !== 'todo' || isHeld(p, s)) return false;
  return s.depends_on.every((d) => {
    const dep = find(p, d);
    return dep && dep.status === 'done';
  });
}

function next(p) {
  return p.slices.find((s) => eligible(p, s)) || null;
}

function counts(p) {
  const todo = p.slices.filter((s) => s.status === 'todo');
  return {
    todo: todo.length,
    eligible: todo.filter((s) => eligible(p, s)).length,
    blocked: todo.filter((s) => !eligible(p, s)).length,
    done: p.slices.filter((s) => s.status === 'done').length,
    dropped: p.slices.filter((s) => s.status === 'dropped').length,
    open_items: p.queue.filter((q) => q.status === 'open').length,
  };
}

/** Add an item for O. A blocking item with a slice holds that slice. Returns its id. */
function queueItem(p, { slice = null, kind, title, ask, blocking = true, phase = null, session = null }) {
  if (!kind || !title || !ask) throw new Error('a queue item needs kind, title and ask');
  if (slice && !find(p, slice)) throw new Error(`unknown slice ${slice}`);
  const id = `Q${p.queue.length + 1}`;
  p.queue.push({
    id,
    slice,
    kind,
    title,
    ask,
    blocking: blocking !== false,
    phase: phase === null || phase === undefined ? null : String(phase),
    session,
    status: 'open',
    answer: null,
    opened: new Date().toISOString(),
    answered_at: null,
  });
  if (slice && blocking !== false) find(p, slice).blocked_by.push(id);
  return id;
}

function answer(p, qid, text) {
  const q = item(p, qid);
  if (!q) throw new Error(`unknown queue item ${qid}`);
  q.status = 'answered';
  q.answer = String(text);
  q.answered_at = new Date().toISOString();
  return q;
}

/**
 * The open phase-report item an earlier phase left, which this slice's work
 * rests on (LD111), or null. Phases compare as numbers when both are numbers.
 */
function provisional(p, s) {
  if (!s || s.phase === null) return null;
  const before = (a, b) => {
    const x = Number(a);
    const y = Number(b);
    return Number.isFinite(x) && Number.isFinite(y) ? x < y : a < b;
  };
  const q = p.queue.find((x) => x.kind === 'phase-report' && x.status === 'open' && x.phase !== null && before(x.phase, s.phase));
  return q ? q.id : null;
}

function validate(p) {
  const errs = [];
  const ids = new Set();
  for (const s of p.slices) {
    if (ids.has(s.id)) errs.push(`duplicate slice id ${s.id}`);
    ids.add(s.id);
    if (!STATUSES.includes(s.status)) errs.push(`slice ${s.id}: bad status ${s.status}`);
    if (s.kind && !KINDS.includes(s.kind)) errs.push(`slice ${s.id}: bad kind ${s.kind}`);
  }
  for (const s of p.slices) {
    for (const d of s.depends_on || []) if (!ids.has(d)) errs.push(`slice ${s.id}: unknown dependency ${d}`);
    for (const q of s.blocked_by || []) if (!item(p, q)) errs.push(`slice ${s.id}: unknown queue item ${q}`);
  }
  // A cycle would hold every slice on it forever; name it instead.
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      errs.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    const s = find(p, id);
    for (const d of (s && s.depends_on) || []) if (ids.has(d)) visit(d, [...trail, id]);
    state.set(id, 'done');
  };
  for (const s of p.slices) visit(s.id, []);
  return errs;
}

function load(dir = home()) {
  const file = path.join(dir, 'plan.json');
  if (!fs.existsSync(file)) return empty();
  // A session can write TURBO_HOME; the unsandboxed driver must not read or write through its links (LD117).
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; TURBO does not follow it`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function renderApprovals(p) {
  const open = p.queue.filter((q) => q.status === 'open');
  const done = p.queue.filter((q) => q.status !== 'open');
  const out = [
    '# TURBO approvals',
    '',
    '*Written by scripts/turbo/plan.js on every plan change; do not edit. To answer, write in',
    '`inbox.md` beside this file (for example "Q3: yes"). The next session applies it.*',
    '',
    `## Open (${open.length})`,
    '',
  ];
  if (!open.length) out.push('None.', '');
  for (const q of open) {
    out.push(`### ${q.id} · ${q.kind}${q.blocking ? ' · blocking' : ''} · ${q.title}`);
    out.push('', `Slice: ${q.slice || '(none)'} · phase ${q.phase || '-'} · opened ${q.opened}${q.session ? ` · session ${q.session}` : ''}`, '', q.ask, '');
  }
  out.push(`## Answered (${done.length})`, '');
  for (const q of done) out.push(`- **${q.id}** ${q.title}: ${q.answer} (${q.answered_at})`);
  return out.join('\n') + '\n';
}

/** Validate, then write plan.json and approvals.md (each by temp file and rename). */
function save(dir, p) {
  const errs = validate(p);
  if (errs.length) throw new Error(`plan not saved: ${errs.join('; ')}`);
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => {
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    // Remove whatever is there (a planted symlink included), then create it exclusively.
    try {
      fs.unlinkSync(tmp);
    } catch {}
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, path.join(dir, name));
  };
  put('plan.json', JSON.stringify(p, null, 2) + '\n');
  put('approvals.md', renderApprovals(p));
}

// --- CLI -----------------------------------------------------------------------

function main(argv) {
  const dir = home();
  const [cmd, ...rest] = argv;
  const flag = (name) => {
    const vals = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === name && i + 1 < rest.length) vals.push(rest[++i]);
    return vals;
  };
  const p = load(dir);
  try {
    switch (cmd) {
      case 'show':
        process.stdout.write(JSON.stringify(p, null, 2) + '\n');
        return 0;
      case 'next':
        process.stdout.write(JSON.stringify(next(p)) + '\n');
        return 0;
      case 'counts':
        process.stdout.write(JSON.stringify(counts(p)) + '\n');
        return 0;
      case 'validate': {
        const errs = validate(p);
        for (const e of errs) process.stdout.write(e + '\n');
        process.stdout.write(`${errs.length} error(s)\n`);
        return errs.length ? 1 : 0;
      }
      case 'add':
        addSlice(p, JSON.parse(rest[0]), { front: rest.includes('--front') });
        break;
      case 'status':
        setStatus(p, rest[0], rest[1], { session: flag('--session')[0], commits: flag('--commit') });
        break;
      case 'note': {
        const s = find(p, rest[0]);
        if (!s) throw new Error(`unknown slice ${rest[0]}`);
        s.notes.push(String(rest[1]));
        break;
      }
      case 'queue': {
        const id = queueItem(p, JSON.parse(rest[0]));
        save(dir, p);
        process.stdout.write(id + '\n');
        return 0;
      }
      case 'answer':
        answer(p, rest[0], rest[1]);
        break;
      default:
        throw new Error(`unknown command: ${cmd || '(none)'}`);
    }
  } catch (err) {
    process.stderr.write(`turbo plan: ${err.message}\n`);
    return 2;
  }
  save(dir, p);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { empty, find, item, addSlice, setStatus, next, eligible, counts, queueItem, answer, provisional, validate, load, save, renderApprovals, home };
