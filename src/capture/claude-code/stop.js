#!/usr/bin/env node
'use strict';

/**
 * stop.js — Claude Code Stop entry point.
 *
 * Thin wrapper over src/capture/core.js. Binds the 'stop' phase (log the claim,
 * backfill the prompt if needed, mark turn end, reconcile, render the report) to
 * the 'claude-code' adapter. The shared runner writes the rendered report to the
 * last-turn file and stdout so `orunmila watch` and the terminal both see it.
 */

const { runHook } = require('../core');
const { getAdapter } = require('../agents');

runHook('stop', getAdapter('claude-code'));
