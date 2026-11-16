'use strict';

/**
 * src/verify/schema.js — a small JSON Schema checker for Orunmila's own record
 * formats (spec/*.schema.json), with no dependencies.
 *
 * It implements the subset of JSON Schema draft-07 the spec uses, listed in
 * SUPPORTED, and refuses to compile a schema with any other keyword: a
 * misspelt or unimplemented keyword would otherwise be skipped and check
 * nothing. `$ref` is local only (`#/definitions/<name>`) and stands alone.
 *
 *   const check = compile(schema);
 *   check(record)  // [] when valid, else [{ path, keyword, message }]
 *
 * `path` is a JSON Pointer to the offending value; for a missing required
 * property it points to where that property should be.
 */

const SUPPORTED = [
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
  'minimum', 'minLength', 'maxLength', 'pattern',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref', 'definitions',
];
const ANNOTATIONS = ['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default'];
const TYPES = ['null', 'boolean', 'object', 'array', 'string', 'number', 'integer'];

const ptr = (seg) => String(seg).replace(/~/g, '~0').replace(/\//g, '~1');

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'not-json';
  return typeof v; // boolean, string, object, or something JSON cannot hold
}

function hasType(v, t) {
  const actual = typeOf(v);
  if (t === 'integer') return actual === 'number' && Number.isInteger(v);
  return actual === t;
}

function equal(a, b) {
  if (a === b) return true;
  const ta = typeOf(a);
  if (ta !== typeOf(b) || (ta !== 'object' && ta !== 'array')) return false;
  if (ta === 'array') return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
}

/** Throw on anything this checker would not really check. */
function audit(root, s, where) {
  if (typeOf(s) !== 'object') throw new Error(`schema at ${where || '/'} is not an object`);
  for (const k of Object.keys(s)) {
    if (!SUPPORTED.includes(k) && !ANNOTATIONS.includes(k)) throw new Error(`unsupported schema keyword "${k}" at ${where || '/'}`);
  }
  if ('$ref' in s) {
    const extra = Object.keys(s).filter((k) => k !== '$ref' && !ANNOTATIONS.includes(k));
    if (extra.length) throw new Error(`$ref at ${where || '/'} has siblings (${extra.join(', ')}); draft-07 ignores them`);
    resolve(root, s.$ref);
  }
  if ('type' in s) {
    for (const t of [].concat(s.type)) if (!TYPES.includes(t)) throw new Error(`unknown type "${t}" at ${where || '/'}`);
  }
  if ('pattern' in s) new RegExp(s.pattern, 'u');
  const sub = (x, at) => audit(root, x, `${where}/${at}`);
  for (const k of ['properties', 'definitions']) for (const [n, x] of Object.entries(s[k] || {})) sub(x, `${k}/${ptr(n)}`);
  for (const k of ['allOf', 'anyOf', 'oneOf']) {
    if (k in s) {
      if (!Array.isArray(s[k]) || !s[k].length) throw new Error(`${k} at ${where || '/'} must be a non-empty array`);
      s[k].forEach((x, i) => sub(x, `${k}/${i}`));
    }
  }
  for (const k of ['not', 'if', 'then', 'else', 'items']) if (k in s) sub(s[k], k);
  if (typeOf(s.additionalProperties) === 'object') sub(s.additionalProperties, 'additionalProperties');
  else if ('additionalProperties' in s && typeof s.additionalProperties !== 'boolean') {
    throw new Error(`additionalProperties at ${where || '/'} must be a boolean or a schema`);
  }
}

function resolve(root, ref) {
  const prefix = '#/definitions/';
  const name = typeof ref === 'string' && ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  if (name === null || !root.definitions || !Object.prototype.hasOwnProperty.call(root.definitions, name)) {
    throw new Error(`cannot resolve $ref "${ref}" (only local #/definitions/<name> refs are supported)`);
  }
  return root.definitions[name];
}

function validate(root, s, v, path, errs) {
  const err = (keyword, message, at = path) => errs.push({ path: at, keyword, message });
  const ok = (x) => validate(root, x, v, path, []).length === 0;

  if ('$ref' in s) return validate(root, resolve(root, s.$ref), v, path, errs);

  if ('type' in s) {
    const types = [].concat(s.type);
    if (!types.some((t) => hasType(v, t))) err('type', `must be ${types.join(' or ')}`);
  }
  if ('enum' in s && !s.enum.some((x) => equal(x, v))) err('enum', `must be one of ${JSON.stringify(s.enum)}`);
  if ('const' in s && !equal(s.const, v)) err('const', `must be ${JSON.stringify(s.const)}`);

  const t = typeOf(v);
  if (t === 'object') {
    for (const k of s.required || []) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) err('required', `is required`, `${path}/${ptr(k)}`);
    }
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      const at = `${path}/${ptr(k)}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(root, props[k], x, at, errs);
      else if (s.additionalProperties === false) err('additionalProperties', 'is not allowed', at);
      else if (typeOf(s.additionalProperties) === 'object') validate(root, s.additionalProperties, x, at, errs);
    }
  }
  if (t === 'array' && 'items' in s) v.forEach((x, i) => validate(root, s.items, x, `${path}/${i}`, errs));
  if (t === 'number' && 'minimum' in s && v < s.minimum) err('minimum', `must be >= ${s.minimum}`);
  if (t === 'string') {
    const len = [...v].length;
    if ('minLength' in s && len < s.minLength) err('minLength', `must have at least ${s.minLength} characters`);
    if ('maxLength' in s && len > s.maxLength) err('maxLength', `must have at most ${s.maxLength} characters`);
    if ('pattern' in s && !new RegExp(s.pattern, 'u').test(v)) err('pattern', `must match ${s.pattern}`);
  }

  for (const x of s.allOf || []) validate(root, x, v, path, errs);
  if ('anyOf' in s && !s.anyOf.some(ok)) err('anyOf', 'must match at least one schema in anyOf');
  if ('oneOf' in s) {
    const n = s.oneOf.filter(ok).length;
    if (n !== 1) err('oneOf', `must match exactly one schema in oneOf (matched ${n})`);
  }
  if ('not' in s && ok(s.not)) err('not', 'must not match the schema in not');
  if ('if' in s) {
    if (ok(s.if)) {
      if ('then' in s) validate(root, s.then, v, path, errs);
    } else if ('else' in s) validate(root, s.else, v, path, errs);
  }
  return errs;
}

function compile(schema) {
  audit(schema, schema, '');
  return (record) => validate(schema, schema, record, '', []);
}

module.exports = { compile, SUPPORTED };
