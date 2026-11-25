'use strict';

/**
 * graph2d.js — the Graph tab's layout as levels (G2D; O, 2026-11-25: "update graph tab too to be more legible ...
 * levels and undulations maybe?").
 *
 * The tab it replaces put every thing on one ring and drew every link through the ring's centre, so a session with
 * thousands of links (860f51e9: 5,490 on 124 things) became one knot. This one reads left to right, the way the work
 * went:
 *
 *   level 1  Read          what the agent looked at
 *   level 2  Ran or used   its commands, tools and internet calls
 *   level 3  Changed       what it wrote, and what the disk watcher saw change
 *
 * Inside a level, things sit in their folders; a folder with a flagged thing comes first, then the busiest; inside a
 * folder, flagged things first, then the most touched. A level shows at most `cap` rows: the rest are counted under its
 * title, never dropped silently, and a search brings a match back in. Links are smooth curves from the right edge of
 * one thing to the left edge of the next ("undulations"); a link inside one level bows out to the right.
 *
 * Plain code, no clock, no randomness: the same session gives the same picture. `core()` runs in Node for the tests
 * and, through `source()`, in the page.
 */

function core() {
  const LEVELS = [
    { title: 'Read', channels: ['read'] },
    { title: 'Ran or used', channels: ['command', 'tool', 'network'] },
    { title: 'Changed', channels: ['write', 'disk'] },
  ];
  const NO_FOLDER = { command: 'commands', tool: 'tools', network: 'internet' };

  function levelOf(n) {
    const ch = n.primaryChannel;
    if (ch === 'read') return 0;
    if (ch === 'write' || ch === 'disk') return 2;
    return 1;
  }
  function folderOf(n) {
    if (!n.path) return NO_FOLDER[n.primaryChannel] || 'other';
    const parts = String(n.path).split(/[\\/]/);
    parts.pop();
    return parts.join('/') || '.';
  }
  const isAbsolute = (f) => /^(?:~|\/|[A-Za-z]:)/.test(f);

  /**
   * The project's own folder, as the records spell it absolutely: the prefix P for which the most absolute folders are
   * P + '/' + a folder some other record spells from the project (the Glove writes `src/x`, the shell `~/proj/src/x`).
   * Null when no folder is written both ways.
   */
  function projectPrefix(folders) {
    const rel = new Set(folders.filter((f) => !isAbsolute(f) && f !== '.'));
    const count = new Map();
    for (const a of new Set(folders.filter(isAbsolute))) {
      for (const r of rel) {
        if (a.length > r.length + 1 && a.endsWith('/' + r)) {
          const p = a.slice(0, a.length - r.length - 1);
          count.set(p, (count.get(p) || 0) + 1);
        }
      }
    }
    let best = null;
    for (const [p, c] of count) if (!best || c > best[1] || (c === best[1] && p.length > best[0].length)) best = [p, c];
    return best ? best[0] : null;
  }
  function isFlagged(n) {
    return !!(n.stain && n.stain !== 'verified' && n.stain !== 'clean');
  }

  /**
   * nodes: [{ id, label, path, primaryChannel, touches, stain }]; edges: [{ from, to, kind }] by id.
   * opts: { cap (rows per level, 60), search (text), width (960) }.
   */
  function layered(nodes, edges, opts) {
    opts = opts || {};
    const cap = opts.cap || 60;
    const q = String(opts.search || '').toLowerCase();
    const W = opts.width || 960;
    const left = 30;
    const colW = (W - left * 2) / 3;
    const top = 56;
    const rowH = 22;
    const headH = 18;
    const gap = 10;
    const matches = (n) => !!q && (String(n.label || '').toLowerCase().indexOf(q) >= 0 || String(n.path || '').toLowerCase().indexOf(q) >= 0);
    const prefix = projectPrefix(nodes.filter((n) => n.path).map(folderOf));
    const folder = (n) => {
      const f = folderOf(n);
      if (!prefix || !n.path) return f;
      if (f === prefix) return '.';
      return f.startsWith(prefix + '/') ? f.slice(prefix.length + 1) : f;
    };

    // One file written two ways in one level (src/x.js and ~/proj/src/x.js) is one row: the most touched spelling
    // stands for the others (`also`), with their touches added, and their links come to it.
    const alias = new Map();
    const also = new Map();
    const touches = new Map(nodes.map((n) => [n.id, n.touches || 0]));
    const byKey = new Map();
    for (const n of nodes) {
      if (!n.path) continue;
      const key = levelOf(n) + '|' + folder(n) + '/' + String(n.path).split(/[\\/]/).pop();
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(n);
    }
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      const rep = list.slice().sort((a, b) => (b.touches || 0) - (a.touches || 0) || a.id - b.id)[0];
      const rest = list.filter((n) => n !== rep).map((n) => n.id).sort((a, b) => a - b);
      also.set(rep.id, rest);
      touches.set(rep.id, list.reduce((s, n) => s + (n.touches || 0), 0));
      for (const id of rest) alias.set(id, rep.id);
    }
    const repOf = (id) => (alias.has(id) ? alias.get(id) : id);

    const placed = [];
    const levels = LEVELS.map((L, lv) => {
      const all = nodes.filter((n) => levelOf(n) === lv && !alias.has(n.id));
      const rank = (n) => (matches(n) ? 4 : 0) + (isFlagged(n) ? 2 : 0);
      const kept = all
        .slice()
        .sort((a, b) => rank(b) - rank(a) || touches.get(b.id) - touches.get(a.id) || a.id - b.id)
        .slice(0, cap);
      const groups = new Map();
      for (const n of kept) {
        const f = folder(n);
        if (!groups.has(f)) groups.set(f, []);
        groups.get(f).push(n);
      }
      const ordered = [...groups.entries()]
        .map(([folder, list]) => ({
          folder,
          list: list.sort((a, b) => Number(isFlagged(b)) - Number(isFlagged(a)) || touches.get(b.id) - touches.get(a.id) || a.id - b.id),
          flagged: list.some(isFlagged),
          touches: list.reduce((s, n) => s + touches.get(n.id), 0),
        }))
        .sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.touches - a.touches || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
      const x = left + lv * colW + 14;
      let y = top;
      const outGroups = [];
      for (const g of ordered) {
        outGroups.push({ folder: g.folder, y: y + headH - 6 });
        y += headH;
        for (const n of g.list) {
          y += rowH / 2;
          const merged = (also.get(n.id) || []).map((id) => nodes.find((m) => m.id === id));
          placed.push({
            id: n.id,
            level: lv,
            x,
            y,
            r: 4 + Math.min(5, Math.sqrt(touches.get(n.id)) * 1.1),
            folder: g.folder,
            flagged: isFlagged(n) || merged.some(isFlagged),
            match: matches(n) || merged.some(matches),
            also: also.get(n.id) || [],
          });
          y += rowH / 2;
        }
        y += gap;
      }
      return { title: L.title, x: left + lv * colW, width: colW, shown: kept.length, hidden: all.length - kept.length, groups: outGroups, bottom: y };
    });

    const at = new Map(placed.map((p) => [p.id, p]));
    const f = (v) => Math.max(0, v).toFixed(1);
    // A link leaves from its column's right edge, level with its thing, so it never runs over the names.
    const port = (p) => levels[p.level].x + levels[p.level].width - 10;
    const links = [];
    const seenLink = new Set();
    for (const e of edges || []) {
      const from = repOf(e.from), to = repOf(e.to);
      const a = at.get(from), b = at.get(to);
      if (!a || !b || a === b || seenLink.has(from + '>' + to)) continue;
      seenLink.add(from + '>' + to);
      let d;
      if (a.level === b.level) {
        const x = port(a), bow = x + 8 + Math.min(14, Math.abs(b.y - a.y) * 0.05);
        d = `M${f(x)} ${f(a.y)} C${f(bow)} ${f(a.y)} ${f(bow)} ${f(b.y)} ${f(x)} ${f(b.y)}`;
      } else {
        const [s, t] = a.x < b.x ? [a, b] : [b, a];
        const x1 = port(s), x2 = t.x - t.r, mid = (x1 + x2) / 2;
        d = `M${f(x1)} ${f(s.y)} C${f(mid)} ${f(s.y)} ${f(mid)} ${f(t.y)} ${f(x2)} ${f(t.y)}`;
      }
      links.push({ from, to, kind: e.kind || '', d });
    }
    const height = Math.max(320, ...levels.map((l) => l.bottom)) + 16;
    return { width: W, height, levels, placed, links };
  }

  return { layered, levelOf, folderOf, isFlagged, LEVELS };
}

/** The layout as page source. */
function source() {
  return 'var orunmilaGraph2DCore = (' + core.toString() + ')();\n';
}

module.exports = { core, source };
