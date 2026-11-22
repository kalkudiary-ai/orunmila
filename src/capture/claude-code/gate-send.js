'use strict';

/**
 * src/capture/claude-code/gate-send.js — sends the law gate's decision to the
 * intake (slice B5, LD146), for law-gate.js with ORUNMILA_GATE_MARKS=1. Node's
 * own modules only, as the hooks' sender (LD133): one
 * `{"op":"payload","payload":…}` line to <home>/intake/intake.sock, then
 * `done`. No intake, or one that never takes the line, costs at most 1 s and
 * prints nothing: the gate's answer to the agent is already written.
 */

const net = require('net');
const os = require('os');
const path = require('path');

const DEADLINE_MS = 1000;

function send(payload, done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  setTimeout(finish, DEADLINE_MS).unref();
  const home = process.env.ORUNMILA_HOME || path.join(os.homedir(), '.orunmila');
  const c = net.createConnection(path.join(home, 'intake', 'intake.sock'));
  c.on('error', finish); // no intake
  c.on('connect', () => c.end(JSON.stringify({ op: 'payload', payload }) + '\n'));
  c.on('close', finish);
}

module.exports = { send };
