'use strict';

/**
 * test/no-network.js — NI1 (LD264; O, 2026-11-24: "the promise for no internet call on free orunmila is sacrosant";
 * brief line 783, test 16; lines 656, 693). Every JavaScript file the npm package ships (package.json `files`) is read
 * whole, and:
 *
 *   - no file loads a module that reaches the internet (https, http2, tls, dgram, dns, undici), or calls `fetch`,
 *     `XMLHttpRequest` or `WebSocket` with an address that leaves the machine;
 *   - `http` and `net` are loaded only by the files below, each serving or reaching 127.0.0.1 or a local socket, and each
 *     is named with its reason, so a new one fails here until it is looked at;
 *   - no file names an AI service's host;
 *   - no page Orunmila renders loads a script or stylesheet from the internet.
 *
 * It reads the code; it does not run it. A call built at run time from pieces is beyond it, as test 16 states for a
 * code review.
 */

const { assert, fs, path, ROOT, it, runAll } = require('./helpers');

/** Files allowed `http` or `net`, each local only. */
const LOCAL = {
  'bin/dashboard.js': 'serves the old event log on 127.0.0.1 only (line 596)',
  'bin/orunmila.js': 'the intake commands talk to its local socket',
  'src/opon/intake/server.js': "the intake's Unix socket (a named pipe on Windows) and its HTTP port on 127.0.0.1",
  'src/opon/intake/peer.js': "names the process at the other end of a 127.0.0.1 connection",
  'src/capture/claude-code/intake-send.js': "sends a hook payload to the intake's local socket",
  'src/capture/claude-code/gate-send.js': "sends the gate's check to the intake's local socket",
};
const FAR = ['https', 'http2', 'tls', 'dgram', 'dns', 'undici'];
const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'ajax.googleapis.com', 'code.jquery.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.skypack.dev', 'esm.sh'];
const AI_HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'api.mistral.ai', 'api.cohere.ai', 'api.groq.com', 'api.together.xyz', 'api.deepseek.com', 'bedrock-runtime', 'aiplatform.googleapis.com', 'openai.azure.com'];

function shipped() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, n));
    else out.push(rel);
  };
  for (const f of pkg.files) walk(f.replace(/\/$/, ''));
  return out;
}

/** The modules a file loads: every require('x') and import ... from 'x', `node:` dropped. */
function modulesOf(text) {
  const mods = new Set();
  for (const m of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) mods.add(m[1].replace(/^node:/, ''));
  for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) mods.add(m[1].replace(/^node:/, ''));
  return mods;
}

/** Problems in one shipped JavaScript file. */
function problemsOf(rel, text) {
  const out = [];
  const mods = modulesOf(text);
  for (const m of FAR) if (mods.has(m)) out.push(`${rel} loads ${m}, which reaches the internet`);
  for (const m of ['http', 'net']) if (mods.has(m) && !LOCAL[rel]) out.push(`${rel} loads ${m} and is not on the local-only list`);
  for (const h of AI_HOSTS) if (text.includes(h)) out.push(`${rel} names the AI service host ${h}`);
  for (const m of text.matchAll(/\b(fetch|XMLHttpRequest|WebSocket)\s*\(\s*[`'"](https?|wss?):\/\//g)) out.push(`${rel} calls ${m[1]} on an internet address`);
  for (const m of text.matchAll(/<(script|link)\b[^>]*\b(src|href)\s*=\s*\\?["']?(https?:)?\/\//gi)) out.push(`${rel} renders a page that loads a ${m[1] === 'link' ? 'stylesheet' : 'script'} from the internet`);
  for (const h of CDN_HOSTS) if (text.includes(h)) out.push(`${rel} names the code host ${h}, which a page loads from the internet`);
  if (/\bcreateElement\(\s*['"]script['"]\s*\)/.test(text)) out.push(`${rel} renders a page that adds a script at run time`);
  return out;
}

it('NI1 (LD264): no file the package ships reaches the internet, names an AI service, or renders a page that loads from it', () => {
  const files = shipped();
  const js = files.filter((f) => f.endsWith('.js'));
  assert.ok(js.length > 50, `the shipped set was read: ${js.length} JavaScript files of ${files.length}`);
  const problems = js.flatMap((f) => problemsOf(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepStrictEqual(problems, [], `\n${problems.join('\n')}`);
  for (const f of Object.keys(LOCAL)) assert.ok(files.includes(f), `the local-only list names a file the package ships: ${f}`);
});

it('NI1: the check sees each kind of call it refuses (planted in memory, never on disk)', () => {
  const cases = [
    ["const https = require('https');", 'loads https'],
    ["const h = require('node:http2');", 'loads http2'],
    ["import x from 'undici';", 'loads undici'],
    ["const net = require('net');", 'not on the local-only list'],
    ["const u = 'https://openrouter.ai/api/v1/chat/completions';", 'AI service host openrouter.ai'],
    ["fetch('https://example.com/x')", 'calls fetch on an internet address'],
    ['const page = `<script src="https://cdn.example/x.js"></script>`;', 'loads a script from the internet'],
    ['const page = `<link rel="stylesheet" href="//cdn.example/x.css">`;', 'loads a stylesheet from the internet'],
    ["var urls = ['x/y.js']; var host = 'unpkg.com';", 'code host unpkg.com'],
    ["var s = document.createElement('script'); s.src = urls[0];", 'adds a script at run time'],
  ];
  for (const [text, words] of cases) {
    const p = problemsOf('src/planted.js', text);
    assert.ok(p.length === 1 && p[0].includes(words), `${text} -> ${JSON.stringify(p)}`);
  }
  assert.deepStrictEqual(problemsOf('src/opon/intake/server.js', "const net = require('net'); const http = require('http');"), [], 'a listed local file may load net and http');
  assert.deepStrictEqual(problemsOf('src/x.js', "fetch('/api/sessions')"), [], 'a page fetching its own local server is not the internet');
});

runAll('no-network');
