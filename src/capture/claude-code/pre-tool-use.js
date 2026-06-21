#!/usr/bin/env node
'use strict';

/**
 * pre-tool-use.js — Claude Code PreToolUse entry point.
 *
 * Thin wrapper over src/capture/core.js. Binds the 'preTool' phase (snapshot a
 * file before a write so postTool can diff it) to the 'claude-code' adapter.
 * Observe-only: never blocks the agent.
 */

const { runHook } = require('../core');
const { getAdapter } = require('../agents');

runHook('preTool', getAdapter('claude-code'));
