'use strict';

/**
 * redact.js
 *
 * Render-time privacy pass. The HTML report is the one artifact a user is likely
 * to SHARE (paste in an issue, send to a teammate, screenshot). The event log
 * itself stays complete and local; this only sanitises the *rendered* copy so a
 * shared report doesn't leak more than the user intends.
 *
 * Two independent transforms, applied to every path/command/host/free-text field
 * the renderers consume (reports + trail), on COPIES — the source models are
 * never mutated:
 *
 *   1. Home-prefix collapse (DEFAULT ON). An absolute path under the user's home
 *      directory (`/Users/jane/proj/x.js`, `C:\Users\jane\proj\x.js`) leaks the
 *      OS username. We collapse the home prefix to `~` so the structure stays
 *      readable but the identity doesn't ride along. Off via { home:false }.
 *
 *   2. User redaction list (OPT-IN). `.orunmila/redact` in the project root, same
 *      format as `.orunmila/ignore` (one path fragment per line, `#` comments,
 *      `!` un-redacts a default — there are no defaults here, so `!` is just
 *      ignored). Any artifact path matching the list (by the same segment-prefix
 *      rule the sentinel uses) is replaced with `[redacted]`, and any occurrence
 *      of a listed fragment inside a command/free-text string is masked too.
 *
 * This file does NOT read the event log or render anything — it is a pure
 * data->data transform so it's trivially testable and the renderers stay unaware
 * of it (they render whatever model they're handed).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isIgnored } = require('../capture/fs-sentinel/ignore');

const PLACEHOLDER = '[redacted]';

/**
 * Read the redaction list from <root>/.orunmila/redact. Same line format as
 * `.orunmila/ignore` (one path fragment per line, `#` comments). A leading `!`
 * has no defaults to un-redact here, so such lines are simply skipped. Missing
 * file is fine — redaction beyond the home-prefix collapse is opt-in.
 */
function readRedactList(root) {
  const file = path.join(root, '.orunmila', 'redact');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    out.push(line);
  }
  return out;
}

/** Escape a literal string for safe use inside a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a redactor for a given project root + options.
 *   opts.home   collapse the home-dir prefix to '~' (default true)
 *   opts.root   project root to read .orunmila/redact from (default process.cwd())
 * Returns { path, text, redactList } — `path` redacts a single path-like string,
 * `text` masks listed fragments inside a longer string, `redactList` is the
 * effective list (so callers can report what's being hidden, like status does
 * for ignore).
 */
function buildRedactor(opts = {}) {
  const home = opts.home !== false; // default on
  const root = opts.root || process.cwd();
  const homeDir = os.homedir();
  const redactList = readRedactList(root);

  // Collapse an absolute home-dir path to ~ (both separators, case-sensitive
  // path body but tolerant of the platform's slash).
  function collapseHome(s) {
    if (!home || !s || !homeDir) return s;
    // Normalise separators only for the comparison, preserve the original style.
    const sNorm = s.replace(/\\/g, '/');
    const hNorm = homeDir.replace(/\\/g, '/');
    if (sNorm === hNorm) return '~';
    if (sNorm.startsWith(hNorm + '/')) {
      return '~/' + sNorm.slice(hNorm.length + 1);
    }
    return s;
  }

  // A path-like field: collapse home, then redact wholesale if it matches the
  // user list. We test the home-collapsed form so a `~/secret/` entry can match.
  function redactPath(p) {
    if (p == null) return p;
    const collapsed = collapseHome(String(p));
    if (redactList.length) {
      // isIgnored wants a path relative-ish string; feed the collapsed path with
      // a leading ~/ stripped so segment matching lines up with how users write
      // entries (they write `secret/` not `~/secret/`).
      const probe = collapsed.replace(/^~\//, '').replace(/^\//, '');
      if (isIgnored(probe, redactList) || isIgnored(collapsed, redactList)) {
        return PLACEHOLDER;
      }
    }
    return collapsed;
  }

  // A free-text/command field: collapse any home prefixes that appear, then mask
  // any listed fragment that appears as a substring. Coarser than redactPath by
  // design (commands embed arbitrary text), but never leaks a listed secret path.
  function redactText(s) {
    if (s == null) return s;
    let out = String(s);
    if (home && homeDir) {
      // Replace bare home-dir occurrences anywhere in the string.
      const variants = [homeDir, homeDir.replace(/\\/g, '/')];
      for (const v of variants) {
        if (v) out = out.split(v).join('~');
      }
    }
    for (const frag of redactList) {
      const f = String(frag).replace(/\/+$/, '');
      if (!f) continue;
      // Mask the listed fragment AND the rest of the path it begins, so a
      // directory entry like `secret/` hides `secret/keys.js` (not just the
      // word "secret") wherever it appears inside a command. We swallow the
      // following non-whitespace, non-quote run — i.e. the rest of one path token.
      const re = new RegExp(escapeRe(f) + '[^\\s\'"|;&]*', 'g');
      out = out.replace(re, PLACEHOLDER);
    }
    return out;
  }

  return { path: redactPath, text: redactText, redactList };
}

// ---- model walkers: return sanitised COPIES, never mutate the input ----

function redactEvidence(ev, R) {
  const out = { ...ev };
  if (out.path != null) out.path = R.path(out.path);
  if (out.rel_path != null) out.rel_path = R.path(out.rel_path);
  if (out.command != null) out.command = R.text(out.command);
  if (out.host != null) out.host = R.text(out.host);
  if (out.target != null) out.target = R.text(out.target);
  return out;
}

function redactReports(reports, R) {
  return (reports || []).map((report) => ({
    ...report,
    claims: (report.claims || []).map((c) => ({
      ...c,
      claim: c.claim ? { ...c.claim, text: R.text(c.claim.text) } : c.claim,
      evidence: (c.evidence || []).map((e) => redactEvidence(e, R)),
    })),
    subtasks: (report.subtasks || []).map((s) => ({
      ...s,
      task: s.task ? { ...s.task, text: R.text(s.task.text) } : s.task,
      evidence: (s.evidence || []).map((e) => redactEvidence(e, R)),
    })),
    undisclosed: (report.undisclosed || []).map((u) => ({ ...u, path: R.path(u.path) })),
    untracked: (report.untracked || []).map((u) => ({
      ...u,
      path: u.path != null ? R.path(u.path) : u.path,
      rel_path: u.rel_path != null ? R.path(u.rel_path) : u.rel_path,
    })),
  }));
}

function redactTrail(trail, R) {
  if (!trail) return trail;
  return {
    ...trail,
    turns: (trail.turns || []).map((t) => ({
      ...t,
      prompt: t.prompt != null ? R.text(t.prompt) : t.prompt,
      trail: (t.trail || []).map((row) => {
        const path_ = row.path != null ? R.path(row.path) : row.path;
        const out = {
          ...row,
          path: path_,
          command: row.command != null ? R.text(row.command) : row.command,
          host: row.host != null ? R.text(row.host) : row.host,
          target: row.target != null ? R.text(row.target) : row.target,
        };
        // The trail row's `key` is the artifact key (the full path for files);
        // the visual layer falls back to it for a node's label, so redact it the
        // same way. A redacted file path collapses its key to the placeholder so
        // it can't resurface in the graph/tree under its raw key.
        if (out.key != null) out.key = path_ === PLACEHOLDER ? PLACEHOLDER : R.path(out.key);
        return out;
      }),
      edges: (t.edges || []).map((e) => ({ ...e, from: R.path(e.from), to: R.path(e.to) })),
      artifacts: (t.artifacts || []).map((a) => redactArtifact(a, R)),
    })),
    artifacts: (trail.artifacts || []).map((a) => redactArtifact(a, R)),
  };
}

function redactArtifact(a, R) {
  const out = { ...a };
  if (out.path != null) out.path = R.path(out.path);
  // key/label are display strings derived from the path; redact them the same way
  // so a redacted file doesn't reappear under its key in the graph/tree.
  if (out.path === PLACEHOLDER) {
    out.key = PLACEHOLDER;
    out.label = PLACEHOLDER;
  } else {
    if (out.key != null) out.key = R.path(out.key);
    if (out.label != null) out.label = R.text(out.label);
  }
  if (Array.isArray(out.touched_by)) out.touched_by = out.touched_by.map((t) => R.path(t));
  return out;
}

/**
 * Top-level convenience: sanitise both models with one redactor. Returns
 * { reports, trail, redactList } so the caller can render the safe copies and
 * tell the user what (if anything) was hidden.
 */
function redactForRender(reports, trail, opts = {}) {
  const R = buildRedactor(opts);
  return {
    reports: redactReports(reports, R),
    trail: redactTrail(trail, R),
    redactList: R.redactList,
  };
}

module.exports = { buildRedactor, readRedactList, redactReports, redactTrail, redactForRender, PLACEHOLDER };
