'use strict';

/**
 * src/babalawo/interface.js — the one interface the judge is read through (brief v4 lines 127, 682; Phase 6 slice
 * BB11, LD274). A stricter or compliance judge (output 3) replaces the default one by name, without touching the Ọpọ́n:
 * the Ọpọ́n reaches the judge only here, at the closeout (src/opon/intake/live.js) and in replay.
 *
 *   register(judge)   adds a judge: { name, version, loadRules(text), judge(input) } with judge(input) giving what
 *                     src/babalawo's judge gives ({ ok, records, added, text } or { ok: false, words }); its name and
 *                     version go into the verdict log it writes. A judge with another shape, or one claiming the
 *                     default's name, is refused (guarantee 7).
 *   get(name)         the judge registered by that name, or null; `babalawo`, the default, is always there
 */

const babalawo = require('./index');

const judges = new Map([[babalawo.name, babalawo]]);

function register(j) {
  if (!j || typeof j.judge !== 'function' || typeof j.loadRules !== 'function') throw new Error('a judge needs judge(input) and loadRules(text)');
  if (typeof j.name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(j.name)) throw new Error('a judge needs a name of lower-case letters, digits, - or _');
  if (typeof j.version !== 'string' || !j.version) throw new Error(`judge ${j.name} needs a version`);
  if (j.name === babalawo.name) throw new Error(`the default judge, ${babalawo.name}, cannot be replaced under its own name`);
  judges.set(j.name, j);
}

const get = (name) => judges.get(name) || null;

module.exports = { register, get, DEFAULT: babalawo.name };
