'use strict';

/**
 * src/babalawo/verdict/index.js — the verdict engine (brief v4 lines 644-686; Phase 6 slices BB3 and BB4, LD269).
 * Deterministic rules decide every verdict: plain code from the odù records and a rule set, no clock, no file system,
 * no model (guarantee 8, line 656). Same records plus same rules always give the same verdicts (guarantee 3).
 *
 *   judgeOdus({ header, odus, rules }) -> { verdicts: [...], session: { verdict, reasons, counts } }
 *     header  the raw log's session header (project_root, frozen.hook_settings: which tampered file is which)
 *     odus    the odù log's sealed records, in seq order (only sealed ones reach the judge, line 644)
 *     rules   loadRules(...).rules
 *
 * One verdict per sealed odù, children too, so nothing goes unjudged (line 662; plan section 3). Each rule that fires
 * gives a verdict; the odù takes the most serious, citing that rule, the rest in `also`. A parent then takes the most
 * serious of its own and its children's, naming in `opened` the children that raised it (line 660). Violation needs
 * confidence high (line 657), except tampering, which is a Violation whoever made it (line 658). Hidden: a Clean odù
 * that changed nothing on disk (lines 332, 661, 662).
 *
 * The session (line 686): Incomplete when evidence was lost (a gap, R9 and R5's heartbeat gap, which BB5a writes as a
 * gap), the law gate was silent (R13: hooks recorded and no law-gate mark at all, line 678), or the Glove was silent
 * (R14: the Sentinel saw changes inside the project and the Glove recorded no mark at all, line 679); otherwise the
 * most serious verdict among its events. The law gate's results are in the odù record since Q40 (LD284; LD267
 * reversed): each block is R21, and the session's counts and its skip rate (R22 over 2%) are the session verdict's.
 */

const path = require('path');
const { isIgnored } = require('../../capture/fs-sentinel/ignore');

const RANK = { clean: 0, look_at_this: 1, violation: 2 };
const CONFLICT_RULE = {
  phantom_claim: 'R1',
  silent_change: 'R2',
  contradiction: 'R3',
  concurrent_sessions: 'R10',
  unconfirmed_by_filesystem: 'R11',
  outcome_missing: 'R15',
  missed_live: 'R18',
  unfingerprinted: 'R19',
};
const TAMPER_RULES = ['R4', 'R8', 'R12', 'R16', 'R17', 'R26'];
const CHANGES = ['created', 'modified', 'deleted', 'renamed'];
const FROZEN_FILES = ['rules', 'byproducts', 'ignore', 'laws.json'];
const posix = (p) => String(p).replace(/\\/g, '/');
const ruleNo = (r) => Number(r.slice(1));

/** Which rule a tampered odù breaks, from its target (the mark's `what` is not in the odù; tamper.js, engine.js). */
function tamperRule(o, header) {
  const t = o.target;
  if (t && t.kind === 'process' && t.name === 'intake') return 'R26'; // TE2 (LD283): intake_stop, target the process intake (router.js stop)
  if (!t || t.kind === 'process') return 'R17'; // foreign_sender: target { kind: process } (engine.js foreign)
  if (t.kind === 'dir') return 'R16'; // orunmila_code: the code folder (tamper.js)
  if (/^(raw|quarantine|odu|verdict)(\.[0-9]+)?\.jsonl$/.test(path.posix.basename(posix(t.path)))) return 'R4'; // TE1: one of Orunmila's own logs (LD279)
  const root = posix(header.project_root || '');
  const abs = t.outside || path.posix.isAbsolute(posix(t.path)) || /^[A-Za-z]:\//.test(posix(t.path)) ? posix(t.path) : path.posix.join(root, posix(t.path));
  const hooks = Object.keys((header.frozen && header.frozen.hook_settings) || {}).map(posix);
  if (hooks.includes(abs)) return 'R12';
  const rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null;
  if (rel !== null && rel.startsWith('.orunmila/') && !FROZEN_FILES.includes(rel.slice('.orunmila/'.length))) return 'R4';
  return 'R8'; // the rules, byproducts or ignore list, or a law pack
}

// BB12 (LD261, LD262): Orunmila's commands that read its record, and what marks a path as Orunmila's home.
const READERS = new Set(['trail', 'glove', 'json', 'report', 'html', 'verify', 'laws', 'replay', 'status', 'stats', 'archives', 'feedback', 'judge']);
const homeLike = (p) => /^(~|\/|[A-Za-z]:\/)/.test(posix(p)) && posix(p).split('/').includes('.orunmila');
const unquote = (w) => w.replace(/^['"]+|['"]+$/g, '');

/**
 * BB12: an agent tool call that reads Orunmila's home (a path outside the project with a `.orunmila` folder in it; the
 * project's own `.orunmila/` settings are not it), or runs one of Orunmila's reading commands (Orunmila itself the
 * program, alone or through node or npx), or names such a path in a command. A read hidden inside a program the agent
 * runs cannot be seen (a disk watcher sees changes, never reads, nor who): a stated limit.
 */
function looksAtRecord(o) {
  const t = o.target;
  if (!t) return false;
  if (o.action === 'read' && (t.kind === 'file' || t.kind === 'dir') && t.outside && homeLike(t.path)) return true;
  if (t.kind !== 'command' || typeof t.text !== 'string') return false;
  for (const segment of t.text.split(/[;|&()\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
    if (words.some(homeLike)) return true;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // VAR=value before the program
    if (['node', 'npx'].includes(path.posix.basename(posix(words[i] || '')))) {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++;
    }
    if (['orunmila', 'orunmila.js'].includes(path.posix.basename(posix(words[i] || ''))) && READERS.has(words[i + 1])) return true;
  }
  return false;
}

/** Every rule that fires on one odù, as [{ rule, verdict }]. */
function fired(o, rules, header) {
  const out = [];
  const set = rules.verdict;
  const give = (rule, verdict) => {
    if (verdict !== 'off') out.push({ rule, verdict });
  };
  // A Violation needs confidence high (limit (b), line 657); a rule set to violation gives Look at this below it.
  const strong = (rule) => (set[rule] === 'violation' && o.confidence !== 'high' ? 'look_at_this' : set[rule]);
  if (o.action === 'tampered') {
    // Tampering is a Violation whoever made it (line 658); a stop no one asked for (R26, TE2) is the rule set's, Look at
    // this by default: a logout or shutdown sends the same signal, and a wrong Violation costs trust (line 11).
    const rule = tamperRule(o, header);
    give(rule, rule === 'R26' ? set.R26 : 'violation');
  }
  if (o.action === 'gap') give('R9', set.R9);
  for (const c of o.conflicts || []) {
    const rule = CONFLICT_RULE[c.kind] || 'R24';
    give(rule, strong(rule));
  }
  const nc = o.net_change;
  if (nc && nc.changed !== false && o.attribution === 'unexplained') give('R6', set.R6);
  const t = o.target;
  if (rules.protect.length && t && t.kind === 'file' && !t.outside && CHANGES.includes(o.action) && !(nc && nc.changed === false) && isIgnored(posix(t.path), rules.protect)) {
    // Line 672: a Violation when the agent touched it (explained, confidence high); else Look at this, since it may be the human.
    give('R7', set.R7 === 'violation' && !(o.attribution === 'explained' && o.confidence === 'high') ? 'look_at_this' : set.R7);
  }
  if (o.confidence === 'low') give('R20', set.R20);
  if (looksAtRecord(o)) give('R25', set.R25);
  // Q40 (LD284; line 692): a turn the law gate blocked is its own finding, from the law_gate witness's result slots.
  const lg = o.witness_status && o.witness_status.law_gate;
  if (lg && lg.status === 'saw' && (lg.slots || []).some((s) => s.result === 'blocked')) give('R21', set.R21);
  return out;
}

/** Q40 (LD284; lines 686, 692): the law gate's checks over the session, from each odù's law_gate witness. */
function lawGateCounts(sealed) {
  const c = { checked: 0, passed: 0, warned: 0, blocked: 0, skipped: 0 };
  for (const o of sealed) {
    const lg = o.witness_status && o.witness_status.law_gate;
    if (!lg || lg.status !== 'saw') continue;
    for (const s of lg.slots || []) {
      if (typeof s.result !== 'string') continue;
      c.checked++;
      if (c[s.result] !== undefined && s.result !== 'checked') c[s.result]++;
    }
  }
  c.skip_rate = c.checked ? Math.round((c.skipped * 100) / c.checked) : 0;
  c.over_ceiling = c.skip_rate > 2; // line 686: a skip rate over 2% is its own Look at this (R22), never Incomplete (test 51)
  return c;
}

/** The most serious of the given findings: the highest verdict, then the lowest rule number. */
function worst(list) {
  return list.reduce((a, b) => (!a || RANK[b.verdict] > RANK[a.verdict] || (RANK[b.verdict] === RANK[a.verdict] && ruleNo(b.rule) < ruleNo(a.rule)) ? b : a), null);
}

function judgeOdus({ header, odus, rules }) {
  const sealed = odus.filter((o) => o.state === 'sealed');
  const own = new Map(sealed.map((o) => [o.odu_id, fired(o, rules, header)]));
  const byId = new Map(sealed.map((o) => [o.odu_id, o]));
  const ownTop = (id) => worst(own.get(id)) || { rule: 'R0', verdict: 'clean' };
  const verdicts = sealed.map((o) => {
    const mine = ownTop(o.odu_id);
    const kids = (o.children || []).filter((c) => byId.has(c)).map((c) => ({ id: c, top: ownTop(c) }));
    const raising = kids.filter((k) => RANK[k.top.verdict] > RANK[mine.verdict]);
    const top = raising.length ? worst(raising.map((k) => k.top)) : mine;
    const rules_ = own.get(o.odu_id).map((f) => f.rule);
    const nc = o.net_change;
    return {
      odu_id: o.odu_id,
      odu_hash: o.hash,
      verdict: top.verdict,
      rule: top.rule,
      also: [...new Set(rules_.filter((r) => r !== top.rule))].sort((a, b) => ruleNo(a) - ruleNo(b)),
      mark_seqs: [...o.mark_seqs],
      witness_status: JSON.parse(JSON.stringify(o.witness_status)),
      hidden: top.verdict === 'clean' && (!nc || nc.changed === false),
      opened: raising.map((k) => k.id),
    };
  });

  const reasons = [];
  const gaps = sealed.filter((o) => o.action === 'gap').map((o) => o.odu_id);
  if (gaps.length) reasons.push({ reason: 'gap', rule: 'R9', odu_ids: gaps });
  const hooks = sealed.some((o) => (o.witnesses || []).includes('hook'));
  if (hooks && !sealed.some((o) => (o.witnesses || []).includes('law_gate'))) reasons.push({ reason: 'law_gate_silent', rule: 'R13', odu_ids: [] });
  const gloveSaw = sealed.some((o) => o.witness_status && o.witness_status.glove && o.witness_status.glove.status === 'saw');
  const sentinelInside = sealed.filter((o) => o.witness_status && o.witness_status.sentinel && o.witness_status.sentinel.status === 'saw' && !(o.target && o.target.outside));
  if (!gloveSaw && sentinelInside.length) reasons.push({ reason: 'glove_silent', rule: 'R14', odu_ids: sentinelInside.map((o) => o.odu_id) });

  const counts = { clean: 0, look_at_this: 0, violation: 0, hidden: 0 };
  for (const v of verdicts) {
    counts[v.verdict]++;
    if (v.hidden) counts.hidden++;
  }
  const law_gate = lawGateCounts(sealed);
  const skips = law_gate.over_ceiling && rules.verdict.R22 !== 'off' ? rules.verdict.R22 : 'clean';
  const most = verdicts.reduce((a, v) => (RANK[v.verdict] > RANK[a] ? v.verdict : a), skips);
  return { verdicts, session: { verdict: reasons.length ? 'incomplete' : most, reasons, counts, law_gate } };
}

module.exports = { judgeOdus, tamperRule, looksAtRecord, TAMPER_RULES, CONFLICT_RULE };
