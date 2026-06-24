'use strict';

/**
 * transcript.js — defensive JSONL transcript reader (agent-agnostic default).
 *
 * Many agents write a session transcript as JSONL and hand its path to the stop
 * hook. The exact per-line shape varies by agent and version and is rarely a
 * stable contract, so this reader is intentionally liberal: it tries several
 * known shapes ({role,content}, {message:{role,content}}, {type,content}) and a
 * content normalizer (string | array-of-blocks | {text}), falling back to null
 * rather than throwing. An agent with a genuinely different format can ship its
 * own transcript module on its adapter; this is the shared default.
 *
 * If extraction comes back empty on your install:
 *   node bin/orunmila.js debug-transcript <path>
 * dumps the raw lines so you can see what to add to EXTRACTORS.
 */

const fs = require('fs');

function readLines(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  return fs
    .readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

const EXTRACTORS = [
  (line) => (line.role && line.content !== undefined ? { role: line.role, text: textOf(line.content) } : null),
  (line) =>
    line.message && line.message.role
      ? { role: line.message.role, text: textOf(line.message.content) }
      : null,
  (line) => (line.type === 'user' || line.type === 'assistant' ? { role: line.type, text: textOf(line.content) } : null),
  // Gemini CLI: type 'gemini' = assistant, content + thoughts + toolCalls
  (line) => {
    if (line.type === 'gemini') {
      const parts = [];
      if (line.content) parts.push(String(line.content));
      if (Array.isArray(line.thoughts)) {
        for (const t of line.thoughts) {
          if (t.description) parts.push(t.description);
        }
      }
      if (Array.isArray(line.toolCalls)) {
        for (const tc of line.toolCalls) {
          if (tc.description) parts.push(tc.description);
        }
      }
      return parts.length ? { role: 'assistant', text: parts.join('\n') } : null;
    }
    return null;
  },
];

function normalize(line) {
  for (const extract of EXTRACTORS) {
    const r = extract(line);
    if (r && r.text) return r;
  }
  return null;
}

/** Last assistant text block — the agent's "claim" for the turn. */
function lastAssistantText(transcriptPath) {
  const lines = readLines(transcriptPath).map(normalize).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'assistant') return lines[i].text;
  }
  return '';
}

/** Last user text block — the original ask this turn is responding to. */
function lastUserText(transcriptPath) {
  const lines = readLines(transcriptPath).map(normalize).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'user') return lines[i].text;
  }
  return '';
}

module.exports = { readLines, normalize, lastAssistantText, lastUserText };
