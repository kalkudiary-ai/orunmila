// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/capture/outside-tripwire.js — CF4 (LD385): a tripwire on the files outside the watched folders that run code as
 * you. They are fingerprinted at session start (the header's `tripwire`) and again at the closeout, which names each
 * path whose fingerprint changed: its path and fingerprints, never its content. Plain code, no model.
 *
 *   tripwirePaths(home, platform, env) -> [{ path, kind: 'file' | 'dir' }]
 *     every OS: the shell start-up files (bash, zsh, sh, fish), git's and ssh's own config, ssh's authorized_keys and
 *     rc, ~/.npmrc, and the agents' own user hook settings (Claude Code, Cursor, Gemini CLI, Codex); macOS
 *     ~/Library/LaunchAgents; Linux ~/.config/systemd/user and ~/.config/autostart; Windows the Startup folder
 *     (%APPDATA%) and the PowerShell profiles.
 *   tripwireFingerprints(paths, key) -> { '<path with / separators>': fingerprint | null }
 *     keyed HMAC-SHA-256 with the install key, so no fingerprint confirms a guessed secret (an rc file can hold a
 *     token); null when nothing is there. A file is its bytes (one followed link included); a folder is every entry
 *     under it, four levels deep: each file's bytes, each link's target, each folder's name, so a link added to a
 *     start-up folder changes it.
 *   tripwireChanges(before, after) -> [{ path, fingerprint_before, fingerprint }] sorted by path
 *
 * Limits: only these paths, only twice (a change made and put back between the two reads is not seen), and not who
 * made the change: the agent, you, or another program.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 16 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 10000;

const FILES = [
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout',
  '.config/fish/config.fish', '.gitconfig', '.config/git/config', '.ssh/config', '.ssh/authorized_keys', '.ssh/authorized_keys2',
  '.ssh/rc', '.npmrc', '.claude/settings.json', '.cursor/hooks.json', '.gemini/settings.json', '.codex/config.toml',
];

function tripwirePaths(home, platform = process.platform, env = process.env) {
  const out = FILES.map((f) => ({ path: path.join(home, ...f.split('/')), kind: 'file' }));
  if (platform === 'darwin') out.push({ path: path.join(home, 'Library', 'LaunchAgents'), kind: 'dir' });
  if (platform === 'linux') out.push({ path: path.join(home, '.config', 'systemd', 'user'), kind: 'dir' }, { path: path.join(home, '.config', 'autostart'), kind: 'dir' });
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    out.push({ path: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), kind: 'dir' });
    for (const d of ['PowerShell', 'WindowsPowerShell']) out.push({ path: path.join(home, 'Documents', d, 'Microsoft.PowerShell_profile.ps1'), kind: 'file' });
  }
  return out;
}

/** What one path holds, as lines to fingerprint: null when nothing is there. */
function contentOf(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (st.isFile()) {
    if (st.size > MAX_FILE) return [`too large ${st.size}`];
    try {
      return [fs.readFileSync(p)];
    } catch (e) {
      return [`unreadable ${e.code || ''}`];
    }
  }
  if (!st.isDirectory()) return ['not a file or folder'];
  const lines = [];
  const walk = (d, rel, depth) => {
    let names;
    try {
      names = fs.readdirSync(d).sort();
    } catch (e) {
      lines.push(`unreadable ${rel} ${e.code || ''}`);
      return;
    }
    for (const n of names) {
      if (lines.length >= MAX_ENTRIES) return lines.push('cut');
      const abs = path.join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      let l;
      try {
        l = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (l.isSymbolicLink()) {
        let to = '';
        try {
          to = fs.readlinkSync(abs);
        } catch {
          /* a link that cannot be read is still a link */
        }
        lines.push(`l ${r} -> ${to}`);
      } else if (l.isDirectory()) {
        lines.push(`d ${r}`);
        if (depth < MAX_DEPTH) walk(abs, r, depth + 1);
      } else if (l.isFile()) {
        let sum;
        try {
          sum = l.size > MAX_FILE ? `too large ${l.size}` : crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        } catch (e) {
          sum = `unreadable ${e.code || ''}`;
        }
        lines.push(`f ${r} ${sum}`);
      } else lines.push(`o ${r}`);
    }
  };
  walk(p, '', 1);
  return ['folder\n', lines.join('\n')];
}

const slash = (p) => String(p).split(path.sep).join('/');

function tripwireFingerprints(paths, key) {
  if (!key || !key.length) throw new Error('the tripwire needs the install key');
  const out = {};
  for (const e of paths) {
    const p = typeof e === 'string' ? e : e.path;
    const parts = contentOf(p);
    if (parts === null) out[slash(p)] = null;
    else {
      const h = crypto.createHmac('sha256', key);
      for (const part of parts) h.update(part);
      out[slash(p)] = 'hmac-sha256:' + h.digest('hex');
    }
  }
  return out;
}

function tripwireChanges(before, after) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const out = [];
  for (const k of keys) {
    const a = before && k in before ? before[k] : null;
    const b = after && k in after ? after[k] : null;
    if (a !== b) out.push({ path: k, fingerprint_before: a, fingerprint: b });
  }
  return out;
}

module.exports = { tripwirePaths, tripwireFingerprints, tripwireChanges };
