'use strict';

/**
 * sanitize.js
 *
 * Pre-processes prompt and claim text before sentence-splitting. The four
 * dogfood reports (review/DOGFOOD_*.md) showed the extractors were greedy on
 * the input side: any sentence with a backtick, identifier, or action verb
 * became a "claim" or "subtask", regardless of whether it was prose the agent
 * authored about its own work. The biggest sources of noise were:
 *
 *   - Wrapper tags injected by the harness (<system-reminder>,
 *     <ide_opened_file>, <task-notification>, <command-output>, etc.) that
 *     leaked verbatim into the prompt/claim text.
 *   - Fenced code blocks the agent showed the user as instructions
 *     ("run this: ```npm publish```"). The code lines parse as path/literal
 *     targets and then have no matching event.
 *   - Markdown tables — every row begins with `|` and gets sentence-split
 *     into rows-as-claims, often with backticked cells that look like targets.
 *   - Pasted test-runner output (PASS / FAIL / ✓ / ✗ / npm error /
 *     node:internal stacks) that the user pasted into a follow-up message;
 *     the task-extractor was splitting it into hundreds of "subtasks".
 *
 * Everything here is conservative: when in doubt we keep the text. We only
 * strip things that are reliably *not* prose authored by the agent or user.
 */

// Order matters: we strip multiline regions first (tags + fences) so the
// remaining line-based filters operate on clean prose only.
const WRAPPER_TAGS = [
  'system-reminder',
  'ide_opened_file',
  'task-notification',
  'command-output',
  'command-name',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
  'function_calls',
  'function_results',
  'tool_use',
  'tool_result',
];

const CODE_FENCE_RE = /```[\s\S]*?```/g;

// Lines that are unmistakably runner / tooling output, not prose. Anchored at
// start-of-line because PASS-inside-a-sentence is normal English.
const NOISE_LINE_RES = [
  /^\s*(PASS|FAIL|ok|not ok)\b/i,
  /^\s*[✓✗→]\s/,
  /^\s*(?:\d+\s+)?passed,\s*\d+\s+failed/i,
  /^\s*npm (error|warn|notice)\b/i,
  /^\s*at\s+\S+\s+\(.*:\d+:\d+\)\s*$/, // stack frame
  /^\s*node:internal\//i,
  /^\s*<task-notification>/, // wrapper tags we missed if unclosed
  /^\s*<\/task-notification>/,
  /^\s*\$\s+/, // shell prompt
  /^\s*kalkufinancialdiary@/i, // hostname-prefixed shell paste
  /^\s*\d+\/\d+\s+suites?\s+passed/i,
  /^\s*GATE\s+(PASS|FAIL):/i,

  // Echoes of Orunmila's own dogfood report format (the "I ran Orunmila and
  // found N issues, please address each one" pattern). When the user pastes
  // one of those back into a session, every "- You claimed:" bullet becomes
  // a per-bullet subtask the agent then gets blamed for silently dropping.
  // Strip them so the *original* asks in the rest of the prompt survive.
  /^\s*(?:[-*•]\s*)?You claimed:\s*/i,
  /^\s*but no (?:file change|passing test|claim or request)/i,
  /\bbut no file change, command, or tool call supports this\.?\s*$/i,
  /\bbut no passing test or command backs this up\.?/i,
  /\bbut you never mentioned why\.?\s*$/i,
  /\bwas in my original request but was never (?:done or mentioned|addressed)\.?\s*$/i,
  /^\s*(?:I ran Orunmila|Go back and actually complete each item)/i,
  // Dogfood-report section headings
  /^\s*##\s+(?:Phantom claims?|Phantom verifications?|Partial implementations?|Silently dropped tasks?|Undisclosed changes?)/i,
];

// A markdown table row: starts and ends with `|`. The separator row
// (|---|---|) and header row both get caught here.
function isTableRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

function stripWrapperTags(text) {
  let out = text;
  for (const tag of WRAPPER_TAGS) {
    // Greedy across newlines, non-capturing, with optional attributes.
    const open = `<${tag}(?:\\s[^>]*)?>`;
    const close = `<\\/${tag}>`;
    const re = new RegExp(`${open}[\\s\\S]*?${close}`, 'gi');
    out = out.replace(re, ' ');
    // Self-closing or unmatched forms — just drop the opening tag line.
    const lineRe = new RegExp(`^.*${open}.*$`, 'gim');
    out = out.replace(lineRe, '');
  }
  return out;
}

function stripCodeFences(text) {
  return text.replace(CODE_FENCE_RE, ' ');
}

function stripNoiseLines(text) {
  const lines = text.split('\n');
  const kept = lines.filter((line) => {
    if (isTableRow(line)) return false;
    return !NOISE_LINE_RES.some((re) => re.test(line));
  });
  return kept.join('\n');
}

/**
 * Sanitize a body of text for downstream sentence-level claim/subtask
 * extraction. Returns prose with wrapper tags, code fences, table rows, and
 * runner-output lines removed. Safe to call on either prompt or claim text.
 */
function sanitize(text) {
  if (!text || !text.trim()) return '';
  let out = stripWrapperTags(text);
  out = stripCodeFences(out);
  out = stripNoiseLines(out);
  return out;
}

module.exports = { sanitize, stripWrapperTags, stripCodeFences, stripNoiseLines, isTableRow };
