// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * src/opon/intake/mono.js — `mono_ns` as a decimal string (brief v4 line 238;
 * spec open point P1, decided by O 2026-11-16; slice S1b). A JSON number is
 * exact only up to 2^53, about 104 days of nanoseconds since boot, so the
 * monotonic clock is written as the exact decimal string of the integer and
 * compared as a BigInt.
 *
 *   monoString(v)  a bigint, a safe non-negative integer, or a decimal string
 *                  in its one canonical spelling -> that string; anything else
 *                  (negative, fractional, past 2^53 as a number, '007', '1e9')
 *                  -> undefined, never a rounded value
 *   nowMono()      this process's monotonic clock, as that string
 */

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function monoString(v) {
  if (typeof v === 'bigint') return v >= 0n ? v.toString() : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
  if (typeof v === 'string') return DECIMAL.test(v) ? v : undefined;
  return undefined;
}

const nowMono = () => process.hrtime.bigint().toString();

module.exports = { monoString, nowMono };
