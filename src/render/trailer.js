'use strict';

/**
 * src/render/trailer.js — MR4 (LD318; O's approval of R4 in research/market-landscape.md, LD315): a session's verdict as
 * git trailers, so a reviewer sees it on the commit and in the pull request.
 *
 *   Orunmila-Session: <session id>
 *   Orunmila-Verdict: <the session verdict> (<judge> <version>) | open (not closed out yet) | not judged (no verdict log)
 *   Orunmila-Seal: <the raw log's last hash at the closeout, from footer.json> | (only when the session closed out)
 *
 * A convenience, never evidence: anyone, the agent included, can write or strip a trailer. What proves anything is the
 * session's logs and `orunmila verify` over them; the seal names which record to verify. It is outside the evidence
 * path (brief line 495): it writes nothing of Orunmila's, only the commit message a person asked it to.
 *
 *   trailerLines({ sessionId, footer, sessionVerdict }) -> [line, ...]
 *   appendTrailers(message, lines) -> the message with the lines as its last paragraph's trailers; a line already there
 *                                     is not added again, and an Orunmila trailer for another session is replaced
 */

const KEYS = ['Orunmila-Session', 'Orunmila-Verdict', 'Orunmila-Seal'];

function trailerLines({ sessionId, footer, sessionVerdict }) {
  const out = [`Orunmila-Session: ${sessionId}`];
  if (sessionVerdict) out.push(`Orunmila-Verdict: ${sessionVerdict.verdict} (${sessionVerdict.judge.name} ${sessionVerdict.judge.version})`);
  else if (footer) out.push('Orunmila-Verdict: not judged (no verdict log)');
  else out.push('Orunmila-Verdict: open (not closed out yet)');
  if (footer && footer.raw && footer.raw.hash) out.push(`Orunmila-Seal: ${footer.raw.hash}`);
  return out;
}

function appendTrailers(message, lines) {
  const text = String(message).replace(/\s+$/, '');
  const kept = text.split('\n').filter((l) => !KEYS.some((k) => l.startsWith(`${k}:`)));
  const body = kept.join('\n').replace(/\s+$/, '');
  const paras = body.split(/\n\s*\n/);
  const last = paras[paras.length - 1] || '';
  // Git reads trailers from the last paragraph when every line in it is `Key: value`: join that block, else start one.
  const isTrailers = body && last.split('\n').every((l) => /^[A-Za-z0-9-]+: \S/.test(l));
  return (body ? body + (isTrailers ? '\n' : '\n\n') : '') + lines.join('\n') + '\n';
}

module.exports = { trailerLines, appendTrailers, KEYS };
