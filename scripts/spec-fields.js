// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KALKU DIGITAL SOLUTIONS LIMITED
'use strict';

/**
 * scripts/spec-fields.js — SP1 (Phase 7; brief v4 lines 703-709): spec/FIELDS.md, every field of every record format
 * in spec/, in plain words, made from the JSON Schema files themselves, so the document and the schemas cannot drift
 * (test/spec.js checks FIELDS.md equals this script's output).
 *
 *   node scripts/spec-fields.js           write spec/FIELDS.md
 *   node scripts/spec-fields.js --check   exit 1 when spec/FIELDS.md is not what the schemas give
 *   fieldsMarkdown(specDir) -> the text
 *
 * A field's path is its property names from the record's root (`target.kind`), `[]` for a list's items, and a shared
 * shape (a schema's `definitions`) by its own name. Properties inside a rule's `if` or `not` are conditions, not fields.
 */

const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'spec');

const cell = (s) => String(s === undefined || s === null ? '' : s).replace(/\n/g, ' ').replace(/\|/g, '\\|');
const lit = (v) => '`' + JSON.stringify(v) + '`';

function typeOf(n) {
  if (!n || typeof n !== 'object') return 'any';
  if (n.$ref) return `shape \`${n.$ref.split('/').pop()}\``;
  if ('const' in n) return lit(n.const);
  if (n.enum) return 'one of ' + n.enum.map(lit).join(', ');
  if (n.anyOf) {
    const each = [...new Set(n.anyOf.map(typeOf))];
    return each.every((t) => t === 'any') ? 'set by the rules below' : each.join(' or ');
  }
  const t = Array.isArray(n.type) ? n.type.join(' or ') : n.type;
  if (t === 'array' && n.items) return `list of ${typeOf(n.items)}`;
  if (!t && n.properties) return 'object';
  return t || (n.allOf || n.if ? 'set by the rules below' : 'any');
}

/** A rule with no wording of its own, said from its structure: "when `kind` is `file`: `path` is required". */
function ruleWords(rule) {
  const says = (node) => {
    const parts = [];
    for (const [k, v] of Object.entries((node && node.properties) || {})) {
      if (v && 'const' in v) parts.push(`\`${k}\` is ${lit(v.const)}`);
      else if (v && v.enum) parts.push(`\`${k}\` is one of ${v.enum.map(lit).join(', ')}`);
      else if (v && v.type) parts.push(`\`${k}\` is ${Array.isArray(v.type) ? v.type.join(' or ') : v.type}`);
    }
    for (const k of (node && node.required) || []) if (!(node.properties && node.properties[k])) parts.push(`\`${k}\` is present`);
    return parts;
  };
  const need = (node) => [...says(node).filter((p) => !p.endsWith(' is present')), ...((node && node.required) || []).map((k) => `\`${k}\` is required`)];
  const when = says(rule.if);
  const then = rule.then ? need(rule.then) : [];
  const otherwise = rule.else ? need(rule.else) : [];
  return `when ${when.join(' and ') || 'the condition in the schema holds'}: ${then.join(' and ') || 'see the schema'}${otherwise.length ? `; otherwise ${otherwise.join(' and ')}` : ''}`;
}

/** Rows of one node: every property at every depth, through lists, shared shapes, and rules' then and else branches. */
function walk(node, prefix, rows, rules, how) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const required = new Set(node.required || []);
  for (const [name, sub] of Object.entries(node.properties || {})) {
    const p = prefix ? `${prefix}.${name}` : name;
    rows.push({ path: p, type: typeOf(sub), required: how === 'rule' ? (required.has(name) ? 'in this rule' : 'no') : required.has(name) ? 'yes' : 'no', what: sub && sub.description, source: sub && sub.$comment, how });
    walk(sub, p, rows, rules, how);
  }
  if (node.items) walk(node.items, `${prefix}[]`, rows, rules, how);
  for (const k of ['allOf', 'anyOf', 'oneOf']) {
    for (const sub of node[k] || []) {
      if (k === 'allOf' && sub && (sub.if || sub.not || sub.then)) rules.push({ at: prefix, words: sub.$comment || (sub.if ? ruleWords(sub) : 'a rule between fields; see the schema file') });
      walk(sub, prefix, rows, rules, k === 'allOf' && sub && sub.then ? 'rule' : how);
    }
  }
  for (const k of ['then', 'else']) walk(node[k], prefix, rows, rules, 'rule');
}

function section(file, schema) {
  const title = String(schema.title || file).replace(/,\s*schema version 1.*$/i, '');
  const out = [`## ${title} (\`${file}\`)`, ''];
  if (schema.description) out.push(cell(schema.description), '');
  const table = (rows) => {
    const seen = new Set();
    const lines = ['| Field | Type | Required | What it means | Source |', '|---|---|---|---|---|'];
    const described = new Set(rows.filter((r) => r.what).map((r) => r.path));
    for (const r of rows) {
      const key = `${r.path}\0${r.what || ''}\0${r.type}`;
      if (seen.has(key)) continue;
      if (!r.what && r.how === 'rule' && described.has(r.path)) continue; // a rule's restatement of a field with its own row
      seen.add(key);
      const what = r.what ? cell(r.what) : r.how === 'rule' ? 'Restated by a rule below; described in its own row.' : '';
      lines.push(`| \`${r.path}\` | ${cell(r.type)} | ${r.required} | ${what} | ${cell(r.source)} |`);
    }
    return lines;
  };
  const rows = [];
  const rules = [];
  const { definitions, ...root } = schema;
  walk(root, '', rows, rules, 'field');
  out.push(...table(rows), '');
  if (definitions && Object.keys(definitions).length) {
    out.push('### Shared shapes', '');
    const drows = [];
    for (const [name, def] of Object.entries(definitions)) {
      drows.push({ path: name, type: typeOf(def), required: '', what: def.description, source: def.$comment, how: 'shape' });
      walk(def, name, drows, rules, 'field');
    }
    out.push(...table(drows), '');
  }
  if (rules.length) {
    out.push('### Rules between fields', '');
    for (const r of rules) out.push(`- ${r.at ? `\`${r.at}\`: ` : ''}${cell(r.words)}`);
    out.push('');
  }
  return out;
}

function fieldsMarkdown(specDir = SPEC) {
  const files = fs.readdirSync(specDir).filter((f) => f.endsWith('.schema.json')).sort();
  const out = [
    '# Orunmila record formats v1: every field',
    '',
    'Every field of every record format in this folder, in plain words. This file is made from the JSON Schema files',
    'beside it by `scripts/spec-fields.js`; the schemas are the source, and a test keeps this file equal to them. Read',
    '`README.md` first, then `hash-chain.md` for the exact bytes each record\'s `hash` covers.',
    '',
    'Each table row is one field: its path from the record\'s root (`target.kind` is the `kind` inside `target`; `[]` is',
    'one item of a list), what values it takes, whether every record must carry it, what it means, and where the rule',
    'comes from (a line of the build brief, or "agent\'s choice" where the brief names no field). A **shape** is a part',
    'several fields share, written once under "Shared shapes". **Rules between fields** say what one field requires of',
    'another (for example, which marks must name a turn).',
    '',
    'Licensed under the Apache License 2.0, like the code. These formats stay open in every future version of Orunmila.',
    '',
  ];
  for (const f of files) out.push(...section(f, JSON.parse(fs.readFileSync(path.join(specDir, f), 'utf8'))));
  return out.join('\n');
}

if (require.main === module) {
  const file = path.join(SPEC, 'FIELDS.md');
  const text = fieldsMarkdown(SPEC);
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
    console.log(same ? 'spec/FIELDS.md matches the schemas' : 'spec/FIELDS.md differs from the schemas: run node scripts/spec-fields.js');
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(file, text);
  console.log(`wrote spec/FIELDS.md (${text.split('\n').length} lines)`);
}

module.exports = { fieldsMarkdown };
