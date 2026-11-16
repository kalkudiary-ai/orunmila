'use strict';

/**
 * src/verify/canonical.js — JSON Canonicalization Scheme, RFC 8785 (JCS), the
 * one canonical form records are serialised in before hashing (brief v3 line
 * 247). No dependencies.
 *
 *   canonicalize(value)   the canonical JSON text
 *   canonicalBytes(value) the same, as UTF-8 bytes (what is hashed)
 *
 * JCS's number and string rules are ECMAScript's JSON.stringify (RFC 8785
 * sections 3.2.2.2 and 3.2.2.3), which Node implements; this module adds what
 * JSON.stringify does not do: properties sorted by UTF-16 code units at every
 * level (section 3.2.3), and an error, never a silent conversion, for anything
 * JCS forbids or JSON cannot hold: NaN and Infinity, lone surrogates (section
 * 3.2.2.2), undefined, functions, symbols, BigInt, and objects that are not
 * plain (a Date or a Map would otherwise serialise as something else).
 */

function checkString(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new TypeError(`lone surrogate at index ${i}`);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError(`lone surrogate at index ${i}`);
    }
  }
  return JSON.stringify(s);
}

function serialize(v) {
  if (v === null || v === true || v === false) return String(v);
  switch (typeof v) {
    case 'string':
      return checkString(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`${v} is not a finite number (NaN and Infinity are not JSON)`);
      return JSON.stringify(v); // ECMAScript Number serialisation; -0 gives "0"
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(serialize).join(',') + ']';
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('not a plain object');
      const keys = Object.keys(v).sort(); // default sort: UTF-16 code units
      return '{' + keys.map((k) => checkString(k) + ':' + serialize(v[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`${typeof v} is not JSON`);
  }
}

function canonicalize(value) {
  return serialize(value);
}

function canonicalBytes(value) {
  return Buffer.from(serialize(value), 'utf8');
}

module.exports = { canonicalize, canonicalBytes };
