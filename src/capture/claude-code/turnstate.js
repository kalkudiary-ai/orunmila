'use strict';

/**
 * turnstate.js — re-export of the shared, agent-agnostic turn counter.
 *
 * Turn tracking ("one prompt → many tool calls → one stop") is identical across
 * agents, so the implementation moved up to src/capture/turnstate.js. This shim
 * keeps the historical import path (and existing tests) working unchanged.
 */

module.exports = require('../turnstate');
