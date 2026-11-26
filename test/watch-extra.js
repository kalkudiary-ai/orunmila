// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * test/watch-extra.js — the session header names the extra folders the Sentinel watched (Q42, approved by O 2026-11-25,
 * LD299; LD289; Q12 (a)). With ORUNMILA_WATCH_EXTRA (off by default) the intake's Sentinel watches folders outside the
 * project too; the header's config.watch_extra lists the ones this session's Sentinel watched, so replay reads an
 * outside file there that the Sentinel saw no change to as `saw_nothing`, not `out_of_scope`, and a report can say
 * exactly which folders were watched. With none, the header has no such field, as before. Throwaway folders; hand-built
 * marks with made-up paths (brief line 761).
 */

const { assert, fs, path, tmpDir, rmrf, it, runAll } = require('./helpers');
const { makeLog, M } = require('./helpers-opon');
const { createRouter } = require('../src/opon/intake/router');
const { replayFolder } = require('../src/opon/replay');
const { compile, closed } = require('../src/verify/schema');

const headerSchema = compile(closed(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'session-header.schema.json'), 'utf8'))));
const MS = 1000000n;
const asPosix = (p) => p.split(path.sep).join('/');

function routerWith(home, watchExtra) {
  let mono = 5000n * MS;
  const clock = () => ({ mono: (mono += MS).toString(), wall: new Date(Date.UTC(2026, 10, 26, 9, 0, 0)).toISOString() });
  return createRouter({ home, clock, checkSender: () => true, codeRoot: path.join(__dirname, '..', 'src'), orunmilaVersion: '0.0.0-test', installKey: Buffer.alloc(32, 7), hookSettingsFor: () => [], sentinel: true, watchExtra });
}

function headerOf(home, sid) {
  return JSON.parse(fs.readFileSync(path.join(home, 'sessions', sid, 'raw.jsonl'), 'utf8').split('\n')[0]);
}

it('Q42: the header lists the extra folders this session\'s Sentinel watched, as real absolute paths with / separators, sorted; one holding the project is left out; with none, no field', () => {
  const base = fs.realpathSync(tmpDir());
  const project = path.join(base, 'work', 'project');
  const extraB = path.join(base, 'notes-b');
  const extraA = path.join(base, 'notes-a');
  for (const d of [project, extraA, extraB]) fs.mkdirSync(d, { recursive: true });
  const home = path.join(base, 'home');
  const router = routerWith(home, [extraB, path.join(base, 'work'), extraA]); // `work` holds the project: never watched twice
  try {
    const r = router.payload({ session_id: 'ses_q42', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const h = headerOf(home, 'ses_q42');
    assert.deepStrictEqual(h.config.watch_extra, [asPosix(extraA), asPosix(extraB)]);
    assert.deepStrictEqual(headerSchema(h), [], 'a header the spec declares, field by field');
  } finally {
    router.stop('test');
  }
  const plain = routerWith(path.join(base, 'home2'), []);
  try {
    plain.payload({ session_id: 'ses_plain', transcript_path: '/tmp/t.jsonl', cwd: project, hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { channel: 'command' });
    assert.ok(!('watch_extra' in headerOf(path.join(base, 'home2'), 'ses_plain').config), 'no extra folders: no field, so the header is as before');
  } finally {
    plain.stop('test');
    rmrf(base);
  }
});

/** One session replayed: a Glove edit of an outside file, nothing from the Sentinel; returns that file's odù. */
function outsideEdit(config, file) {
  const base = tmpDir();
  try {
    const s = makeLog(base, config);
    s.append({ ...M.edited(1000, 'e1', file), target: { kind: 'file', path: file, outside: true } });
    s.append(M.turnEnded(1100));
    s.append(M.tick(20000));
    const r = replayFolder(s.dir);
    assert.strictEqual(r.ok, true, r.words);
    const odus = r.odu.split('\n').slice(1, -1).map((l) => JSON.parse(l));
    return odus.find((o) => o.target && o.target.kind === 'file' && o.target.path === file);
  } finally {
    rmrf(base);
  }
}

it('Q42: replay reads an outside file in a watched extra folder that the Sentinel saw no change to as saw_nothing (with unconfirmed_by_filesystem); outside every watched folder, out_of_scope as before', () => {
  const watched = outsideEdit({ watch_extra: ['/made/up/notes'] }, '/made/up/notes/todo.md');
  const ws = (o) => [o.witness_status.sentinel.status, o.witness_status.sentinel.scope]; // the odù writer adds mark_seqs to every witness
  assert.deepStrictEqual(ws(watched), ['saw_nothing', undefined]);
  assert.deepStrictEqual(watched.conflicts.map((c) => c.kind), ['unconfirmed_by_filesystem'], 'the Sentinel watched that folder and saw nothing: the Glove\'s edit is unconfirmed');
  const elsewhere = outsideEdit({ watch_extra: ['/made/up/notes'] }, '/made/up/notes-old/todo.md');
  assert.deepStrictEqual(ws(elsewhere), ['out_of_scope', 'outside_root'], 'a folder name that only starts the same is not inside it');
  const none = outsideEdit({}, '/made/up/notes/todo.md');
  assert.deepStrictEqual(ws(none), ['out_of_scope', 'outside_root'], 'no field: as before');
  assert.deepStrictEqual(none.conflicts, []);
});

runAll('watch-extra');
