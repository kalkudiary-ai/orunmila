#!/usr/bin/env node
'use strict';

/**
 * post-tool-use.js — Claude Code PostToolUse / PostToolUseFailure entry point.
 *
 * Thin wrapper over src/capture/core.js. Binds the 'postTool' phase (the main
 * ground-truth capture point: write/read/command/network/tool events) to the
 * 'claude-code' adapter. Wired to both PostToolUse and PostToolUseFailure; the
 * adapter's failure detection branches on the payload, so one script serves both.
 */

const { runHook } = require('../core');
const { getAdapter } = require('../agents');

runHook('postTool', getAdapter('claude-code'));
