// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/render/session-facts.js — PG1 (F33; MR3, LD316; DOC3, LD340): what the pages that show a session (`orunmila trail`,
 * the dashboard) read from its logs in <home>/sessions/<id>/, besides the old event log: the witness gap from the odù
 * log, and the Babaláwo's verdict from the verdict log. Each is null when its log is missing or does not verify, so a
 * page says it is not shown rather than show nothing as clean. Read only; one place, so the two pages cannot drift.
 */

const fs = require('fs');
const path = require('path');

function readVerified(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!require('../verify/chain').verifyText(text).ok) return null;
    return text.split('\n').slice(0, -1).map((l) => JSON.parse(l));
  } catch {
    return null; // missing, unreadable or not JSON: not shown
  }
}

function sessionFacts(home, sessionId) {
  let dir;
  try {
    dir = path.join(home, 'sessions', require('../opon/intake/paths').sessionFolderName(sessionId));
  } catch {
    return { witnesses: null, judge: null }; // an id unsafe as a folder name has no session log
  }
  const report = require('../babalawo/report');
  const odus = readVerified(path.join(dir, 'odu.jsonl'));
  const verdicts = readVerified(path.join(dir, 'verdict.jsonl'));
  return { witnesses: odus ? report.witnessGap(odus) : null, judge: verdicts ? report.verdictLine(verdicts) : null };
}

module.exports = { sessionFacts };
