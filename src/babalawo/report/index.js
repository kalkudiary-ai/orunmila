'use strict';

/**
 * src/babalawo/report/index.js — the session report (brief v4 lines 688-693; Phase 6 slice BB8, LD272). Two forms from
 * the same data: plain words for a person (text, or one HTML file that loads nothing, test 46) and JSON for the agent.
 * Sentences come from fixed templates: plain code, no model (guarantee 8).
 *
 *   buildReport({ header, marks, odus, verdicts, quarantined, judgedNow }) -> the report's model
 *     header, marks   the raw log (the verdicts do not carry a gap's times, the law gate's results (LD267), or what a
 *                     tampering mark says changed; the report reads them from the marks the verdicts cite)
 *     odus            the odù log's records; verdicts, the verdict log's (the latest verdict of each odù counts)
 *     quarantined     how many inputs the quarantine log holds (test 28)
 *     judgedNow       true when the session has no verdict log and was judged for this report only
 *   renderText(model), renderHtml(model), renderJson(model)
 *
 * Top line first (line 690); each finding one sentence: what the agent claimed or what changed, what happened, where to
 * look, and what both witnesses recorded or that one recorded nothing (line 690, test 74). Silent changes are one
 * finding for the session (line 434). The law gate's turns checked, skipped and blocked, each block its own finding,
 * and a skip rate over 2% its own Look at this (lines 686, 692).
 */

const RANK = { clean: 0, look_at_this: 1, violation: 2, incomplete: 3 };
const LABEL = { violation: 'Violation', look_at_this: 'Look at this', incomplete: 'Incomplete', clean: 'Clean' };
const SCOPE = { outside_root: 'outside the project', excluded: 'an excluded path', not_a_disk_event: 'not a disk event', no_hook_for_tool: 'no hook reports that tool' };
const WHAT = {
  frozen_config: 'Frozen configuration',
  hook_settings: "The agent's hook settings",
  orunmila_code: "Orunmila's own code",
  log_location: "Orunmila's log location",
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const targetOf = (o) => (o && o.target ? o.target.path || o.target.text || o.target.name || o.target.id || o.target.kind : 'an event with no target');

/** How long between two mono_ns stamps, in plain units. */
function span(from, to) {
  let s = Number((BigInt(to) - BigInt(from)) / 1000000000n);
  if (s < 0) s = 0;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** What each witness recorded, or that it recorded nothing; never a guess why (lines 197, 690). */
function witnessWords(ws, bySeq) {
  const g = ws.glove || {};
  const s = ws.sentinel || {};
  const calls = [...new Set((g.mark_seqs || []).map((n) => bySeq.get(n)).filter((m) => m && m.detail && m.detail.tool && m.cause_hint).map((m) => `${m.detail.tool}, tool call ${m.cause_hint}`))];
  const glove =
    g.status === 'saw'
      ? `The Glove recorded ${g.says.join(', ')}${calls.length ? ` (${calls.join('; ')})` : ''}`
      : g.status === 'down'
        ? 'The Glove was down'
        : g.status === 'out_of_scope'
          ? `The Glove had nothing to record (${SCOPE[g.scope] || g.scope})`
          : 'The Glove recorded nothing';
  const sentinel =
    s.status === 'saw'
      ? `the Sentinel recorded it ${s.says.join(', then ')}`
      : s.status === 'saw_nothing'
        ? 'the Sentinel recorded no change while it was watching'
        : s.status === 'down'
          ? 'the Sentinel was down'
          : `the Sentinel had nothing to see (${SCOPE[s.scope] || s.scope})`;
  return `${glove}; ${sentinel}.`;
}

/** The finding's own words, by the rule that decided it. */
function ruleWords(v, o, bySeq) {
  const t = targetOf(o);
  const conflict = (kind) => (o.conflicts || []).find((c) => c.kind === kind) || {};
  const mark = (o.mark_seqs || []).map((n) => bySeq.get(n)).find((m) => m) || {};
  const d = mark.detail || {};
  switch (v.rule) {
    case 'R1': {
      const c = conflict('phantom_claim');
      if (c.claim === 'file') {
        const why = { no_event: 'no change to it was recorded', unchanged: 'every change of it in that turn was undone', not_credited: 'the change was not credited to this session' }[c.why];
        return `The agent claimed it changed ${c.path}, but ${why}`;
      }
      const run = (c.runs || [])[(c.runs || []).length - 1];
      const why = { no_command: 'no matching command ran in that turn', failed: `the last matching run failed${run && Number.isInteger(run.exit_code) ? ` (exit ${run.exit_code})` : ''}`, unknown: 'no matching run settled with a known result' }[c.why];
      return `The agent claimed "${(c.phrases || []).join('", "')}", but ${why}`;
    }
    case 'R3':
      return `The Glove and the Sentinel disagree on whether ${t} is there at the end`;
    case 'R4':
    case 'R8':
    case 'R12':
    case 'R16': {
      const tampered = (o.mark_seqs || []).map((n) => bySeq.get(n)).find((m) => m && m.says === 'tampered') || mark;
      const td = tampered.detail || {};
      return `${WHAT[td.what] || 'Something Orunmila froze'} changed during the session (${t})${td.reason ? `: ${td.reason}` : ''}. Whoever made the change, it breaks the record; Orunmila does not know who made it, and it may have been you`;
    }
    case 'R26': {
      const stop = (o.mark_seqs || []).map((n) => bySeq.get(n)).find((m) => m && m.says === 'tampered') || mark;
      const sig = (stop.detail && stop.detail.signal) || 'a signal';
      return `Orunmila's intake was stopped by ${sig}, which no one asked for through \`orunmila intake stop\`: a person, a logout or shutdown, or the agent may have sent it, and Orunmila does not know which; marks sent until it came back are lost`;
    }
    case 'R17':
      return `A payload for this session came from another process${Number.isInteger(d.sender_pid) ? ` (pid ${d.sender_pid}` : ' ('}${Number.isInteger(d.pinned_pid) ? `; the session is pinned to pid ${d.pinned_pid})` : ')'}: it was kept out of the session's record. Orunmila does not know who sent it`;
    case 'R6':
      return `${t} changed and no agent tool call or command explains it (it may have been you, a formatter or another program)`;
    case 'R7':
      return `${t} is a protected path and it changed, ${o.attribution === 'explained' && o.cause ? `by the agent (${o.cause.kind} ${o.cause.ref})` : 'by an unknown cause (it may have been you)'}`;
    case 'R9':
      if (d.since && d.until)
        return `The intake was down from ${d.since.observed_at} to ${d.until.observed_at} (${span(d.since.mono_ns, d.until.mono_ns)}): every mark sent meanwhile is lost; the sessions active at its last record: ${[...(d.sessions || [])].sort().join(', ')}`;
      return `${mark.source || 'A source'} lost events${d.lost ? `: ${d.lost}` : ''}`;
    case 'R10':
      return `${t} changed while sessions overlapped (${(conflict('concurrent_sessions').sessions || []).join(', ')}); it cannot be pinned to one of them`;
    case 'R11':
      return `The agent reported changing ${t}, but neither the Sentinel nor git saw it change`;
    case 'R15': {
      const c = conflict('outcome_missing');
      return `Tool call ${c.ref} started and no outcome was recorded${c.why === 'interrupted' || c.why === 'denied' ? ` (${c.why})` : ''}`;
    }
    case 'R18':
      return `${t} changed and only the closeout's full rescan found it`;
    case 'R19':
      return `${t} could not be fingerprinted at the closeout (${conflict('unfingerprinted').entry || 'unknown'}), so whether it changed is unknown`;
    case 'R20':
      return `${t} rests on low confidence: only a claim, with no witness observation`;
    default:
      return `${t} carries a conflict this judge does not know (${(o.conflicts || []).map((c) => c.kind).join(', ')})`;
  }
}

function buildReport({ header, marks, odus, verdicts, quarantined = 0, judgedNow = false }) {
  const bySeq = new Map(marks.map((m) => [m.seq, m]));
  const latest = new Map();
  let session = null;
  for (const r of verdicts) {
    if (r.record === 'verdict') latest.set(r.odu_id, r);
    if (r.record === 'session_verdict') session = r;
  }
  const findings = [];
  const silent = [];
  const looks = []; // BB12: the agent's looks at Orunmila's record, one calm line for the session (LD262)
  for (const o of odus.filter((x) => x.record === 'odu')) {
    const v = latest.get(o.odu_id);
    if (!v || v.verdict === 'clean') continue;
    // A parent raised only by a child: the child's own finding says it (line 660).
    if (v.opened.length && !v.also.length && v.opened.every((c) => latest.get(c) && latest.get(c).rule === v.rule)) continue;
    if (v.rule === 'R2') {
      silent.push({ v, o });
      continue;
    }
    if (v.rule === 'R25') {
      looks.push({ v, o });
      continue;
    }
    findings.push({ kind: 'verdict', verdict: v.verdict, rule: v.rule, odu_id: v.odu_id, target: targetOf(o), mark_seqs: v.mark_seqs, sentence: `${ruleWords(v, o, bySeq)}. ${witnessWords(v.witness_status, bySeq)}` });
  }
  if (silent.length) {
    // Line 434: silent changes are grouped, one finding for the session.
    const paths = silent.map((x) => targetOf(x.o));
    const each = silent.map((x) => `${targetOf(x.o)} (${witnessWords(x.v.witness_status, bySeq).slice(0, -1)})`);
    findings.push({ kind: 'verdict', verdict: 'look_at_this', rule: 'R2', odu_id: silent[0].v.odu_id, odu_ids: silent.map((x) => x.v.odu_id), target: paths.join(', '), mark_seqs: silent.flatMap((x) => x.v.mark_seqs), sentence: `The agent changed ${plural(paths.length, 'file', 'files')} its turns' claims never mention: ${each.join('; ')}.` });
  }
  if (looks.length) {
    const each = looks.map(({ v, o }) => {
      const call = v.mark_seqs.map((n) => bySeq.get(n)).find((m) => m && m.cause_hint);
      if (o.target.kind === 'command') return `it ran \`${o.target.text}\`${call ? ` (tool call ${call.cause_hint})` : ''}`;
      return `it read ${o.target.path}${call ? ` (${call.detail && call.detail.tool ? `${call.detail.tool}, ` : ''}tool call ${call.cause_hint})` : ''}`;
    });
    findings.push({ kind: 'verdict', verdict: 'look_at_this', rule: 'R25', odu_id: looks[0].v.odu_id, odu_ids: looks.map((x) => x.v.odu_id), target: "Orunmila's record", mark_seqs: looks.flatMap((x) => x.v.mark_seqs), sentence: `The agent looked at Orunmila's record of its work ${plural(looks.length, 'time', 'times')}: ${each.join('; ')}.` });
  }
  for (const r of (session && session.reasons) || []) {
    if (r.reason === 'law_gate_silent') findings.push({ kind: 'incomplete', verdict: 'incomplete', rule: r.rule, target: 'the law gate', sentence: "No law-gate check was recorded, though the agent's hooks were: the law gate was silent, so the record is incomplete." });
    if (r.reason === 'glove_silent') findings.push({ kind: 'incomplete', verdict: 'incomplete', rule: r.rule, target: 'the Glove', odu_ids: r.odu_ids, sentence: `The Sentinel saw ${plural(r.odu_ids.length, 'change', 'changes')} inside the project and the Glove recorded no mark at all: the Glove was silent, so the record is incomplete.` });
  }

  // The law gate, from the raw log's checked marks (LD267; line 692).
  const law_gate = { checked: 0, passed: 0, warned: 0, blocked: 0, skipped: 0, skip_rate: 0 };
  for (const m of marks) {
    if (m.source !== 'law_gate' || m.says !== 'checked' || !m.detail) continue;
    law_gate.checked++;
    if (law_gate[m.detail.result] !== undefined) law_gate[m.detail.result]++;
    if (m.detail.result === 'blocked') {
      const laws = (m.detail.findings || []).filter((f) => f.severity === 'block').map((f) => f.law);
      findings.push({ kind: 'law_gate_block', verdict: 'look_at_this', target: `turn ${m.turn}`, mark_seqs: [m.seq], sentence: `The law gate blocked turn ${m.turn}: ${laws.join(', ') || 'a blocking law'}.` });
    }
  }
  if (law_gate.checked) law_gate.skip_rate = Math.round((law_gate.skipped * 100) / law_gate.checked);
  if (law_gate.skip_rate > 2) findings.push({ kind: 'law_gate_skips', verdict: 'look_at_this', target: 'the law gate', sentence: `The law gate skipped ${law_gate.skipped} of ${law_gate.checked} turns, ${law_gate.skip_rate}% of the turns it checked, over the 2% ceiling.` });

  findings.sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
  const base = session ? session.verdict : 'clean';
  const verdict = findings.reduce((acc, f) => (RANK[f.verdict] > RANK[acc] ? f.verdict : acc), base);
  const n = (k) => findings.filter((f) => f.verdict === k).length;
  const top_line =
    verdict === 'incomplete'
      ? 'Incomplete record'
      : verdict === 'violation'
        ? plural(n('violation'), 'violation', 'violations')
        : verdict === 'look_at_this'
          ? plural(n('look_at_this'), 'thing to look at', 'things to look at')
          : 'Clean session';
  const overlapped = [...new Set(marks.filter((m) => m.says === 'overlapped' && m.detail).map((m) => m.detail.session))].sort();
  const agent = header && header.agent ? header.agent.name : null;
  return {
    session_id: header ? header.session_id : null,
    verdict,
    session_verdict: session ? session.verdict : null,
    top_line,
    judged_now: judgedNow,
    findings,
    law_gate,
    hidden: session ? session.counts.hidden : 0,
    counts: session ? session.counts : null,
    quarantined,
    overlapped,
    experimental: agent !== null && agent !== 'claude-code' ? agent : null,
    rules_source: session ? session.rules_source : null,
  };
}

function lines(rep) {
  const out = [rep.top_line];
  if (rep.judged_now) out.push('(judged now: this session has no verdict log, so nothing here is recorded; the judge was off when it closed)');
  if (rep.experimental) out.push(`This session's agent (${rep.experimental}) is experimental: built, tested only with sample data; results may be wrong.`);
  if (rep.findings.length) out.push('');
  for (const f of rep.findings) out.push(`- ${LABEL[f.verdict]}: ${f.sentence}${f.odu_id ? ` (${f.odu_ids ? f.odu_ids.join(', ') : f.odu_id}, ${f.rule})` : f.rule ? ` (${f.rule})` : ''}`);
  out.push('');
  const lg = rep.law_gate;
  out.push(`Law gate: ${plural(lg.checked, 'turn', 'turns')} checked, ${lg.skipped} skipped, ${lg.blocked} blocked${lg.warned ? `, ${lg.warned} warned` : ''}; skip rate ${lg.skip_rate}%.`);
  if (rep.quarantined) out.push(`${plural(rep.quarantined, 'badly formatted mark was', 'badly formatted marks were')} kept in the quarantine log, nothing dropped.`);
  if (rep.overlapped.length) out.push(`Sessions overlapped with this one in the same folder: ${rep.overlapped.join(', ')}.`);
  out.push(`${rep.hidden} Clean ${rep.hidden === 1 ? 'event is' : 'events are'} hidden; the verdict log holds every one.`);
  return out;
}

const renderText = (rep) => lines(rep).join('\n') + '\n';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One self-contained HTML file: inline styles, no script, nothing loaded (line 693, test 46). */
function renderHtml(rep) {
  const items = rep.findings.map((f) => `<li class="${esc(f.verdict)}"><b>${esc(LABEL[f.verdict])}</b> ${esc(f.sentence)}${f.odu_id ? ` <small>${esc(f.odu_ids ? f.odu_ids.join(', ') : f.odu_id)}, ${esc(f.rule)}</small>` : ''}</li>`).join('\n');
  const rest = lines(rep).slice(1).filter((l) => l && !l.startsWith('- '));
  return [
    '<!doctype html>',
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Orunmila session report: ${esc(rep.session_id)}</title>`,
    '<style>body{font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;background:#fff;color:#1b1f24}h1{font-size:22px}li{margin:8px 0}li.violation b{color:#b3261e}li.look_at_this b{color:#8a5a00}li.incomplete b{color:#5b3fa8}small{color:#57606a}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}small{color:#8b949e}}</style></head><body>',
    `<h1>${esc(rep.top_line)}</h1>`,
    `<p>Session ${esc(rep.session_id)}</p>`,
    items ? `<ul>\n${items}\n</ul>` : '',
    ...rest.map((l) => `<p>${esc(l)}</p>`),
    '</body></html>',
    '',
  ].join('\n');
}

/** The same findings as JSON, for the agent's own self-correction loop (line 691). */
function renderJson(rep) {
  return JSON.stringify({ schema_version: 1, ...rep }, null, 2);
}

module.exports = { buildReport, renderText, renderHtml, renderJson, witnessWords };
