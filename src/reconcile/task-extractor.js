'use strict';

/**
 * task-extractor.js
 *
 * Forensic gap #3: agents rarely lie about a dropped requirement, they just
 * stop mentioning it. If reconciliation only checks "claim vs diff", a
 * silently-dropped third of a three-part ask never gets caught, because no
 * false claim was ever made about it. So we also parse the *original ask*
 * into subtasks, independent of what the agent later says it did.
 *
 * This is intentionally a simple heuristic splitter, not an NLP pipeline.
 *
 * Targets (what a sentence is "about") are TYPED, not flat strings, so the
 * matcher can compare like with like instead of doing blind substring
 * matching (which credited any .js write to any .js claim). See
 * review/EXTRACTOR_DESIGN.md.
 *
 *   kind "path"    - a file path/basename: login.js, src/auth.ts, README
 *   kind "symbol"  - an identifier: getUser, rate_limit, DashboardView
 *   kind "phrase"  - a plain-english noun phrase: "user authentication"
 *   kind "literal" - a quoted string, matched verbatim
 */

const { sanitize } = require('./sanitize');

// Split a multi-part ask into subtasks. Bullets/numbered lists first; then
// comma/conjunction splitting as a fallback. The comma case matters: "do A,
// do B, and do C" must become three items, not two.
const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

// Connectors that separate subtasks. The trailing comma-list rule splits on a
// plain comma followed by a lowercase clause so "add X, write Y, and update Z"
// segments fully (the old regex only split on ", and ...", missing ", write").
const SPLIT_CONNECTORS =
  /(?:,?\s+and\s+also\s+|,?\s+and\s+then\s+|,?\s+then\s+|;\s+|\.\s+(?=[A-Z])|,?\s+and\s+|,\s+(?=[a-z]))/g;

const WELL_KNOWN_FILES = ['readme', 'dockerfile', 'makefile', 'license', '.gitignore', '.env'];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'to', 'for', 'of', 'in', 'on', 'with', 'please',
  'can', 'you', 'also', 'some', 'it', 'this', 'that', 'into', 'from', 'by',
  'as', 'at', 'or', 'so', 'then', 'just', 'make', 'sure', 'all', 'any',
]);

const ACTION_VERBS_FOR_PHRASE = [
  'add', 'added', 'implement', 'implemented', 'create', 'created', 'write',
  'wrote', 'fix', 'fixed', 'update', 'updated', 'refactor', 'refactored',
  'remove', 'removed', 'delete', 'deleted', 'configure', 'configured',
  'support', 'handle', 'build', 'optimize', 'optimized', 'enable',
];

// A real subtask sentence has a verb of intent OR a concrete target. Pure
// status pastes ("9 passed, 0 failed", task-notification XML, npm error
// stacks) would otherwise be reified into subtasks the agent then gets
// graded for "silently dropping". See review/DOGFOOD_*.md.
const INTENT_VERB_RE = new RegExp(
  String.raw`\b(?:${ACTION_VERBS_FOR_PHRASE.join('|')}|build|builds|ship|ships|publish|publishes|test|tests|run|runs|need|needs|should|must|please|make|makes|set|sets|do|does|tweak|tweaks|cover|covers|raise|raises|address|addresses|check|checks|verify|verifies|investigate|investigates|use|uses|enforce|enforces)\b`,
  'i'
);

function looksLikeIntent(text) {
  if (!text) return false;
  if (INTENT_VERB_RE.test(text)) return true;
  // A short bare noun phrase that names a file or component is also OK as a
  // subtask — "the dashboard", "src/auth.js" — but only when it has at least
  // one extractable target. We let the caller's target extraction decide.
  return extractTargets(text).length > 0;
}

function extractSubtasks(promptText) {
  if (!promptText || !promptText.trim()) return [];

  const cleaned = sanitize(promptText);
  if (!cleaned.trim()) return [];

  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const bulletItems = lines.map((l) => l.match(BULLET_LINE)).filter(Boolean).map((m) => m[1].trim());

  let raw;
  if (bulletItems.length >= 2) {
    raw = bulletItems;
  } else {
    raw = cleaned
      .split(SPLIT_CONNECTORS)
      .map((s) => s.trim())
      .filter((s) => s.length > 3);
  }

  // Drop fragments that aren't plausibly an intent: a leftover sentence
  // with no verb-of-intent and no concrete target is almost always a noise
  // line that survived sanitize (e.g. a quoted greeting, a header word).
  raw = raw.filter(looksLikeIntent);

  return raw.map((text, i) => ({
    id: `task${i + 1}`,
    text,
    targets: extractTargets(text),
  }));
}

// --- typed target extraction -------------------------------------------------

const PATH_RE = /(?:[\w./-]*\/)?[\w-]+\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|json|md|yml|yaml|css|html|sql|sh|toml)\b/gi;
const CODESPAN_RE = /`([^`]+)`/g;
const DQUOTE_RE = /"([^"]+)"/g;
const SQUOTE_RE = /'([^']+)'/g;
const CAMEL_RE = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g;
const PASCAL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g;
const SNAKE_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

function basename(p) {
  // Split on both separators so a Windows path (src\foo.js) yields foo.js too.
  return String(p).split(/[\\/]/).pop();
}

function pushUnique(arr, target) {
  if (!arr.some((t) => t.kind === target.kind && t.value === target.value)) arr.push(target);
}

/**
 * Returns typed targets. Crucially: a path token keeps its FULL basename as the
 * value (login.js), never the bare extension (js) the old code produced.
 */
function extractTargets(text) {
  if (!text) return [];
  const targets = [];
  let m;

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    pushUnique(targets, { kind: 'path', value: basename(m[0]).toLowerCase(), raw: m[0] });
  }

  // Extension-less well-known files referenced by name.
  const lower = text.toLowerCase();
  for (const name of WELL_KNOWN_FILES) {
    const re = new RegExp(`\\b${name.replace('.', '\\.')}\\b`, 'i');
    if (re.test(lower)) pushUnique(targets, { kind: 'path', value: name, raw: name });
  }

  for (const re of [CODESPAN_RE, DQUOTE_RE, SQUOTE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const v = (m[1] || '').trim();
      if (v) pushUnique(targets, { kind: 'literal', value: v.toLowerCase(), raw: v });
    }
  }

  for (const re of [CAMEL_RE, PASCAL_RE, SNAKE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      pushUnique(targets, { kind: 'symbol', value: m[0].toLowerCase(), raw: m[0] });
    }
  }

  // Phrase extraction: after an action verb, grab the next 1-3 content words.
  // This is what gives plain-english asks ("implement user authentication")
  // something to match against, instead of extracting nothing.
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (ACTION_VERBS_FOR_PHRASE.includes(w)) {
      const phrase = [];
      for (let j = i + 1; j < words.length && phrase.length < 3; j++) {
        const cw = words[j].toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!cw || STOPWORDS.has(cw)) {
          if (phrase.length) break;
          continue;
        }
        phrase.push(cw);
      }
      if (phrase.length) pushUnique(targets, { kind: 'phrase', value: phrase.join(' '), raw: phrase.join(' ') });
    }
  }

  return targets;
}

// Backwards-compatible shim: some call sites only need the flat values.
function extractKeywords(text) {
  return extractTargets(text).map((t) => t.value);
}

module.exports = { extractSubtasks, extractTargets, extractKeywords, basename };
