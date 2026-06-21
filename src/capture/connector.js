#!/usr/bin/env node
'use strict';

/**
 * connector.js — the universal capture entry point for every non-Claude agent.
 *
 * Claude Code expects a separate command per hook event, so it keeps four named
 * scripts under claude-code/ (which are themselves thin wrappers over core.js).
 * Every other agent's hook system lets us pass arguments, so they share this one
 * script:
 *
 *   node src/capture/connector.js <agent> <phase>
 *
 *   <agent>  an id from the registry: cursor | aider | codex | continue | generic
 *   <phase>  a lifecycle phase:       prompt | preTool | postTool | stop
 *
 * It reads the agent's hook JSON on stdin, looks up the adapter, and runs the
 * shared capture core. Adding an agent therefore needs no new script at all —
 * only a registry entry and an `install --agent <id>` that points its hooks here.
 *
 * Observe-only and crash-proof by contract: an unknown agent/phase or any error
 * exits 0 so the host agent is never blocked.
 */

const { runHook } = require('./core');
const { getAdapter } = require('./agents');

const VALID_PHASES = new Set(['prompt', 'preTool', 'postTool', 'stop']);

function main() {
  const agentId = process.argv[2];
  const phase = process.argv[3];

  const adapter = getAdapter(agentId);
  if (!adapter || !VALID_PHASES.has(phase)) {
    // Misconfigured hook line — never block the agent, just no-op.
    process.exit(0);
  }

  runHook(phase, adapter); // reads stdin, dispatches, and exits 0 itself
}

main();
