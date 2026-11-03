'use strict';

/**
 * scripts/mutation-gate.js — proves the 0.2.2 security tests can fail.
 *
 * A test that stays green when its fix is undone guards nothing, and that is
 * silent everywhere else in the suite. So each mutant below undoes one fix in
 * a throwaway copy of the repo (never in the working tree), runs
 * test/secure.js there, and names the tests that must fail. The gate passes
 * only when the unmutated copy is fully green and every mutant fails every
 * test it names.
 *
 * Each mutant matches an exact snippet that must occur exactly once in its
 * file, so a mutant whose code has moved is a loud error, not a silent pass.
 *
 * Run: npm run mutation:gate      (exit 0 = every mutant failed as predicted)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', 'coverage', '.claude']);

// Test names, by the start of their title in test/secure.js.
const T = {
  folders: 'each of the seven places that creates a folder',
  bound: 'an unterminated PEM header removes its key',
  shapes: 'a cut-off key is removed whatever its lines look like',
  rsa16k: 'a cut-off key the size of an RSA-16384 key',
  runOn: 'a cut-off key does not run on to the END line',
  beyond: 'text beyond PEM_TAIL_MAX plus one line',
  count: 'a bare number is kept only under a count word',
  yaml: 'an indented key in long command output',
  snapshot: 'a file holding a secret is redacted in its before-snapshot',
  apiKey: 'a command containing an API key never reaches the log',
  doc: 'the limits table in SECURITY.md',
  newLog: 'a new log is created owner-only',
  tightenFiles: 'an existing world-readable log, laws.json',
  tightenDirs: 'existing world-readable data subfolders',
  newFiles: 'the event log, log state, last-turn report and command sidecar a hook cycle creates',
  defaultHome: 'the default ~/.orunmila of an existing install',
  warnOnce: 'a pre-0.2.2 log makes the Claude Code prompt hook warn',
  redact: 'orunmila log redact scrubs',
  remove: 'orunmila log delete lists',
  excerptCut: 'a complete key across the excerpt cut',
  toolCut: 'a complete key across the tool-result excerpt cut',
  sentinelDiff: 'a Sentinel diff of an edit inside a key file',
  witness: 'the Witness column of the limits table',
  prune: 'orunmila prune rewrites the log owner-only',
  lawsInit: 'orunmila laws --init writes your laws.json owner-only',
};

const SNAPSHOT_WRITE = 'fs.writeFileSync(ensureCacheSlot(sessionId, filePath), redactString(before).text, { mode: 0o600 });';
const OWNED_FILES = "['events.jsonl', 'last-turn-report.txt', 'log-state.json', 'laws.json']";
const OWNED_DIRS = "['cache', 'output', 'reports', 'laws-state', 'archive', 'warned']";
const CONTENT_DIRS = "['output', 'cache', 'reports', 'archive', 'laws-state']";
const SIDECAR_WRITE = 'fs.writeFileSync(slot, redactString(full).text, { mode: 0o600 });';

const MK = 'mkdirSync(dir, { recursive: true, mode: 0o700 });';
const MK_OPEN = 'mkdirSync(dir, { recursive: true });';
const PEM_RE = "new RegExp(String.raw`${PEM_HEADER}(?:${NOT_BEGIN}*?${PEM_FOOTER}|${NOT_BEGIN}{0,${PEM_TAIL_MAX}}${NOT_BEGIN_NOT_NL}{0,${PEM_LINE_MAX}})`, 'g')";
const KEEP = '(prefix, value) => BARE_NUMBER.test(value) && COUNT_WORD.test(prefix),';

const MUTANTS = [
  { id: 'M1 cache folder mode (core.js ensureCacheSlot)', file: 'src/capture/core.js',
    from: `${MK}\n  return path.join(dir, encodeURIComponent(filePath) + '.before');`,
    to: `${MK_OPEN}\n  return path.join(dir, encodeURIComponent(filePath) + '.before');`, fails: [T.folders] },
  { id: 'M2 output folder mode (core.js writeOutputSidecar)', file: 'src/capture/core.js',
    from: `${MK}\n    const slot`, to: `${MK_OPEN}\n    const slot`, fails: [T.folders] },
  { id: 'M3 cache folder mode (turnstate.js statePath)', file: 'src/capture/turnstate.js', from: MK, to: MK_OPEN, fails: [T.folders] },
  { id: 'M4 laws-state folder mode (gate.js statePath)', file: 'src/laws/gate.js', from: MK, to: MK_OPEN, fails: [T.folders] },
  { id: 'M5 reports folder mode (reconcile/index.js reportPath)', file: 'src/reconcile/index.js', from: MK, to: MK_OPEN, fails: [T.folders] },
  { id: 'M6 archive folder mode (rescore.js newArchiveDir)', file: 'src/reconcile/rescore.js', from: MK, to: MK_OPEN, fails: [T.folders] },
  { id: 'M7 archived session folder mode (rescore.js rescoreAll)', file: 'src/reconcile/rescore.js',
    from: 'mkdirSync(archDir, { recursive: true, mode: 0o700 });', to: 'mkdirSync(archDir, { recursive: true });', fails: [T.folders] },
  { id: 'M8 PEM_TAIL_MAX too small (8192)', file: 'src/store/secrets.js',
    from: 'const PEM_TAIL_MAX = 16384;', to: 'const PEM_TAIL_MAX = 8192;', fails: [T.rsa16k, T.doc] },
  { id: 'M9 unbounded tail after a cut-off header', file: 'src/store/secrets.js',
    from: PEM_RE, to: PEM_RE.replace('${NOT_BEGIN}{0,${PEM_TAIL_MAX}}', '${NOT_BEGIN}*'), fails: [T.bound, T.beyond] },
  { id: 'M10 the first-attempt numeric rule', file: 'src/store/secrets.js',
    from: KEEP, to: "(prefix, value) => BARE_NUMBER.test(value) && !/PASS(?:WORD|WD)|SECRET/.test(prefix),", fails: [T.count] },
  { id: 'M11 the pattern 0.2.2 started with (wipe to end of input)', file: 'src/store/secrets.js',
    from: PEM_RE, to: '/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g', fails: [T.bound, T.runOn, T.beyond] },
  { id: 'M12 no numeric exemption at all', file: 'src/store/secrets.js', from: KEEP, to: '() => false,', fails: [T.count] },
  { id: 'M13 no end-of-line cap', file: 'src/store/secrets.js',
    from: PEM_RE, to: PEM_RE.replace('${NOT_BEGIN_NOT_NL}{0,${PEM_LINE_MAX}}', ''), fails: [T.bound] },
  { id: 'M14 snapshot written unredacted', file: 'src/capture/core.js',
    from: SNAPSHOT_WRITE, to: SNAPSHOT_WRITE.replace('redactString(before).text', 'before'), fails: [T.snapshot] },
  { id: 'M15 sidecar written unredacted', file: 'src/capture/core.js',
    from: SIDECAR_WRITE, to: SIDECAR_WRITE.replace('redactString(full).text', 'full'), fails: [T.yaml, T.apiKey] },
  { id: 'M16 events appended unredacted (eventlog.js append)', file: 'src/store/eventlog.js',
    from: 'const record = redactEvent(Object.assign({ ts: new Date().toISOString() }, event));',
    to: 'const record = Object.assign({ ts: new Date().toISOString() }, event);', fails: [T.apiKey] },
  { id: 'M17 SECURITY.md table drifts from the code', file: 'SECURITY.md',
    from: 'next 16384 characters', to: 'next 8192 characters', fails: [T.doc] },
  { id: 'M18 PEM_LINE_MAX far too large (100000)', file: 'src/store/secrets.js',
    from: 'const PEM_LINE_MAX = 128;', to: 'const PEM_LINE_MAX = 100000;', fails: [T.doc] },
  { id: 'M19 raw after-content passed to the diff tool', file: 'src/capture/core.js',
    from: 'diff: unifiedDiff(b.text, a.text, filePath),', to: 'diff: unifiedDiff(b.text, after, filePath),', fails: [T.snapshot] },
  { id: 'M20 secret_assignment drops the PASSWD and ACCESS_KEY names', file: 'src/store/secrets.js',
    from: 'SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY', to: 'SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|PRIVATE_KEY', fails: [T.count] },
  // Permissions and the legacy commands: mutants that survived the whole suite
  // in the third cold pass, each now killed by a named test.
  { id: 'M21 before-snapshot written without mode 0600', file: 'src/capture/core.js',
    from: SNAPSHOT_WRITE, to: SNAPSHOT_WRITE.replace(', { mode: 0o600 }', ''), fails: [T.snapshot] },
  { id: 'M22 before-snapshot not removed after the edit', file: 'src/capture/core.js',
    from: 'fs.rmSync(cacheSlot(sessionId, filePath), { force: true });', to: 'void 0;', fails: [T.snapshot] },
  { id: 'M23 sidecar written without mode 0600', file: 'src/capture/core.js',
    from: SIDECAR_WRITE, to: SIDECAR_WRITE.replace(', { mode: 0o600 }', ''), fails: [T.apiKey, T.newFiles] },
  { id: 'M24 last-turn report written without mode 0600', file: 'src/capture/core.js',
    from: "fs.writeFileSync(lastTurnReportPath(), out + '\\n', { mode: 0o600 });", to: "fs.writeFileSync(lastTurnReportPath(), out + '\\n');", fails: [T.newFiles] },
  { id: 'M25 events.jsonl appended without mode 0600', file: 'src/store/eventlog.js',
    from: "fs.appendFileSync(logPath(), JSON.stringify(record) + '\\n', { mode: FILE_MODE });", to: "fs.appendFileSync(logPath(), JSON.stringify(record) + '\\n');", fails: [T.newLog] },
  { id: 'M26 existing laws.json not tightened', file: 'src/store/eventlog.js',
    from: OWNED_FILES, to: OWNED_FILES.replace(", 'laws.json'", ''), fails: [T.tightenFiles] },
  { id: 'M27 existing last-turn report not tightened', file: 'src/store/eventlog.js',
    from: OWNED_FILES, to: OWNED_FILES.replace(", 'last-turn-report.txt'", ''), fails: [T.tightenFiles] },
  { id: 'M28 existing laws-state/ not tightened', file: 'src/store/eventlog.js',
    from: OWNED_DIRS, to: OWNED_DIRS.replace(", 'laws-state'", ''), fails: [T.tightenDirs] },
  { id: 'M29 existing archive/ not tightened', file: 'src/store/eventlog.js',
    from: OWNED_DIRS, to: OWNED_DIRS.replace(", 'archive'", ''), fails: [T.tightenDirs] },
  { id: 'M30 default ~/.orunmila never chmodded on an existing install', file: 'src/store/eventlog.js',
    from: 'if (isDefault || created) targets.push([dir, DIR_MODE]);', to: 'if (created) targets.push([dir, DIR_MODE]);', fails: [T.defaultHome] },
  { id: 'M31 log-state.json written without mode 0600', file: 'src/store/legacy.js',
    from: "fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\\n', { mode: FILE_MODE });",
    to: "fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2) + '\\n');", fails: [T.newFiles] },
  { id: 'M32 warned/ created without mode 0700', file: 'src/store/legacy.js',
    from: 'fs.mkdirSync(wdir, { recursive: true, mode: 0o700 });', to: 'fs.mkdirSync(wdir, { recursive: true });', fails: [T.warnOnce] },
  { id: 'M33 log redact and log delete skip cache/', file: 'src/store/legacy.js',
    from: CONTENT_DIRS, to: CONTENT_DIRS.replace(" 'cache',", ''), fails: [T.redact, T.remove] },
  { id: 'M34 log redact and log delete skip archive/', file: 'src/store/legacy.js',
    from: CONTENT_DIRS, to: CONTENT_DIRS.replace(" 'archive',", ''), fails: [T.redact, T.remove] },
  // Redact the whole text, then cut or diff it, on every path of both witnesses.
  { id: 'M35 command excerpt cut before redaction (Glove)', file: 'src/capture/core.js',
    from: 'stdout_excerpt: clean.text.slice(0, 2000),', to: 'stdout_excerpt: full.slice(0, 2000),', fails: [T.excerptCut] },
  { id: 'M36 tool-result excerpt cut before redaction (Glove)', file: 'src/capture/core.js',
    from: 'event.result_excerpt = clean.text.slice(0, 2000);', to: "event.result_excerpt = String(text || '').slice(0, 2000);", fails: [T.toolCut] },
  { id: 'M37 Sentinel diffs raw file content', file: 'src/capture/fs-sentinel/index.js',
    from: 'diff = unifiedDiff(b.text, a.text, relPath);', to: 'diff = unifiedDiff(change.before, change.after, relPath);', fails: [T.sentinelDiff] },
  { id: 'M39 a count word dropped from the code, not the doc', file: 'src/store/secrets.js',
    from: "'SECONDS', 'MS', 'DAYS']", to: "'SECONDS', 'MS']", fails: [T.count, T.doc] },
  { id: 'M38 command redaction kinds dropped (Glove)', file: 'src/capture/core.js',
    from: 'if (clean.kinds.length) run.redactions = clean.kinds;', to: 'void 0;', fails: [T.excerptCut] },
  // The Witness column: which witness a limit applies to is a tested claim.
  { id: 'M40 SECURITY.md names the wrong witness for the before-state row', file: 'SECURITY.md',
    from: "(it was only in the file's before-state) | Glove |", to: "(it was only in the file's before-state) | Glove and Sentinel |", fails: [T.witness] },
  { id: 'M41 Sentinel drops kinds found only in the before-state', file: 'src/capture/fs-sentinel/index.js',
    from: 'kinds = [...new Set(b.kinds.concat(a.kinds))];', to: 'kinds = a.kinds;', fails: [T.witness] },
  // Survivors of the fifth cold pass, each now killed by a named test.
  { id: 'M42 log redact skips the last-turn report', file: 'src/store/legacy.js',
    from: 'if (fs.existsSync(lastTurn)) scrub(lastTurn);', to: 'void 0;', fails: [T.redact] },
  { id: 'M43 log delete skips the last-turn report', file: 'src/store/legacy.js',
    from: "const CONTENT_FILES = ['events.jsonl', 'last-turn-report.txt'];", to: "const CONTENT_FILES = ['events.jsonl'];", fails: [T.remove] },
  { id: 'M44 log redact and log delete skip laws-state/', file: 'src/store/legacy.js',
    from: CONTENT_DIRS, to: CONTENT_DIRS.replace(", 'laws-state'", ''), fails: [T.redact, T.remove] },
  { id: 'M45 secret_assignment drops the PRIVATE_KEY name', file: 'src/store/secrets.js',
    from: 'SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY', to: 'SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY', fails: [T.count] },
  { id: 'M46 prune writes its temp file without mode 0600', file: 'src/store/eventlog.js',
    from: "(survivors.length ? '\\n' : ''), { mode: FILE_MODE });", to: "(survivors.length ? '\\n' : ''));", fails: [T.prune] },
  { id: 'M47 warned/ marker written without mode 0600', file: 'src/store/legacy.js',
    from: "fs.writeFileSync(marker, '', { flag: 'wx', mode: FILE_MODE });", to: "fs.writeFileSync(marker, '', { flag: 'wx' });", fails: [T.warnOnce] },
  // Survivor of the sixth cold pass.
  { id: 'M49 log redact rewrites a stored file without mode 0600', file: 'src/store/legacy.js',
    from: 'fs.writeFileSync(tmp, out, { mode: FILE_MODE });', to: 'fs.writeFileSync(tmp, out);', fails: [T.redact] },
  // The NF35 fix: your laws.json is owner-only, a project laws file is not.
  { id: 'M48 laws --init writes laws.json without mode 0600 (NF35)', file: 'bin/orunmila.js',
    from: 'userFile ? { mode: 0o600 } : {}', to: '{}', fails: [T.lawsInit] },
  { id: 'M50 laws --init makes a project laws file owner-only too', file: 'bin/orunmila.js',
    from: 'userFile ? { mode: 0o600 } : {}', to: '{ mode: 0o600 }', fails: [T.lawsInit] },
];

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-mutants-'));
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || src === ROOT });
  return dir;
}

/** Run test/secure.js in `dir`; returns the titles of the tests that failed. */
function failingTests(dir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orunmila-mutant-home-'));
  const r = spawnSync('node', [path.join(dir, 'test', 'secure.js')], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ORUNMILA_HOME: home },
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(home, { recursive: true, force: true });
  // The runner prints one line per test: a coloured PASS or FAIL, two spaces, the title.
  return (r.stdout || '')
    .split('\n')
    // eslint-disable-next-line no-control-regex -- strips the runner's ANSI colour codes
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((l) => l.startsWith('FAIL  '))
    .map((l) => l.slice(6));
}

function main() {
  const dir = copyRepo();
  let ok = true;
  try {
    const base = failingTests(dir);
    if (base.length) {
      console.log(`baseline: FAIL (the unmutated copy has ${base.length} failing test(s): ${base.join('; ')})`);
      return 1;
    }
    console.log('baseline: every test passes');
    for (const m of MUTANTS) {
      const p = path.join(dir, m.file);
      const orig = fs.readFileSync(p, 'utf8');
      const hits = orig.split(m.from).length - 1;
      if (hits !== 1) {
        console.log(`ERROR  ${m.id}: its snippet occurs ${hits} times in ${m.file}, not once`);
        ok = false;
        continue;
      }
      fs.writeFileSync(p, orig.replace(m.from, () => m.to));
      const failed = failingTests(dir);
      fs.writeFileSync(p, orig);
      const survived = m.fails.filter((name) => !failed.some((f) => f.startsWith(name)));
      if (survived.length) {
        console.log(`SURVIVED  ${m.id}: still passing: ${survived.join('; ')}`);
        ok = false;
      } else {
        console.log(`killed  ${m.id} (${failed.length} test(s) failed)`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(ok ? `\nmutation gate: PASS (${MUTANTS.length} mutants, all killed as predicted)` : '\nmutation gate: FAIL');
  return ok ? 0 : 1;
}

process.exit(main());
