// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/completeness.js — CF5 (LD385): how complete the record is, against the agent's own transcript. At the
 * closeout, every tool call the transcript shows since the session started is looked for in the record by its call
 * id; the calls with no mark at all are counted and named. The transcript is the agent's testimony too: a call it
 * leaves out is not seen here, so "every call has a mark" means every call the transcript names. Plain code, no model.
 *
 *   readTranscriptCalls(file, sinceIso) -> { transcript: 'read' | 'none' | 'too_large', calls: [{ id, tool }] }
 *   transcriptCalls(text, sinceIso) -> [{ id, tool }]
 *     the tool_use blocks of Claude Code's assistant lines on the main thread (not isSidechain: a sub-agent's calls
 *     are in its own transcript), timestamped at or after the session's start, each id once, in transcript order;
 *     a line that is not JSON, or has no timestamp, is skipped
 *   completeness(read, markedIds) -> { transcript, calls, unmarked: [{ id, tool }], cut? }
 *     at most MAX_NAMED named; `cut` counts the rest
 */

const { readRegular } = require('../opon/intake/regular-file');
const fs = require('fs');

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_NAMED = 50;

function transcriptCalls(text, sinceIso) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let r;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!r || r.type !== 'assistant' || r.isSidechain === true || typeof r.timestamp !== 'string') continue;
    if (sinceIso && r.timestamp < sinceIso) continue;
    const content = r.message && Array.isArray(r.message.content) ? r.message.content : [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || !b.id || seen.has(b.id)) continue;
      seen.add(b.id);
      out.push({ id: b.id, tool: typeof b.name === 'string' ? b.name : '' });
    }
  }
  return out;
}

function readTranscriptCalls(file, sinceIso) {
  if (typeof file !== 'string' || !file) return { transcript: 'none', calls: [] };
  const buf = readRegular(file, MAX_BYTES);
  if (buf === null) {
    let big = false;
    try {
      big = fs.statSync(file).size > MAX_BYTES;
    } catch {
      /* not there */
    }
    return { transcript: big ? 'too_large' : 'none', calls: [] };
  }
  return { transcript: 'read', calls: transcriptCalls(buf.toString('utf8'), sinceIso) };
}

function completeness(read, markedIds) {
  const unmarked = read.calls.filter((c) => !markedIds.has(c.id));
  const out = { transcript: read.transcript, calls: read.calls.length, unmarked: unmarked.slice(0, MAX_NAMED) };
  if (unmarked.length > MAX_NAMED) out.cut = unmarked.length - MAX_NAMED;
  return out;
}

module.exports = { transcriptCalls, readTranscriptCalls, completeness, MAX_NAMED };
