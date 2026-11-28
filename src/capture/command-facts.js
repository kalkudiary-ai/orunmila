// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/command-facts.js — CF1 (LD385; O, 2026-11-28: the in-roads into what Orunmila does not see, "all except
 * the one that needs admin rights"): facts read from a command's own text, the agent's testimony, never proof of what
 * ran. Plain code, no model; the same answer on every OS.
 *
 *   hostsNamed(text) -> [host]    every host the command line names: a URL's host (with its port), and the host of a
 *                                 `user@host` argument to ssh, scp, sftp, rsync or git; sorted, each once. A name is not
 *                                 a contact: a command can name a host it never reaches, and reach one it never names.
 *   asksElevation(text) -> bool   true when a step of the command line starts with sudo, doas, su, pkexec, runas or
 *                                 gsudo (after variable assignments and the wrappers env, command, exec, nohup, time): it
 *                                 asked for administrator rights, and what it did with them is outside what Orunmila sees.
 */

const URL_RE = /\b(?:https?|ftps?|wss?|git|ssh|sftp|rsync):\/\/[^\s'"`<>|;&()]+/gi;
const ELEVATORS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas', 'gsudo']);
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time']);
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'rsync', 'git']);

/** The command line's steps: split where a shell starts a new command (newline, ;, &, |, && and ||), each as words. */
function steps(text) {
  return String(text || '')
    .split(/\n|&&|\|\||[;&|]/)
    .map((s) => s.replace(/^[\s({]+/, '').trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/));
}

/** A step's command word: past `NAME=value` assignments and the wrappers. */
function commandWord(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return { word: words[i] ? words[i].replace(/^.*[\\/]/, '') : '', rest: words.slice(i + 1) };
}

function hostsNamed(text) {
  const hosts = new Set();
  for (const m of String(text || '').match(URL_RE) || []) {
    try {
      const h = new URL(m).host;
      if (h) hosts.add(h.toLowerCase());
    } catch {
      /* not a URL after all */
    }
  }
  for (const words of steps(text)) {
    const { word, rest } = commandWord(words);
    if (!REMOTE.has(word)) continue;
    for (const w of rest) {
      const m = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)(?::|$)/.exec(w);
      if (m) hosts.add(m[1].toLowerCase());
    }
  }
  return [...hosts].sort();
}

function asksElevation(text) {
  return steps(text).some((words) => ELEVATORS.has(commandWord(words).word));
}

module.exports = { hostsNamed, asksElevation, steps, commandWord };
