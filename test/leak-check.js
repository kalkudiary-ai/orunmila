'use strict';

/**
 * test/leak-check.js — the leak check (LD93, LD95). `orunmila leak-check`
 * finds a project's `.env` values in what Orunmila stored and the report files
 * it wrote, and names them without printing a value. Also the limit it
 * answers, declared in SECURITY.md: neither 0.2.x witness redacts a `.env`
 * value of no known format. Every value below is made up.
 */

const { assert, fs, path, tmpHome, tmpDir, rmrf, run, sleep, awaitWatching, it, runAll } = require('./helpers');
const { envValuesFrom } = require('../src/opon/intake/redact');
const lc = require('../src/opon/intake/leak-check');

const CLI = 'bin/orunmila.js';
const POST = 'src/capture/claude-code/post-tool-use.js';
const PLAIN = 'plum-orchard-7731-quiet'; // no secrets.js format
const ODD = `q"u<o>t&e's-value`; // characters JSON and HTML escape
const ENV = [
  `APP_PASSPHRASE=${PLAIN}`,
  `export QUOTED='${ODD}'`,
  'DB_PASSWORD=pw12x',
  'DEBUG=true',
  `ALIAS_PASSPHRASE=${PLAIN}`,
  '# OLD=commented-out-value',
].join('\n') + '\n';
const VALUES = [PLAIN, ODD, 'pw12x'];

const readEvents = (home) => {
  try {
    return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function bashPayload(sessionId, command) {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_leak_1',
    tool_input: { command },
    tool_response: { stdout: 'ok', stderr: '' },
  });
}

it('envEntriesFrom keeps exactly the values the intake redacts, each with its name', () => {
  const entries = lc.envEntriesFrom(ENV);
  assert.deepStrictEqual(entries.map((e) => e.value), envValuesFrom(ENV));
  assert.deepStrictEqual(entries.map((e) => e.name), ['APP_PASSPHRASE', 'QUOTED', 'DB_PASSWORD', 'ALIAS_PASSPHRASE']);
});

it("readEnvEntries reads only the root's own .env files, and merges a value's names", () => {
  const work = tmpDir();
  try {
    fs.writeFileSync(path.join(work, '.env'), ENV);
    fs.writeFileSync(path.join(work, '.env.local'), 'OTHER_KEY=another-long-value-9\n');
    fs.writeFileSync(path.join(work, '.envrc'), 'RC_KEY=rc-value-long-enough\n');
    fs.mkdirSync(path.join(work, 'sub'));
    fs.writeFileSync(path.join(work, 'sub', '.env'), 'NESTED=nested-value-long\n');
    fs.mkdirSync(path.join(work, '.env.d'));
    const { entries, files, unreadable } = lc.readEnvEntries(work);
    assert.deepStrictEqual(files, ['.env', '.env.local']);
    assert.deepStrictEqual(unreadable, [], 'a folder named .env.d is not a .env file to read');
    assert.deepStrictEqual(entries.map((e) => [e.names, e.value]), [
      [['ALIAS_PASSPHRASE', 'APP_PASSPHRASE'], PLAIN],
      [['QUOTED'], ODD],
      [['DB_PASSWORD'], 'pw12x'],
      [['OTHER_KEY'], 'another-long-value-9'],
    ]);
    assert.deepStrictEqual(lc.readEnvEntries(path.join(work, 'missing')), { entries: [], files: [], unreadable: [], sources: [] });
  } finally {
    rmrf(work);
  }
});

it("dotenv's rules: an inline comment ends an unquoted value, a quoted value ends at its quote", () => {
  const text = [
    'API_PASSPHRASE=value-long-1 # rotate monthly',
    'KEY_TWO="quoted long 2"  # note',
    "KEY_THREE='single # kept'   # note",
    "KEY_FOUR='it's inside, long'",
    'HASH_IN=pass#word-long',
    'DB_PASSWORD=pw12x # short, under a secret name',
    'K_SECRET=abcd1234#comment',
    'TICK=`backtick-long-value`',
    'EMPTY_KEY= # set me later',
    'APP_PASSPHRASE=pw12',
  ].join('\n');
  assert.deepStrictEqual(lc.envEntriesFrom(text).map((e) => [e.name, e.value]), [
    ['API_PASSPHRASE', 'value-long-1'],
    ['KEY_TWO', 'quoted long 2'],
    ['KEY_THREE', 'single # kept'],
    ['KEY_FOUR', "it's inside, long"],
    // dotenv cuts at any #, a shell at ' #': both are looked for. `pass` is short and not under a secret name.
    ['HASH_IN', 'pass#word-long'],
    ['DB_PASSWORD', 'pw12x'],
    ['K_SECRET', 'abcd1234'],
    ['K_SECRET', 'abcd1234#comment'],
    ['TICK', 'backtick-long-value'],
  ]);
});

it('a .env that is a link to a file is read; one that cannot be read is listed, never skipped in silence', () => {
  const work = tmpDir();
  const shared = tmpDir();
  try {
    fs.writeFileSync(path.join(shared, 'env'), 'LINKED_KEY=linked-long-value\n');
    fs.symlinkSync(path.join(shared, 'env'), path.join(work, '.env'));
    const r = lc.readEnvEntries(work);
    assert.deepStrictEqual([r.files, r.entries.map((e) => e.value), r.unreadable], [['.env'], ['linked-long-value'], []]);
    // Mode 000 stops a normal user, not root: the check runs where it can mean something.
    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      fs.writeFileSync(path.join(work, '.env.local'), 'LOCKED_KEY=locked-long-value\n', { mode: 0o000 });
      const locked = lc.readEnvEntries(work);
      assert.deepStrictEqual(locked.unreadable, [path.join(work, '.env.local')]);
      const home = tmpHome();
      const cli = run(CLI, { args: ['leak-check'], env: { ORUNMILA_HOME: home }, cwd: work });
      assert.strictEqual(cli.status, 2, cli.stdout + cli.stderr);
      assert.ok(cli.stdout.includes('NOT READ') && cli.stdout.includes('.env.local'), cli.stdout);
      rmrf(home);
    }
  } finally {
    rmrf(work);
    rmrf(shared);
  }
});

it('two spellings of one occurrence count once (a value that starts or ends with \\ or ends with &)', () => {
  const work = tmpDir();
  try {
    const file = path.join(work, 'out.txt');
    const values = ['ends-with-backslash\\', '\\starts-with-backslash', 'ends-with-amp&'];
    fs.writeFileSync(file, `${JSON.stringify({ a: values[0], b: values[1] })}\n<td>ends-with-amp&amp;</td>\n`);
    const hits = lc.scanFile(file, values.map((value, i) => ({ names: [`K${i}`], value })));
    assert.deepStrictEqual(hits.map((h) => [h.names[0], h.count]), [['K0', 1], ['K1', 1], ['K2', 1]]);
  } finally {
    rmrf(work);
  }
});

it('a value is found as written, JSON-escaped once and twice, and HTML-escaped', () => {
  const work = tmpDir();
  try {
    const file = path.join(work, 'out.txt');
    const once = JSON.stringify({ c: ODD });
    const lines = [
      'x',
      once,
      JSON.stringify(once),
      '<td>q&quot;u&lt;o&gt;t&amp;e&#39;s-value</td>',
      ODD,
      // A report page's embedded data: `<` alone, or `<` `>` `&`, as \u escapes.
      'var d = {"c":"q\\"u\\u003co>t&e\'s-value"};',
      'var e = {"c":"q\\"u\\u003co\\u003et\\u0026e\'s-value"};',
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const hits = lc.scanFile(file, [{ names: ['QUOTED'], value: ODD }]);
    assert.deepStrictEqual(hits, [{ names: ['QUOTED'], length: ODD.length, count: 6, line: 2, byte: 7 }]);
    assert.deepStrictEqual(lc.spellings('plain-value-1'), ['plain-value-1'], 'a value nothing escapes has one spelling');
  } finally {
    rmrf(work);
  }
});

it('a value is found inside a longer word: no word rules', () => {
  const work = tmpDir();
  try {
    const file = path.join(work, 'out.txt');
    fs.writeFileSync(file, 'login pw12xy\n');
    assert.deepStrictEqual(lc.scanFile(file, [{ names: ['DB_PASSWORD'], value: 'pw12x' }]), [
      { names: ['DB_PASSWORD'], length: 5, count: 1, line: 1, byte: 7 },
    ]);
  } finally {
    rmrf(work);
  }
});

it('a value across a chunk boundary is found once, at the right line and column, whatever the chunk size', () => {
  const work = tmpDir();
  try {
    const file = path.join(work, 'out.txt');
    fs.writeFileSync(file, 'a\n'.repeat(5) + 'zz' + PLAIN + '\n' + PLAIN + '\nend-marker-x1');
    // A longer value, absent from the file, widens the overlap: a shorter one can start and end inside it.
    // The marker on the last line shows every newline was counted once.
    const entries = [
      { names: ['APP_PASSPHRASE'], value: PLAIN },
      { names: ['LONGER'], value: `${PLAIN}-with-a-much-longer-tail` },
      { names: ['MARK'], value: 'end-marker-x1' },
    ];
    const want = [
      { names: ['APP_PASSPHRASE'], length: PLAIN.length, count: 2, line: 6, byte: 3 },
      { names: ['MARK'], length: 13, count: 1, line: 8, byte: 1 },
    ];
    assert.deepStrictEqual(lc.scanFile(file, entries), want);
    for (let chunk = 1; chunk <= 64; chunk++) assert.deepStrictEqual(lc.scanFile(file, entries, { chunk }), want, `chunk ${chunk}`);
    fs.writeFileSync(file, '');
    assert.deepStrictEqual(lc.scanFile(file, entries), []);
  } finally {
    rmrf(work);
  }
});

it('orunmila leak-check names each leaked value, its file, line and count, and never prints a value', () => {
  const home = tmpHome();
  const work = tmpDir();
  const elsewhere = tmpDir();
  try {
    const env = { ORUNMILA_HOME: home };
    fs.writeFileSync(path.join(work, '.env'), ENV);
    // A command longer than the trail's label, so the whole value is only in the page's embedded data.
    const command = `echo ${'a'.repeat(100)} ${ODD}`;
    assert.strictEqual(run(POST, { input: bashPayload('s-leak', command), env }).status, 0);
    // Real reports, written where `orunmila trail` puts them by default.
    for (const a of [['trail', '--session', 's-leak'], ['trail', '--json', '--session', 's-leak', '--out', path.join(work, 'orunmila-trail-s-leak.json')]]) {
      assert.strictEqual(run(CLI, { args: a, env, cwd: work }).status, 0, a.join(' '));
    }
    fs.writeFileSync(path.join(work, 'notes.html'), ODD); // not a report file name: not scanned unless named
    fs.mkdirSync(path.join(work, '.orunmila-feedback', 's-leak'), { recursive: true });
    fs.writeFileSync(path.join(work, '.orunmila-feedback', 's-leak', 'case.json'), JSON.stringify({ text: `${PLAIN} ${PLAIN}` }));
    const saved = path.join(elsewhere, 'saved.json');
    fs.writeFileSync(saved, '{"x":"pw12x"}');
    const r = run(CLI, { args: ['leak-check', '--path', saved], env, cwd: work });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    const leaks = r.stdout.split('\n').filter((l) => l.includes('LEAK'));
    const real = fs.realpathSync(work);
    const expect = [
      [path.join(home, 'events.jsonl'), `QUOTED (${ODD.length} characters)`, '1 time(s)'],
      [path.join(real, 'orunmila-trail-s-leak.html'), `QUOTED (${ODD.length} characters)`, ''],
      [path.join(real, 'orunmila-trail-s-leak.json'), `QUOTED (${ODD.length} characters)`, ''],
      [path.join(real, '.orunmila-feedback', 's-leak', 'case.json'), 'ALIAS_PASSPHRASE, APP_PASSPHRASE', '2 time(s)'],
      [saved, 'DB_PASSWORD (5 characters)', '1 time(s)'],
    ];
    for (const [file, names, count] of expect) {
      assert.ok(leaks.some((l) => l.includes(`${file} line `) && l.includes(names) && l.includes(count)), `${file}\n${r.stdout}`);
    }
    assert.ok(!leaks.some((l) => l.includes('notes.html')), r.stdout);
    for (const v of VALUES) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), `a value was printed:\n${r.stdout}`);
  } finally {
    rmrf(home);
    rmrf(work);
    rmrf(elsewhere);
  }
});

it('orunmila leak-check exits 0 when clean, and 2 when nothing was checked or a path was not read', () => {
  const home = tmpHome();
  const work = tmpDir();
  try {
    const env = { ORUNMILA_HOME: home };
    const none = run(CLI, { args: ['leak-check'], env, cwd: work });
    assert.strictEqual(none.status, 2, none.stdout);
    assert.ok(none.stdout.includes('No readable .env file') && none.stdout.includes('Nothing was checked.'), none.stdout);
    fs.writeFileSync(path.join(work, '.env'), 'DEBUG=true\nPORT=3000\n');
    const short = run(CLI, { args: ['leak-check'], env, cwd: work });
    assert.strictEqual(short.status, 2, short.stdout);
    assert.ok(short.stdout.includes('No value in .env is long enough'), short.stdout);
    fs.writeFileSync(path.join(work, '.env'), ENV);
    fs.writeFileSync(path.join(home, 'events.jsonl'), '{"type":"user_prompt","text":"hi"}\n');
    // The project folder itself, .env included: the .env files are never scanned.
    const clean = run(CLI, { args: ['leak-check', '--path', work], env, cwd: work });
    assert.strictEqual(clean.status, 0, clean.stdout);
    assert.ok(clean.stdout.includes('No value found.') && clean.stdout.includes('against 1 file(s)'), clean.stdout);
    const missing = path.join(work, 'no-such-export.json');
    const unread = run(CLI, { args: ['leak-check', '--path', missing], env, cwd: work });
    assert.strictEqual(unread.status, 2, unread.stdout);
    assert.ok(unread.stdout.includes(`NOT READ  ${missing}`) && unread.stdout.includes('not a clean result'), unread.stdout);
    // One file reached by two spellings (a link to the folder) is read once.
    fs.writeFileSync(path.join(work, 'orunmila-x.json'), '{"clean":true}');
    const link = path.join(tmpDir(), 'link');
    fs.symlinkSync(work, link);
    const twice = run(CLI, { args: ['leak-check', '--path', path.join(link, 'orunmila-x.json')], env, cwd: work });
    assert.strictEqual(twice.status, 0, twice.stdout);
    assert.ok(twice.stdout.includes('against 2 file(s)'), twice.stdout);
    rmrf(path.dirname(link));
    // A --path with no value is a usage error, never a clean run.
    for (const bad of [['--path'], ['--path=x.json'], ['--paths', 'x.json']]) {
      const r = run(CLI, { args: ['leak-check', ...bad], env, cwd: work });
      assert.strictEqual(r.status, 2, r.stdout);
      assert.ok(r.stdout.includes(`not understood: ${bad[0]}`), r.stdout);
    }
    // Any other file is read, whatever its name: a .env.bak in the data dir is found (--root from elsewhere).
    fs.writeFileSync(path.join(home, '.env.bak'), `OLD=${PLAIN}\n`);
    const bak = run(CLI, { args: ['leak-check', '--root', work], env, cwd: path.dirname(work) });
    assert.strictEqual(bak.status, 1, bak.stdout);
    assert.ok(bak.stdout.includes(`${path.join(home, '.env.bak')} line 1`), bak.stdout);
    fs.rmSync(path.join(home, '.env.bak'));
    // No data dir and no report file: nothing was read, so not clean.
    fs.rmSync(path.join(work, 'orunmila-x.json'));
    const empty = run(CLI, { args: ['leak-check'], env: { ORUNMILA_HOME: path.join(home, 'absent') }, cwd: work });
    assert.strictEqual(empty.status, 2, empty.stdout);
    assert.ok(empty.stdout.includes('No file was checked'), empty.stdout);
    assert.ok(!fs.existsSync(path.join(home, 'absent')), 'leak-check created the data dir');
    // A symbolic link inside the data dir is listed, never followed, and the result is not clean.
    fs.symlinkSync(path.join(work, '.env'), path.join(home, 'linked'));
    const linked = run(CLI, { args: ['leak-check'], env, cwd: work });
    assert.strictEqual(linked.status, 2, linked.stdout);
    assert.ok(linked.stdout.includes(`NOT READ  ${path.join(home, 'linked')}`), linked.stdout);
  } finally {
    rmrf(home);
    rmrf(work);
  }
});

it('the declared limit: the Glove and the Sentinel both record a .env value of no known format', async () => {
  const { startSentinel } = require('../src/capture/fs-sentinel');
  const home = tmpHome();
  const work = tmpDir();
  try {
    assert.strictEqual(run(POST, { input: bashPayload('s-glove', `mytool --passphrase ${PLAIN}`), env: { ORUNMILA_HOME: home } }).status, 0);
    const glove = readEvents(home).find((e) => e.type === 'command_run');
    assert.ok(glove && JSON.stringify(glove).includes(PLAIN), 'the Glove redacted a value of no known format');
    const file = path.join(work, 'notes.txt');
    fs.writeFileSync(file, 'old line\n');
    const sentinel = startSentinel({ root: work, log: () => {} });
    try {
      const seen = (p) => readEvents(home).some((e) => e.source === 'fs-sentinel' && JSON.stringify(e).includes(path.basename(p)));
      assert.ok(await awaitWatching(work, seen), 'the Sentinel never started delivering events');
      fs.writeFileSync(file, `old line\npassphrase ${PLAIN}\n`);
      const end = Date.now() + 5000;
      const disk = () => readEvents(home).find((e) => e.source === 'fs-sentinel' && JSON.stringify(e).includes('notes.txt'));
      while (!disk() && Date.now() < end) await sleep(50);
      assert.ok(disk(), 'the Sentinel recorded no write to notes.txt');
      assert.ok(JSON.stringify(disk()).includes(PLAIN), 'the Sentinel redacted a value of no known format');
    } finally {
      sentinel.stop();
    }
  } finally {
    rmrf(home);
    rmrf(work);
  }
});

it('the limits table in SECURITY.md declares the .env row, both witnesses, and the leak check', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'SECURITY.md'), 'utf8');
  const row = doc.split('\n').find((l) => l.startsWith('| A value from your `.env` file'));
  assert.ok(row, 'no .env row in the SECURITY.md limits table');
  assert.strictEqual(row.split(' | ')[1], 'Glove and Sentinel', row);
  assert.ok(row.includes('`orunmila leak-check`'), row);
});

runAll('leak-check (LD93, LD95: .env values in stored data and reports)');
