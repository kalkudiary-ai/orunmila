'use strict';

/**
 * terminal.js
 *
 * Quick-check view: print a turn's reconciliation report straight to a
 * terminal with ANSI colors. No dependency on any color library - just raw
 * escape codes, so `npm install` for this whole project can stay empty.
 */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const OUTCOME_STYLE = {
  verified: { icon: '\u2705', color: C.green, label: 'verified' },
  partial: { icon: '\u26A0\uFE0F ', color: C.yellow, label: 'partial / scaffolding-only' },
  phantom: { icon: '\u274C', color: C.red, label: 'phantom - claimed, no evidence' },
  phantom_verification: { icon: '\uD83D\uDD25', color: C.red, label: 'phantom verification - claimed tested/works, no passing run' },
  unverifiable: { icon: '\u2753', color: C.gray, label: 'unverifiable - too vague to check' },
};

const SUBTASK_STYLE = {
  addressed: { icon: '\u2705', color: C.green, label: 'addressed' },
  acknowledged_incomplete: { icon: '\u2139\uFE0F ', color: C.cyan, label: 'acknowledged as incomplete' },
  silently_dropped: { icon: '\uD83D\uDC7B', color: C.magenta, label: 'silently dropped - never mentioned, no evidence' },
  unverifiable_ask: { icon: '\u2753', color: C.gray, label: 'unverifiable ask - no concrete target to check (tool limit, not a verdict)' },
};

function paint(text, color) {
  return `${color}${text}${C.reset}`;
}

function renderTurn(report) {
  const lines = [];
  lines.push(paint(`\n=== orunmila: session ${report.session_id} / turn ${report.turn_id} ===`, C.bold));

  // Untracked writes are the highest-signal stain: the filesystem sentinel saw a
  // real change on disk that the agent's own tool stream never disclosed. Per
  // PRD 6.4 they print FIRST, in their own block, never buried with undisclosed.
  if (report.untracked && report.untracked.length) {
    lines.push(paint('\n\uD83D\uDEA8 UNTRACKED WRITES - disk changed, no tool call disclosed it:', C.red + C.bold));
    for (const u of report.untracked) {
      const where = u.rel_path || u.path;
      const kind = u.change_kind ? ` (${u.change_kind})` : '';
      lines.push(`  ${paint(where, C.red)}${paint(kind, C.gray)}`);
    }
    lines.push(paint('     seen by the filesystem sentinel; correlated into this turn by time window.', C.gray));
  }

  lines.push(paint('\nClaims:', C.bold));
  if (!report.claims.length) {
    lines.push(paint('  (no checkable claims found in the response text)', C.dim));
  }
  for (const c of report.claims) {
    const style = OUTCOME_STYLE[c.outcome] || { icon: '?', color: C.reset, label: c.outcome };
    lines.push(`  ${style.icon} ${paint(style.label, style.color)}`);
    lines.push(paint(`     "${c.claim.text}"`, C.dim));
    if (c.causeHints && c.causeHints.length) {
      lines.push(paint(`     evidence signals: ${c.causeHints.join(', ')} (inference, not a verdict)`, C.gray));
    }
  }

  if (report.subtasks && report.subtasks.length > 1) {
    lines.push(paint('\nOriginal ask, checked independently of what was claimed:', C.bold));
    for (const t of report.subtasks) {
      const style = SUBTASK_STYLE[t.outcome] || { icon: '?', color: C.reset, label: t.outcome };
      lines.push(`  ${style.icon} ${paint(style.label, style.color)} - "${t.task.text}"`);
    }
  }

  if (report.undisclosed && report.undisclosed.length) {
    lines.push(paint('\nUndisclosed changes (touched, never mentioned by any claim):', C.bold));
    for (const u of report.undisclosed) {
      const count = u.occurrences && u.occurrences > 1 ? `  ${paint('\u00d7' + u.occurrences, C.dim)}` : '';
      lines.push(`  \u2795 ${paint(u.path, C.magenta)}${count}`);
    }
  }

  const s = report.summary;
  lines.push(
    paint(
      `\nSummary: ${s.verified} verified, ${s.partial} partial, ${s.phantom} phantom, ` +
        `${s.phantom_verification} phantom-verification, ${s.unverifiable} unverifiable, ` +
        `${s.silently_dropped} silently dropped, ${s.undisclosed_changes} undisclosed changes, ` +
        `${s.untracked_writes || 0} untracked writes`,
      C.bold
    )
  );

  return lines.join('\n');
}

module.exports = { renderTurn, C };
