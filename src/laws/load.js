'use strict';

/**
 * load.js — resolve the law set that applies right now, from layer 4 and layer 5.
 *
 * Resolution order (later wins on a same-id collision):
 *
 *   1. layer 4  src/laws/packs/canon.json      the canon, shipped with orunmila
 *   2. layer 5  <ORUNMILA_HOME>/laws.json      this user's own laws
 *   3. layer 5  <root>/.orunmila/laws.json     this project's laws
 *
 * Layers 2 and 3 sit next to the `ignore` and `redact` files orunmila already
 * reads from `.orunmila/`, so a user who has configured either already knows
 * where laws live.
 *
 * A later entry can do one of two things to an earlier law of the same id:
 *
 *   FULL REDEFINITION — it carries its own `detect` block and replaces the law
 *   outright. Use this to rewrite a canon law rather than live with it.
 *
 *   PATCH — it carries only an `id` plus the fields to change, most usefully
 *   `severity` or `enabled`. This is the common case: the canon says a law is a
 *   warning, a particular team wants it to block, and nobody should have to
 *   restate the whole rule to say so.
 *
 * Loading is LOUD about failure. A law file that does not parse, or a law that
 * does not validate, is reported — never silently skipped. A law that quietly
 * stopped applying is indistinguishable from a law that never fired, and that is
 * precisely the failure this whole layer exists to prevent.
 */

const fs = require('fs');
const path = require('path');
const { validateLaw } = require('./schema');
const { dataDir } = require('../store/eventlog');

const CANON_PATH = path.join(__dirname, 'packs', 'canon.json');

/** Where each layer's file lives. Exported so `laws --init` and `install` agree. */
function lawPaths({ root } = {}) {
  return {
    canon: CANON_PATH,
    user: path.join(dataDir(), 'laws.json'),
    project: path.join(root || process.cwd(), '.orunmila', 'laws.json'),
  };
}

/**
 * Read one law file. Returns { entries, errors }. A missing file is not an
 * error — layers 5 are optional by design. A malformed one always is.
 */
function readLawFile(filePath) {
  if (!fs.existsSync(filePath)) return { entries: [], errors: [], present: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { entries: [], errors: [`${filePath}: not valid JSON (${e.message})`], present: true };
  }
  // Accept either { laws: [...] } or a bare array, so a hand-written personal
  // file can be as small as the user wants.
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.laws) ? parsed.laws : null;
  if (!entries) {
    return { entries: [], errors: [`${filePath}: expected a "laws" array (or a bare array of laws)`], present: true };
  }
  return { entries, errors: [], present: true };
}

// Fields a patch entry (an id with no `detect` block) is allowed to change. A
// patch deliberately cannot alter what a law DETECTS — only how loudly it
// speaks and how it explains itself. Changing detection means redefining the
// law, which requires writing it out in full where a reader can see it.
const PATCHABLE = ['severity', 'enabled', 'message', 'remedy', 'title', 'cite'];

function applyPatch(law, entry, source) {
  const next = { ...law };
  for (const field of PATCHABLE) {
    if (Object.prototype.hasOwnProperty.call(entry, field)) next[field] = entry[field];
  }
  // Record that this law was touched from a later layer, so `orunmila laws` can
  // show "canon, overridden by ~/.orunmila/laws.json" instead of pretending the
  // canon said it.
  next.patchedBy = (law.patchedBy || []).concat(source);
  return next;
}

/**
 * Build the effective law set.
 *
 * Returns { laws, errors, layers } where `layers` describes each file consulted
 * (path, whether it existed, how many laws it contributed) so `orunmila laws`
 * and the installer can show the user exactly what is in force and from where.
 */
function loadLaws({ root, includeCanon = true } = {}) {
  const paths = lawPaths({ root });
  const files = [];
  if (includeCanon) files.push({ key: 'canon', layer: 4, file: paths.canon });
  files.push({ key: 'user', layer: 5, file: paths.user });
  files.push({ key: 'project', layer: 5, file: paths.project });

  const byId = new Map();
  const errors = [];
  const layers = [];

  for (const { key, layer, file } of files) {
    const { entries, errors: readErrors, present } = readLawFile(file);
    errors.push(...readErrors);
    let contributed = 0;

    for (const entry of entries) {
      const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
      const isPatch = id && byId.has(id) && !entry.detect;

      if (isPatch) {
        byId.set(id, applyPatch(byId.get(id), entry, file));
        contributed++;
        continue;
      }
      // A patch aimed at a law that does not exist is a typo in the user's file,
      // and silently ignoring it would leave them believing a law was retuned
      // when it was not.
      if (id && !byId.has(id) && !entry.detect) {
        errors.push(`${file}: law "${id}" has no "detect" block and does not patch any known law — check the id`);
        continue;
      }

      const { law, errors: lawErrors } = validateLaw(entry, { source: file, layer });
      if (lawErrors.length) {
        errors.push(...lawErrors);
        continue;
      }
      if (byId.has(id)) law.redefines = byId.get(id).source;
      byId.set(law.id, law);
      contributed++;
    }

    layers.push({ key, layer, file, present, contributed });
  }

  return { laws: [...byId.values()], errors, layers };
}

/** Only the laws that are switched on — what the evaluator should actually run. */
function activeLaws(laws) {
  return laws.filter((l) => l.enabled);
}

module.exports = { loadLaws, activeLaws, lawPaths, readLawFile, CANON_PATH, PATCHABLE };