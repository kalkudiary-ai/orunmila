'use strict';

/**
 * transcript.js — re-export of the shared, agent-agnostic transcript reader.
 *
 * The defensive JSONL reader is the shared default for any agent that writes a
 * session transcript, so it moved up to src/capture/transcript.js. This shim
 * keeps the historical import path (and existing tests) working unchanged.
 */

module.exports = require('../transcript');
