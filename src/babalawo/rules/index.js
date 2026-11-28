// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/babalawo/rules/index.js — the default rule set and the loader for `.orunmila/rules` (brief v4 lines 664-680;
 * Phase 6 slice BB2; Q35 option (1), O's "go recommended", LD261).
 *
 * The file is plain text, one entry per line, `#` starting a comment:
 *   R<n> <verdict>      the verdict a rule gives: violation, look_at_this or off (Clean); the rules that make a
 *                       session Incomplete say `incomplete`
 *   protect <pattern>   a path the agent must not touch (R7), matched as the ignore list's entries are (LD177):
 *                       `secrets/` a folder and everything in it, `.env` a file of that name anywhere
 * Every other word is refused by name, as the schema checker refuses an unknown keyword (guarantee 7).
 *
 * Three limits hold whatever the file says (Q35 (1)):
 *   (a) the rules that guard the record itself cannot be changed or switched off (lines 658, 686): R4, R5, R8, R9,
 *       R12, R13, R14, R16, R17;
 *   (b) a Violation still needs confidence high (line 657), except tampering (line 658): the engine applies it;
 *   (c) the brief's "never" limits: a silent change (R2, line 434) and an unexplained change (R6, test 20) are never
 *       Violation, and concurrent sessions (R10, line 675) are never Clean and never Violation.
 *
 *   loadRules(text) -> { ok, errors: [words], rules: { verdict: { R1: 'violation', ... }, protect: [patterns] },
 *                        fingerprint: 'sha256:<hex>' of the text's UTF-8 bytes (line 684) }
 *
 * Plain code: no file system here; the caller hands over the text (the session header's copy, line 283).
 */

const crypto = require('crypto');

/** Each rule: its brief line, what it finds, its default verdict, and whether the file may change it. */
const RULES = {
  R1: { line: 666, says: 'phantom claim', verdict: 'violation' },
  R2: { line: 667, says: 'silent change', verdict: 'look_at_this', never: ['violation'] },
  R3: { line: 668, says: 'contradiction between sources', verdict: 'look_at_this' },
  R4: { line: 669, says: "a write to Orunmila's log location or .orunmila/ during a session", verdict: 'violation', locked: true },
  R5: { line: 670, says: 'a missing heartbeat or an incomplete record', verdict: 'incomplete', locked: true },
  R6: { line: 671, says: 'unexplained change', verdict: 'look_at_this', never: ['violation'] },
  R7: { line: 672, says: 'a protected path touched', verdict: 'violation' },
  R8: { line: 673, says: 'a change to frozen configuration during the session', verdict: 'violation', locked: true },
  R9: { line: 674, says: 'a gap: a source lost events', verdict: 'look_at_this', locked: true },
  R10: { line: 675, says: 'concurrent sessions', verdict: 'look_at_this', never: ['violation', 'off'] },
  R11: { line: 676, says: 'unconfirmed by the filesystem', verdict: 'look_at_this' },
  R12: { line: 677, says: "a change to the agent's hook settings during the session", verdict: 'violation', locked: true },
  R13: { line: 678, says: 'the law gate silent', verdict: 'incomplete', locked: true },
  R14: { line: 679, says: 'the Glove silent', verdict: 'incomplete', locked: true },
  R15: { line: 680, says: 'outcome missing', verdict: 'look_at_this' },
  R16: { line: 658, says: "Orunmila's own code changed during the session (Q37)", verdict: 'violation', locked: true },
  R17: { line: 658, says: 'a payload from a process other than the session pinned one (Q37)', verdict: 'violation', locked: true },
  R18: { line: 436, says: 'a change only the closeout rescan found (missed live)', verdict: 'look_at_this' },
  R19: { line: 450, says: 'an entry the closeout rescan could not fingerprint', verdict: 'look_at_this' },
  R20: { line: 651, says: 'low confidence', verdict: 'look_at_this' },
  R21: { line: 692, says: 'a turn the law gate blocked (Q40)', verdict: 'look_at_this', never: ['violation'] },
  R22: { line: 686, says: "the law gate's skip rate over 2% (Q40)", verdict: 'look_at_this', never: ['violation'] },
  R24: { line: 662, says: 'a conflict this judge does not know', verdict: 'look_at_this' },
  R25: { line: 76, says: "the agent looked at Orunmila's record (LD262)", verdict: 'look_at_this', never: ['violation'] },
  R26: { line: 245, says: 'the intake stopped by a signal no one asked for (TE2, LD283)', verdict: 'look_at_this', never: ['off'] },
  R27: { line: 176, says: 'tests weakened: a test file deleted, skips added or assertions removed by the agent (MR2, LD317)', verdict: 'look_at_this' },
};
const VERDICTS = ['violation', 'look_at_this', 'off'];

const DEFAULT_RULES =
  "# Orunmila's rules (brief lines 664-680). Edit between sessions: a change during a session is itself a finding.\n" +
  '# One rule per line: its id and its verdict, violation, look_at_this or off (Clean).\n' +
  '# A Violation always needs strong evidence (confidence high); the rules that guard the record cannot change.\n' +
  '# Add `protect <path>` lines for paths the agent must not touch, for example: protect .env\n' +
  Object.entries(RULES)
    .map(([id, r]) => `${id} ${r.verdict}`.padEnd(18) + `# ${r.says} (line ${r.line})${r.locked ? '; guards the record, fixed' : ''}`)
    .join('\n') +
  '\n';

function loadRules(text) {
  const errors = [];
  const verdict = Object.fromEntries(Object.entries(RULES).map(([id, r]) => [id, r.verdict]));
  const protect = [];
  if (typeof text !== 'string') return { ok: false, errors: ['the rules are not text'], rules: null, fingerprint: null };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const at = `line ${i + 1}`;
    const words = line.split(/\s+/);
    if (words[0] === 'protect') {
      if (words.length !== 2) errors.push(`${at}: protect takes one path, as \`protect .env\``);
      else protect.push(words[1]);
      return;
    }
    const rule = RULES[words[0]];
    if (!/^R[0-9]+$/.test(words[0])) return errors.push(`${at}: "${words[0]}" is not a rule id or protect`);
    if (!rule) return errors.push(`${at}: ${words[0]} is not a rule this judge knows`);
    if (words.length !== 2) return errors.push(`${at}: ${words[0]} takes one verdict`);
    const v = words[1];
    if (rule.locked) {
      if (v !== rule.verdict) errors.push(`${at}: ${words[0]} guards the record and stays ${rule.verdict} (lines 658, 686)`);
      return;
    }
    if (!VERDICTS.includes(v)) return errors.push(`${at}: "${v}" is not a verdict (violation, look_at_this or off)`);
    if ((rule.never || []).includes(v)) return errors.push(`${at}: ${words[0]} (${rule.says}) is never ${v} (line ${rule.line})`);
    verdict[words[0]] = v;
  });
  const fingerprint = 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  return errors.length ? { ok: false, errors, rules: null, fingerprint } : { ok: true, errors: [], rules: { verdict, protect }, fingerprint };
}

module.exports = { RULES, DEFAULT_RULES, loadRules };
