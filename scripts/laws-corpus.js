'use strict';

/**
 * Runs a closed, labelled sentence corpus through both of Orunmila's claim
 * readers and reports every sentence either one gets wrong.
 *
 * The N10 redo changes how a claim is read. Fixes to the claim reader were made
 * twice before against sentences found along the way, and each round broke
 * sentences the last one had fixed. A fixed corpus, labelled before any change
 * and run against every candidate, makes that visible as a number.
 *
 * Two paths read the same sentence, and both must agree with the label:
 *   law        the Stop-hook law gate (src/laws): `fire` = the law flags it
 *   reconcile  the reconciler (src/reconcile), which later builds' judge starts
 *              from: `fire` = a claim graded phantom_verification; `silent` =
 *              no claim graded phantom or phantom_verification
 *
 * Each sentence is judged alone, in a turn with no commands, with strict proof
 * off unless the case says "strict": true (plan slice 4.4). Only the shipped
 * canon is loaded: ORUNMILA_HOME and the project root point at an empty folder,
 * and the run stops if any other law file is found, so a personal laws.json
 * cannot change the result.
 *
 * Run: node scripts/laws-corpus.js [--src DIR] [--corpus FILE] [--path law|reconcile|both]
 *   --src     the source tree to judge with (default: this repo), e.g. a
 *             `git archive` of another commit
 *   --corpus  default test/cases/laws/green-corpus.json
 *   --path    default both
 * Exits 0 when every sentence matches its label on every path run, 1 when any
 * does not.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DEFAULT_CORPUS = path.join(__dirname, '..', 'test', 'cases', 'laws', 'green-corpus.json');

function loadCorpus(corpusPath) {
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const cases = corpus.cases || [];
  if (!cases.length) throw new Error(`${corpusPath}: no cases`);
  const seen = new Set();
  for (const c of cases) {
    if (c.expect !== 'fire' && c.expect !== 'silent') throw new Error(`bad label "${c.expect}" on: ${c.text}`);
    if (seen.has(c.text)) throw new Error(`duplicate sentence: ${c.text}`);
    seen.add(c.text);
  }
  return corpus;
}

// Returns { law, reconcile }: each a function sentence -> fires (boolean).
function judges(src, lawId, empty) {
  const { loadLaws, activeLaws } = require(path.join(src, 'src', 'laws', 'load'));
  const { evaluateTurn } = require(path.join(src, 'src', 'laws', 'evaluate'));
  const { reconcileTurn } = require(path.join(src, 'src', 'reconcile', 'matcher'));

  const { laws, errors, layers } = loadLaws({ root: empty });
  const extra = layers.filter((l) => l.key !== 'canon' && l.present);
  if (errors.length || extra.length) {
    throw new Error(`law files other than the canon were read: ${errors.concat(extra.map((l) => l.file)).join('; ')}`);
  }
  const law = activeLaws(laws).filter((l) => l.id === lawId);
  if (law.length !== 1) throw new Error(`law "${lawId}" not found in ${src}`);

  return {
    law: (text, expect, strict) =>
      evaluateTurn({ claimText: text, promptText: 'go', turnEvents: [], laws: law, strictProof: !!strict }).findings.length > 0,
    reconcile: (text, expect, strict) => {
      const outcomes = reconcileTurn({ promptText: 'go', claimText: text, turnEvents: [], strictProof: !!strict }).claims.map((c) => c.outcome);
      if (expect === 'fire') return outcomes.includes('phantom_verification');
      // Read back as "fires" so the caller compares against the label the same way.
      return outcomes.includes('phantom_verification') || outcomes.includes('phantom');
    },
  };
}

/**
 * Judge every case on the chosen paths. Returns one row per path:
 * { path, wrong: [{ text, expect }], total, byKind: { kind: { total, wrong } } }.
 */
function runCorpus({ src, corpus, paths }) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-corpus-'));
  const prevHome = process.env.ORUNMILA_HOME;
  process.env.ORUNMILA_HOME = empty;
  try {
    const j = judges(src, corpus.law, empty);
    return paths.map((p) => {
      const row = { path: p, wrong: [], total: corpus.cases.length, byKind: {} };
      for (const c of corpus.cases) {
        const fires = j[p](c.text, c.expect, c.strict);
        const kind = (row.byKind[c.kind || 'none'] = row.byKind[c.kind || 'none'] || { total: 0, wrong: 0 });
        kind.total++;
        if (fires !== (c.expect === 'fire')) {
          kind.wrong++;
          row.wrong.push({ text: c.text, expect: c.expect });
        }
      }
      return row;
    });
  } finally {
    if (prevHome === undefined) delete process.env.ORUNMILA_HOME;
    else process.env.ORUNMILA_HOME = prevHome;
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

module.exports = { runCorpus, loadCorpus, DEFAULT_CORPUS };

if (require.main === module) {
  const src = path.resolve(flag('src', path.join(__dirname, '..')));
  const corpus = loadCorpus(path.resolve(flag('corpus', DEFAULT_CORPUS)));
  const which = flag('path', 'both');
  const paths = which === 'both' ? ['law', 'reconcile'] : [which];
  if (!paths.every((p) => p === 'law' || p === 'reconcile')) throw new Error(`unknown --path ${which}`);

  let anyWrong = 0;
  for (const row of runCorpus({ src, corpus, paths })) {
    for (const w of row.wrong) console.log(`WRONG  ${row.path.padEnd(9)} expected ${w.expect.padEnd(6)} ${w.text}`);
    const kinds = Object.entries(row.byKind).map(([k, v]) => `${k} ${v.wrong}/${v.total}`).join(', ');
    console.log(`${row.path}: ${row.wrong.length} of ${row.total} wrong (${kinds})`);
    anyWrong += row.wrong.length;
  }
  console.log(`${corpus.law} corpus at ${src}`);
  process.exit(anyWrong ? 1 : 0);
}
