#!/usr/bin/env node
'use strict';

/**
 * user-prompt-submit.js — Claude Code UserPromptSubmit entry point.
 *
 * Thin wrapper: all capture logic lives in src/capture/core.js, all
 * Claude-Code-specific field/tool knowledge lives in the 'claude-code' adapter
 * in src/capture/agents.js. This script just binds the 'prompt' lifecycle phase
 * to that adapter and runs the shared stdin runner (read JSON, dispatch, exit 0).
 */

const { runHook } = require('../core');
const { getAdapter } = require('../agents');

runHook('prompt', getAdapter('claude-code'));
