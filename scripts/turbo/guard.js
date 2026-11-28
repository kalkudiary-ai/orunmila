// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/turbo/guard.js — TURBO's PreToolUse guard (LD109, layer 2).
 *
 * Runs before every tool call of a TURBO session and refuses the hard stops,
 * so an unattended session cannot take them: it queues them for O instead.
 * It fails closed: input it cannot read, or a shell command it cannot parse,
 * is refused.
 *
 * Refused, by kind (the kind is what the session puts in its queue item):
 *   push, merge, branch-switch, publish     CLAUDE.md "How to work" 9, Leopard rule 5
 *   live-copy        any write, or any shell word, inside ~/tools/orunmila
 *   destructive      history rewrites, stash, clean, recursive rm outside scratch, kill
 *   hook-settings    .claude/ settings and git config writes (they change capture)
 *   self-edit        TURBO's own code (scripts/turbo/) during a run
 *   secret           secret files, printenv/env/export with no command
 *   admin, network, outward, no-grep (O's core rule), outside-tree, unparsed
 *
 * Shell commands are parsed, not searched: every step of a list or pipeline,
 * every $(...) and `...`, a heredoc fed to a shell, `bash -c`, `eval`, and the
 * command after wrappers (env, nohup, timeout, xargs, command, ...) is checked
 * as a command. Known limit: code a script or `node -e` runs is not read here;
 * the git hooks and the npm dry-run setting (LD109 layers 3 and 4) still hold.
 *
 * Hook contract: JSON on stdin; exit 0 allows; exit 2 refuses, reason on stderr.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// --- paths ----------------------------------------------------------------------

/** The real path of p, resolving symlinks through its nearest existing ancestor. */
function real(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.slice().reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

function resolveWord(word, cwd) {
  if (word === '~') return os.homedir();
  if (word.startsWith('~/')) return real(path.join(os.homedir(), word.slice(2)));
  return real(path.resolve(cwd, word));
}

const looksLikePath = (w) => w.startsWith('/') || w.startsWith('~') || w.startsWith('./') || w.startsWith('../') || w.includes('/');

const SECRET_ALLOWED = new Set(['.env.example', '.env.sample', '.env.template']);
function isSecretName(p) {
  const b = path.basename(p);
  if (SECRET_ALLOWED.has(b)) return false;
  if (/^\.env(\..+)?$/.test(b)) return true;
  if (['.npmrc', '.netrc', '.pgpass', '.git-credentials', 'credentials.json'].includes(b)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)$/.test(b)) return true;
  return /\.(pem|p12|pfx|key)$/.test(b);
}

// --- shell parsing ------------------------------------------------------------

class ParseError extends Error {}

/**
 * Parse a shell command into simple commands: [{ argv, redirs, body }]. Nested
 * $(...), `...` and process substitutions add their own commands to the list;
 * `body` is a heredoc's text. Throws ParseError on what it cannot model.
 */
function parseShell(src) {
  const s = String(src);
  const cmds = [];
  let i = 0;
  const fail = (m) => {
    throw new ParseError(m);
  };

  function readSeq(closer) {
    let cur = { argv: [], redirs: [], body: null };
    let word = null;
    let redirNext = false;
    let skipNext = false;
    let pending = [];
    const pushWord = () => {
      if (word === null) return;
      if (skipNext) skipNext = false;
      else if (redirNext) {
        cur.redirs.push(word);
        redirNext = false;
      } else cur.argv.push(word);
      word = null;
    };
    const endCmd = () => {
      pushWord();
      if (redirNext || skipNext) fail('a redirection with no target');
      if (cur.argv.length || cur.redirs.length) cmds.push(cur);
      cur = { argv: [], redirs: [], body: null };
    };
    const readBodies = () => {
      for (const h of pending) {
        const lines = [];
        for (;;) {
          if (i >= s.length) fail('unterminated heredoc');
          let e = s.indexOf('\n', i);
          if (e < 0) e = s.length;
          const line = s.slice(i, e);
          i = Math.min(e + 1, s.length);
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.cmd.body = lines.join('\n');
      }
      pending = [];
    };
    const add = (text) => {
      word = (word === null ? '' : word) + text;
    };

    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') {
        if (s[i + 1] === '\n') {
          i += 2;
          continue;
        }
        if (i + 1 >= s.length) fail('a trailing backslash');
        add(s[i + 1]);
        i += 2;
        continue;
      }
      if (ch === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) fail('an unclosed quote');
        add(s.slice(i + 1, j));
        i = j + 1;
        continue;
      }
      if (ch === '"') {
        i++;
        let buf = '';
        for (;;) {
          if (i >= s.length) fail('an unclosed quote');
          const c = s[i];
          if (c === '"') {
            i++;
            break;
          }
          if (c === '\\' && i + 1 < s.length) {
            buf += s[i + 1];
            i += 2;
          } else if (c === '$' && s[i + 1] === '(') {
            i += 2;
            readSeq(')');
            buf += '$(...)';
          } else if (c === '`') {
            i++;
            readSeq('`');
            buf += '`...`';
          } else {
            buf += c;
            i++;
          }
        }
        add(buf);
        continue;
      }
      if (ch === '$' && s[i + 1] === '(') {
        i += 2;
        readSeq(')');
        add('$(...)');
        continue;
      }
      if (ch === '`') {
        i++;
        if (closer === '`') {
          endCmd();
          if (pending.length) fail('a heredoc inside backticks');
          return;
        }
        readSeq('`');
        add('`...`');
        continue;
      }
      if (ch === ')') {
        i++;
        endCmd();
        if (closer === ')') {
          if (pending.length) fail('an unterminated heredoc');
          return;
        }
        continue;
      }
      if (ch === '(') {
        endCmd();
        i++;
        continue;
      }
      if (ch === ' ' || ch === '\t') {
        pushWord();
        i++;
        continue;
      }
      if (ch === '\n') {
        endCmd();
        i++;
        if (pending.length) readBodies();
        continue;
      }
      if (ch === ';' || ch === '|' || ch === '&') {
        if (ch === '&' && s[i + 1] === '>') {
          pushWord();
          i += s[i + 2] === '>' ? 3 : 2;
          redirNext = true;
          continue;
        }
        endCmd();
        i += s[i + 1] === ch || (ch === '|' && s[i + 1] === '&') ? 2 : 1;
        continue;
      }
      if (ch === '<' || ch === '>') {
        if (word !== null && /^[0-9]+$/.test(word)) word = null;
        else pushWord();
        if ((ch === '<' || ch === '>') && s[i + 1] === '(') {
          i += 2;
          readSeq(')');
          add('<(...)');
          continue;
        }
        if (ch === '<' && s[i + 1] === '<') {
          if (s[i + 2] === '<') {
            i += 3;
            skipNext = true; // a herestring: the next word is data
            continue;
          }
          i += 2;
          let strip = false;
          if (s[i] === '-') {
            strip = true;
            i++;
          }
          while (s[i] === ' ' || s[i] === '\t') i++;
          let d = '';
          while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
            if (s[i] === "'" || s[i] === '"') {
              const j = s.indexOf(s[i], i + 1);
              if (j < 0) fail('an unclosed quote');
              d += s.slice(i + 1, j);
              i = j + 1;
            } else {
              if (s[i] === '\\') i++;
              d += s[i++];
            }
          }
          if (!d) fail('a heredoc with no delimiter');
          pending.push({ delim: d, strip, cmd: cur });
          continue;
        }
        i++;
        if (s[i] === '>' || s[i] === '|') i++;
        if (s[i] === '&') {
          i++;
          while (i < s.length && /[0-9-]/.test(s[i])) i++;
          continue;
        }
        redirNext = true;
        continue;
      }
      if (ch === '#' && word === null) {
        while (i < s.length && s[i] !== '\n') i++;
        continue;
      }
      add(ch);
      i++;
    }
    if (closer) fail(`an unclosed ${closer === ')' ? '$(' : '`'}`);
    endCmd();
    if (pending.length) fail('an unterminated heredoc');
  }

  readSeq(null);
  return cmds;
}

// --- unwrapping ------------------------------------------------------------------

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const base = (w) => path.basename(w);

// Wrappers that run the rest of their argv as a command, and their options that take a value.
const WRAPPERS = {
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  nice: ['-n'],
  caffeinate: ['-t', '-w'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '-J', '-R', '-S'],
};

/** The argv of the command a wrapper runs, after leading assignments; [] if none. */
function unwrap(argv) {
  let a = argv.filter((w) => w !== '{' && w !== '}' && w !== '!');
  for (let guard = 0; guard < 16; guard++) {
    while (a.length && ASSIGN.test(a[0])) a = a.slice(1);
    if (!a.length) return a;
    const n = base(a[0]);
    if (n === 'env') {
      a = a.slice(1);
      while (a.length && (a[0].startsWith('-') || ASSIGN.test(a[0]))) a = a.slice(a[0] === '-u' || a[0] === '-S' || a[0] === '-C' ? 2 : 1);
      if (!a.length) return ['env'];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(WRAPPERS, n)) {
      const valued = WRAPPERS[n];
      a = a.slice(1);
      while (a.length && a[0].startsWith('-')) a = a.slice(valued.includes(a[0]) ? 2 : 1);
      if (n === 'timeout') a = a.slice(1); // the duration
      if (!a.length) return n === 'xargs' ? ['echo'] : [];
      continue;
    }
    return a;
  }
  return a;
}

// --- policy -----------------------------------------------------------------------

const deny = (kind, reason) => ({ allow: false, kind, reason });
const ALLOW = { allow: true };

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const ADMIN = new Set(['sudo', 'doas', 'su', 'launchctl', 'shutdown', 'reboot', 'halt', 'systemsetup', 'dscl', 'crontab', 'osascript', 'chown']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat', 'telnet', 'ftp']);
const GREP = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const WRITERS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'ln', 'install', 'tee', 'touch', 'chmod', 'truncate', 'dd', 'mkdir', 'patch']);
const NPM_PUBLISH = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'adduser', 'login', 'logout', 'token', 'version']);
const NPM_INSTALL = new Set(['install', 'i', 'ci', 'add', 'update', 'upgrade', 'up', 'uninstall', 'remove', 'rm', 'un', 'dedupe', 'link']);
const GIT_GLOBAL_VALUED = new Set(['-C', '-c', '--namespace', '--git-dir', '--work-tree', '--exec-path']);

function gitVerdict(args, cwd) {
  let k = 0;
  while (k < args.length && args[k].startsWith('-')) k += GIT_GLOBAL_VALUED.has(args[k]) ? 2 : 1;
  const sub = args[k];
  const rest = args.slice(k + 1);
  const has = (...f) => rest.some((a) => f.includes(a));
  const positional = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case undefined:
      return ALLOW;
    case 'push':
      return deny('push', 'git push needs O (CLAUDE.md "How to work" 9)');
    case 'merge':
    case 'pull':
      return deny('merge', `git ${sub} merges; a merge into main is a release and needs O`);
    case 'fetch':
    case 'clone':
    case 'ls-remote':
      return deny('network', `git ${sub} reaches the network`);
    case 'switch':
    case 'checkout':
      return deny('branch-switch', `git ${sub} switches branches or discards work; the worktree stays on its branch (and \`checkout --\` has no undo)`);
    case 'symbolic-ref':
      return positional.length >= 2 ? deny('branch-switch', 'git symbolic-ref moves HEAD') : ALLOW;
    case 'update-ref':
      if (has('-d', '--delete')) return deny('destructive', 'git update-ref -d deletes a ref');
      if (positional.some((a) => a === 'main' || a === 'refs/heads/main')) return deny('merge', 'an update to main is a release');
      return ALLOW;
    case 'reset': {
      if (has('--hard', '--merge', '--keep', '--soft')) return deny('destructive', 'git reset with a mode moves the branch or discards work');
      const dd = rest.indexOf('--');
      const before = (dd < 0 ? rest : rest.slice(0, dd)).filter((a) => !a.startsWith('-'));
      if (!before.length || before[0] === 'HEAD') return ALLOW;
      if (before.every((a) => fs.existsSync(path.resolve(cwd, a)))) return ALLOW;
      return deny('destructive', 'git reset <commit> moves the branch');
    }
    case 'stash':
    case 'clean':
    case 'filter-branch':
    case 'filter-repo':
    case 'gc':
    case 'prune':
    case 'replace':
      return deny('destructive', `git ${sub} can lose work (and the stash stack is shared with other sessions)`);
    case 'reflog':
      return has('expire', 'delete') || positional.some((a) => a === 'expire' || a === 'delete') ? deny('destructive', 'git reflog expire/delete loses history') : ALLOW;
    case 'branch':
      return has('-d', '-D', '--delete', '-f', '--force', '-m', '-M', '--move', '-c', '-C', '--copy') ? deny('destructive', 'git branch delete/move/force') : ALLOW;
    case 'tag':
      return has('-d', '--delete', '-f', '--force') ? deny('destructive', 'git tag delete/force') : ALLOW;
    case 'commit':
      return has('--amend') ? deny('destructive', 'git commit --amend rewrites a commit; fix an error as its own slice (Leopard rule 2)') : ALLOW;
    case 'restore':
      if (!has('--staged', '-S') || has('--worktree', '-W')) return deny('destructive', 'git restore of the working tree discards work');
      return ALLOW;
    case 'worktree':
      return ['remove', 'prune', 'move'].includes(positional[0]) ? deny('destructive', `git worktree ${positional[0]}`) : ALLOW;
    case 'config':
      return has('--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--get-urlmatch') ? ALLOW : deny('hook-settings', 'git config writes can turn off TURBO\'s git hooks');
    case 'grep':
      return deny('no-grep', 'no grep at all (O\'s core rule): read whole files or parse structured fields');
    default:
      return ALLOW;
  }
}

/** Checks on one simple command, after unwrapping. Returns a deny or null. */
function commandVerdict(argv, cmd, ctx, cwd, depth) {
  if (!argv.length) return null;
  const n = base(argv[0]);
  const args = argv.slice(1);
  if (SHELLS.has(n)) {
    const c = args.indexOf('-c');
    if (c >= 0) return c + 1 < args.length ? shellVerdict(args[c + 1], ctx, cwd, depth + 1) : deny('unparsed', `${n} -c with no script`);
    if (cmd.body !== null) return shellVerdict(cmd.body, ctx, cwd, depth + 1);
    return null;
  }
  if (n === 'eval') return shellVerdict(args.join(' '), ctx, cwd, depth + 1);
  if (ADMIN.has(n)) return deny('admin', `${n} needs O (administrator rights or system settings)`);
  if (n === 'defaults' && args[0] === 'write') return deny('admin', 'defaults write changes system settings');
  if (n === 'open') return deny('outward', 'open hands a file or URL to another app');
  if (NETWORK.has(n)) return deny('network', `${n} reaches the network`);
  if (GREP.has(n)) return deny('no-grep', 'no grep at all (O\'s core rule): read whole files or parse structured fields');
  if (n === 'printenv' || n === 'env') return deny('secret', `${n} prints the environment, which can hold secrets`);
  if ((n === 'export' || n === 'set' || n === 'declare' || n === 'typeset') && (args.length === 0 || args.every((a) => a.startsWith('-')))) {
    return deny('secret', `${n} with no names prints the environment`);
  }
  if (n === 'security' && args.some((a) => a.startsWith('find-') || a === 'dump-keychain')) return deny('secret', 'security reads the keychain');
  if (n === 'kill' || n === 'pkill' || n === 'killall') return deny('destructive', `${n} can stop the driver or a peer session's run`);
  if (n === 'npm' || n === 'pnpm' || n === 'yarn') {
    const sub = args.find((a) => !a.startsWith('-'));
    if (NPM_PUBLISH.has(sub)) return deny('publish', `${n} ${sub} needs O`);
    if (NPM_INSTALL.has(sub)) return deny('network', `${n} ${sub} changes dependencies from the network`);
    return null;
  }
  if (n === 'gh') {
    const action = args[1];
    return ['view', 'list', 'status', 'checks', 'diff'].includes(action) ? null : deny('outward', `gh ${args.slice(0, 2).join(' ')} acts on GitHub`);
  }
  if (n === 'git') return gitVerdict(args, cwd).allow ? null : gitVerdict(args, cwd);
  if (n === 'rm' && args.some((a) => a === '--recursive' || /^-[a-zA-Z]*[rR]/.test(a))) {
    const targets = args.filter((a) => !a.startsWith('-')).map((a) => resolveWord(a, cwd));
    const ok = (p) => inside(p, ctx.home) || ctx.scratch.some((d) => inside(p, d));
    if (!targets.length || !targets.every(ok)) return deny('destructive', 'recursive rm outside TURBO_HOME and scratch');
  }
  return null;
}

/** Where a write to p lands, as a deny, or null if it is allowed. */
function writeVerdict(p, ctx) {
  if (inside(p, ctx.live)) return deny('live-copy', `${p} is in the live copy; never edit it (CLAUDE.md "The live copy")`);
  if (inside(p, ctx.self)) return deny('self-edit', `${p} is TURBO's own code; it is not changed during a run`);
  if (inside(p, path.join(ctx.root, '.claude'))) return deny('hook-settings', `${p} holds the hook settings; a change there changes capture`);
  if (inside(p, path.join(ctx.root, '.git'))) return deny('destructive', `${p} is inside .git`);
  if (inside(p, path.join(ctx.home, 'driver'))) return deny('self-edit', `${p} is the driver's own record; only the driver writes it`);
  if (['inbox.md', 'STOP', 'PAUSE'].some((n) => p === path.join(ctx.home, n))) return deny('o-inbox', `${p} is O's: only O writes it`);
  return null;
}

function shellVerdict(command, ctx, cwd, depth = 0) {
  if (depth > 8) return deny('unparsed', 'commands nested too deep to check');
  let cmds;
  try {
    cmds = parseShell(command);
  } catch (err) {
    if (err instanceof ParseError) return deny('unparsed', `the guard could not parse this command (${err.message}); split it into simpler calls`);
    throw err;
  }
  // Every word that names a path inside the live copy, in any command.
  for (const c of cmds) {
    const argv = unwrap(c.argv);
    const writer = argv.length && (WRITERS.has(base(argv[0])) || (['sed', 'perl'].includes(base(argv[0])) && argv.some((a) => /^-[a-zA-Z]*i/.test(a))));
    const words = [...c.redirs.map((w) => ({ w, write: true })), ...c.argv.map((w) => ({ w, write: Boolean(writer) && !w.startsWith('-') && w !== argv[0] }))];
    for (const { w, write } of words) {
      if (isSecretName(w)) return deny('secret', `${w} can hold secrets`);
      if (!write && !looksLikePath(w)) continue;
      const p = resolveWord(w, cwd);
      if (inside(p, ctx.live)) return deny('live-copy', `${w} is in the live copy (CLAUDE.md "The live copy")`);
      if (write) {
        const v = writeVerdict(p, ctx);
        if (v) return v;
      }
    }
  }
  for (const c of cmds) {
    const v = commandVerdict(unwrap(c.argv), c, ctx, cwd, depth);
    if (v) return v;
  }
  return ALLOW;
}

/** The guard's verdict on one hook payload: { allow, kind?, reason? }. */
function decide(payload, ctx) {
  const tool = payload && payload.tool_name;
  const input = (payload && payload.tool_input) || {};
  const cwd = (payload && payload.cwd) || ctx.root;
  if (typeof tool !== 'string') return deny('unparsed', 'no tool name');
  if (tool === 'Bash') {
    if (typeof input.command !== 'string' || !input.command.trim()) return deny('unparsed', 'a Bash call with no command');
    return shellVerdict(input.command, ctx, cwd);
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const f = input.file_path || input.notebook_path;
    if (typeof f !== 'string' || !f) return deny('unparsed', `${tool} with no path`);
    const p = real(path.resolve(cwd, f));
    const v = writeVerdict(p, ctx);
    if (v) return v;
    if (inside(p, ctx.root) || inside(p, ctx.home) || ctx.scratch.some((d) => inside(p, d))) return ALLOW;
    return deny('outside-tree', `${p} is outside the worktree, TURBO_HOME and scratch`);
  }
  if (tool === 'Read') return typeof input.file_path === 'string' && isSecretName(input.file_path) ? deny('secret', `${input.file_path} can hold secrets`) : ALLOW;
  if (tool === 'Grep' || tool === 'Glob') return deny('no-grep', 'no grep at all (O\'s core rule): read whole files or parse structured fields');
  if (tool === 'WebFetch' || tool === 'WebSearch') return deny('network', `${tool} reaches the network`);
  if (tool.startsWith('mcp__')) return deny('outward', `${tool} acts on an outside service`);
  return ALLOW;
}

function contextFromEnv(env = process.env) {
  const root = real(env.TURBO_ROOT || ROOT);
  // Only the run's own scratch: the temp dir holds every Claude session's scratchpad (LD117).
  const scratch = (env.TURBO_SCRATCH ? env.TURBO_SCRATCH.split(path.delimiter).filter(Boolean) : []).map(real);
  return {
    root,
    live: real(env.TURBO_LIVE || path.join(os.homedir(), 'tools', 'orunmila')),
    home: real(env.TURBO_HOME || path.join(root, '.turbo')),
    scratch,
    self: real(path.join(root, 'scripts', 'turbo')),
  };
}

function refusal(tool, d) {
  return (
    `TURBO guard refused this ${tool || 'tool'} call (${d.kind}): ${d.reason}. This is a hard stop, so do not try it another way. ` +
    `If the slice needs it, queue it for O and move on: node scripts/turbo/plan.js queue ` +
    `'{"slice":"<id>","kind":"${d.kind}","title":"<what>","ask":"<the question for O>"}'\n`
  );
}

function main() {
  let payload = null;
  let d;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    d = decide(payload, contextFromEnv());
  } catch (err) {
    d = deny('unparsed', `the guard failed closed: ${err.message}`);
  }
  if (d.allow) return 0;
  process.stderr.write(refusal(payload && payload.tool_name, d));
  return 2;
}

if (require.main === module) process.exit(main());

module.exports = { decide, parseShell, unwrap, contextFromEnv, real };
