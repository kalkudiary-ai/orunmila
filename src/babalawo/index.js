'use strict';

/**
 * src/babalawo/index.js — Babaláwo, the judge, behind one interface (brief v4 lines 642-697, 682; Phase 6 slices
 * BB2-BB4, LD269). A stricter judge can replace it by name without touching the Ọpọ́n (line 682; BB11).
 *
 *   name, version         the judge's own, written into the verdict log's header and every session verdict
 *   loadRules(text)       src/babalawo/rules: the rules file read, or refused by name
 *   judge({ header, oduText, rulesText?, prior? })
 *       -> { ok: true, records, added, text } | { ok: false, words }
 *     header    the raw log's session header; its config.rules, the rules file as it was at session start, judges
 *               the session (line 283); with none, the default rules
 *     oduText   the odù log's text: it must verify as a hash chain, or nothing is judged (guarantee 7)
 *     rulesText a rules file named for a re-judgement (`orunmila judge --rules`), instead of the header's
 *     prior     the verdict log's records so far (a re-judgement, or a closeout after a resumed session): each new
 *               verdict that differs from the odù's latest is appended and `supersedes` it; an unchanged one is not
 *               written again; old verdicts are never edited (line 684)
 *     records   the whole log after it; added, the records this judgement wrote; text, the whole log's lines
 *
 * The judge reads the odù log only, never the raw log, and writes only its own log (line 644). Plain code: the caller
 * reads and writes files.
 */

const { verifyText, seal } = require('../verify/chain');
const { canonicalize } = require('../verify/canonical');
const { loadRules, DEFAULT_RULES } = require('./rules');
const { judgeOdus } = require('./verdict');

const NAME = 'babalawo';
const VERSION = '1.0.0';
const vid = (n) => `v_${String(n).padStart(4, '0')}`;
const same = (a, b) => canonicalize(a) === canonicalize(b);

function judge({ header, oduText, rulesText, prior = [] }) {
  const chain = verifyText(oduText || '');
  if (!chain.ok) return { ok: false, words: `Not judged: the odù log is broken at line ${chain.line} (${chain.reason}), and the judge never judges an altered record.` };
  const odus = oduText.split('\n').slice(0, -1).map((l) => JSON.parse(l));
  const head = odus[0];
  if (head.record !== 'odu_header' || head.session_id !== header.session_id) return { ok: false, words: 'Not judged: the odù log does not begin with this session\'s odù header.' };
  const fromHeader = header.config && typeof header.config.rules === 'string';
  const source = typeof rulesText === 'string' ? 'file' : fromHeader ? 'header' : 'default';
  const text = source === 'file' ? rulesText : source === 'header' ? header.config.rules : DEFAULT_RULES;
  const loaded = loadRules(text);
  if (!loaded.ok) return { ok: false, words: `Not judged: the rules (${source === 'header' ? 'from the session header' : source === 'file' ? 'the file named' : 'the defaults'}) could not be read: ${loaded.errors.join('; ')}.` };

  const { verdicts, session } = judgeOdus({ header, odus: odus.slice(1).filter((o) => o.record === 'odu'), rules: loaded.rules });

  const records = prior.map((r) => ({ ...r }));
  if (records.length && (records[0].record !== 'verdict_header' || records[0].odu_header !== head.hash)) return { ok: false, words: 'Not judged: the verdict log so far does not belong to this odù log.' };
  const held = new Map(odus.slice(1).map((o) => [o.odu_id, o.hash]));
  const stray = records.find((r) => r.record === 'verdict' && held.get(r.odu_id) !== r.odu_hash);
  if (stray) return { ok: false, words: `Not judged: the verdict log so far names ${stray.odu_id} with a hash this odù log does not hold (${stray.verdict_id}).` };
  const added = [];
  let prev = records[records.length - 1] || null;
  let n = records.filter((r) => r.record !== 'verdict_header').length;
  const put = (rec) => {
    prev = seal({ ...rec, seq: prev ? prev.seq + 1 : 0 }, prev ? prev.hash : null);
    records.push(prev);
    added.push(prev);
  };
  if (!records.length) put({ schema_version: 1, record: 'verdict_header', session_id: header.session_id, odu_header: head.hash, judge: { name: NAME, version: VERSION } });

  const latest = new Map();
  let lastSession = null;
  for (const r of records) {
    if (r.record === 'verdict') latest.set(r.odu_id, r);
    if (r.record === 'session_verdict') lastSession = r;
  }
  const keyOf = (v, rules) => ({ odu_hash: v.odu_hash, verdict: v.verdict, rule: v.rule, also: v.also, hidden: v.hidden, opened: v.opened, rules });
  for (const v of verdicts) {
    const was = latest.get(v.odu_id);
    if (was && same(keyOf(was, was.rules), keyOf(v, loaded.fingerprint))) continue;
    put({ schema_version: 1, record: 'verdict', session_id: header.session_id, verdict_id: vid(++n), ...v, supersedes: was ? was.verdict_id : null, rules: loaded.fingerprint });
  }
  const last = odus[odus.length - 1];
  const s = { verdict: session.verdict, reasons: session.reasons, counts: session.counts, judged: { seq: last.seq, hash: last.hash }, judge: { name: NAME, version: VERSION }, rules: loaded.fingerprint, rules_source: source };
  const sKey = (r) => ({ verdict: r.verdict, reasons: r.reasons, counts: r.counts, judged: r.judged, judge: r.judge, rules: r.rules, rules_source: r.rules_source });
  if (!lastSession || added.some((r) => r.record === 'verdict') || !same(sKey(lastSession), s)) {
    put({ schema_version: 1, record: 'session_verdict', session_id: header.session_id, verdict_id: vid(n + 1), ...s, supersedes: lastSession ? lastSession.verdict_id : null });
  }
  return { ok: true, records, added, text: records.map((r) => canonicalize(r) + '\n').join('') };
}

module.exports = { name: NAME, version: VERSION, loadRules, judge, DEFAULT_RULES };
