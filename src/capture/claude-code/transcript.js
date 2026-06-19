'use strict';

/**
 * transcript.js
 *
 * Claude Code writes each session's transcript as JSONL at the path given in
 * hook payloads (`transcript_path`). The exact shape of each line has shifted
 * across versions and isn't part of any stable public contract, so this
 * parser is intentionally defensive: it tries several known shapes and falls
 * back to a generic text scan rather than throwing.
 *
 * If extraction comes back empty on your install, run:
 *   node bin/orunmila.js debug-transcript <path>
 * to see exactly what's in the file, then adjust EXTRACTORS below - this is
 * the single spot most likely to need a tweak after a Claude Code update.
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

// Each extractor tries one known transcript shape. role/type-keyed message
// objects, Anthropic-Messages-style {role, content}, and a nested
// {type, message:{role, content}} wrapper have all been seen in the wild.
const EXTRACTORS = [
  (line) => (line.role && line.content !== undefined ? { role: line.role, text: textOf(line.content) } : null),
  (line) =>
    line.message && line.message.role
      ? { role: line.message.role, text: textOf(line.message.content) }
      : null,
  (line) => (line.type === 'user' || line.type === 'assistant' ? { role: line.type, text: textOf(line.content) } : null),
];

function normalize(line) {
  for (const extract of EXTRACTORS) {
    const r = extract(line);
    if (r && r.text) return r;
  }
  return null;
}

/** Last assistant text block - this is the agent's "claim" for the turn. */
function lastAssistantText(transcriptPath) {
  const lines = readLines(transcriptPath).map(normalize).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'assistant') return lines[i].text;
  }
  return '';
}

/** Last user text block - the original ask this turn is responding to. */
function lastUserText(transcriptPath) {
  const lines = readLines(transcriptPath).map(normalize).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === 'user') return lines[i].text;
  }
  return '';
}

module.exports = { readLines, normalize, lastAssistantText, lastUserText };
