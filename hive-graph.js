(() => {
  'use strict';

  const SQRT3 = Math.sqrt(3);
  const STOP_WORDS = new Set([
    'for', 'in', 'on', 'to', 'with', 'of', 'by', 'at', 'from', 'into', 'onto',
    'about', 'as', 'and', 'or', 'the', 'a', 'an', 'via', 'per', 'within',
  ]);

  function isPost(event) {
    return event.kind === 'brief' || event.kind === 'message' ||
      (!event.kind && event.author !== 'system');
  }

  function elapsedSpan(posts, { live = false, now = Date.now() } = {}) {
    const times = posts.map(post => Date.parse(post.time)).filter(Number.isFinite);
    if (!times.length) return '<1m';
    const minutes = Math.max(0, Math.floor(((live ? now : times.at(-1)) - times[0]) / 60000));
    if (!minutes) return '<1m';
    if (minutes < 60) return minutes + 'm';
    return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '');
  }

  function unmentionedNode(node) {
    return Boolean(node.unmentioned && !node.mentions && !node.broadcasts);
  }

  function smartTaskLabel(member) {
    const isObj = member && typeof member === 'object';
    const explicit = isObj ? String(member.taskLabel ?? '').trim() : '';
    if (explicit) return explicit;

    const raw = isObj ? String(member.brief ?? member.task ?? '') : String(member ?? '');
    const fallbackName = isObj && member.name ? String(member.name).trim() : '';
    if (!raw.trim()) return fallbackName || 'Swarm task';

    // Strip fenced code blocks, markdown links, formatting symbols, and list prefixes.
    let text = raw
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~>#]/g, ' ')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');

    const skipLine = /^(?:strict\s+file\s+ownership|do\s+not\s+touch|reference\s+screenshots|requirements?|first\s*\(|deliverables?)\b/i;
    const lines = text
      .split(/\r?\n+/)
      .map(line => line.trim())
      .filter(line => line && !skipLine.test(line));

    let cleaned = (lines.slice(0, 8).join(' ') || text).replace(/\s+/g, ' ').trim();

    const leadingPatterns = [
      /^you\s+have\s+just\s+started[.:!]*\s*/i,
      /^your\s+assignment(?:\s*\([^)]*\))?[:.\s-]*/i,
      /^you\s+are(?:\s+(?:a|an|the))?\s+(?:hive\s+swarm\s+)?(?:member|agent|worker|owner)(?:\s+['"]?@?[a-z0-9_-]+['"]?)?(?:\s+(?:for|on|in)\s+hive\s+swarm(?:\s+\d+(?:\.\d+)*)?)?[.,:;\s-]*/i,
      /^as(?:\s+(?:a|an|the))?\s+[a-z0-9 _-]+,\s*/i,
      /^(?:your\s+)?(?:task|goal|role|mission|assignment)\s*(?:is\s+to|is|:)\s*/i,
      /^you\s+(?:own|will\s+own|are\s+responsible\s+for|need\s+to|should|must)\s+(?:the\s+)?/i,
      /^please\s+/i,
      /^for\s+hive\s+swarm(?:\s+\d+(?:\.\d+)*)?[.,:;\s-]*/i,
    ];
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const pattern of leadingPatterns) {
        const next = cleaned.replace(pattern, '').trim();
        if (next !== cleaned) {
          cleaned = next;
          changed = true;
        }
      }
      if (!changed) break;
    }

    cleaned = cleaned
      .replace(/\s+(?:in|on)\s+(?:your|the)\s+(?:shared\s+)?worktree.*$/i, '')
      .replace(/\s+for\s+hive\s+swarm(?:\s+\d+(?:\.\d+)*)?\.?$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned.length > 64) {
      const sentenceMatch = /^(.{18,64}?)[.!?](?:\s|$)/.exec(cleaned);
      if (sentenceMatch) cleaned = sentenceMatch[1];
    }

    // Remove trailing unmatched open parentheses if sliced mid-phrase.
    let words = cleaned.replace(/[.,:;!?-]+$/g, '').split(/\s+/).filter(Boolean);
    if (words.length > 10) words = words.slice(0, 10);

    let result = words.join(' ');
    while (result.length > 64 && words.length > 1) {
      words.pop();
      result = words.join(' ');
    }

    // Drop dangling unclosed parenthesis chunk if needed.
    const openIdx = result.lastIndexOf('(');
    const closeIdx = result.lastIndexOf(')');
    if (openIdx !== -1 && openIdx > closeIdx) {
      const beforeParen = result.slice(0, openIdx).replace(/[,:;-\s]+$/, '').trim();
      if (beforeParen.split(/\s+/).length >= 2) {
        result = beforeParen;
        words = result.split(/\s+/).filter(Boolean);
      } else {
        result = result.replace(/\(/g, '');
        words = result.split(/\s+/).filter(Boolean);
      }
    }

    while (words.length > 2 && STOP_WORDS.has(words.at(-1).replace(/[,:;!?-]+$/g, '').toLowerCase())) {
      words.pop();
    }

    result = words.join(' ').replace(/[,:;!?-]+$/g, '').trim();
    if (result.length > 64) {
      result = result.slice(0, 64).replace(/\s+\S*$/, '').replace(/[,:;!?-]+$/g, '').trim();
    }
    if (!result) return fallbackName || 'Swarm task';
    return result[0].toUpperCase() + result.slice(1);
  }

  function project(posts, members, cursor, { hideInactive = false, expandBroadcast = false } = {}) {
    const names = new Map([['coordinator', { name: 'coordinator', role: 'coordinator', status: 'waiting' }]]);
    for (const member of members) names.set(member.name, member);
    const seen = new Set();
    const counts = new Map();
    const links = new Map();
    let broadcasts = 0;
    function addName(name) {
      if (!names.has(name)) names.set(name, { name, status: 'observer' });
      seen.add(name);
    }
    for (const event of posts) {
      if (event.seq > cursor || !isPost(event)) continue;
      const { author } = event;
      const targets = [...new Set([...(event.targets ?? []), ...(event.coordinatorMention ? ['coordinator'] : [])])];
      addName(author);
      const outgoing = counts.get(author) ?? { posts: 0, mentions: 0, broadcasts: 0, unmentioned: 0, lastSeq: 0 };
      outgoing.posts++;
      outgoing.lastSeq = event.seq;
      counts.set(author, outgoing);
      const all = event.broadcast ?? /(?:^|[^a-z0-9_])@all(?![a-z0-9_-])/i.test(event.text ?? '');
      if (all) {
        outgoing.broadcasts++;
        broadcasts++;
      }
      if (!all && !event.coordinatorMention && !targets.some(to => to !== author)) outgoing.unmentioned++;
      for (const to of new Set(targets)) {
        if (to === author) continue;
        addName(to);
        if (all && !expandBroadcast) continue;
        const key = author + '>' + to;
        const link = links.get(key) ?? { from: author, to, count: 0, direct: 0, broadcast: 0, lastSeq: 0 };
        link.count++;
        if (all) link.broadcast++; else link.direct++;
        link.lastSeq = event.seq;
        outgoing.mentions++;
        links.set(key, link);
      }
    }
    return {
      nodes: [...names.values()].filter(node => !hideInactive || seen.has(node.name))
        .map(node => ({ ...node, ...counts.get(node.name) })),
      links: [...links.values()],
      broadcasts,
    };
  }

  function gridLayout(count, width) { return count > 6 || (count > 3 && width < 440); }
  function columns(width) { return Math.max(1, Math.floor(width / 120)); }
  function minimumHeight(count, width) {
    if (gridLayout(count, width)) {
      const rows = Math.ceil(count / columns(width));
      return Math.max(340, rows * 124 + 44);
    }
    if (count >= 6) return 470;
    if (count === 5) return 450;
    if (count === 4) return 400;
    return 0;
  }

  function layout(nodes, width, height) {
    const result = new Map();
    if (!nodes.length) return result;
    if (gridLayout(nodes.length, width)) {
      const count = columns(width);
      const rows = Math.ceil(nodes.length / count);
      const columnWidth = width / count;
      const topPad = 56;
      const bottomPad = 66;
      const usable = Math.max(0, height - topPad - bottomPad);
      nodes.forEach((node, index) => {
        const row = Math.floor(index / count);
        const inRow = Math.min(count, nodes.length - row * count);
        const y = rows === 1 ? Math.max(topPad, Math.min(height - bottomPad, height / 2 - 8)) : topPad + (row / (rows - 1)) * usable;
        result.set(node.name, { x: columnWidth * (index % count + 0.5 + (count - inRow) / 2), y });
      });
      return result;
    }
    const center = nodes.find(node => node.role === 'coordinator') ?? nodes[0];
    if (!center) return result;
    const outer = nodes.filter(node => node !== center);
    const topPad = 56;
    const bottomPad = 66;
    const centerY = (topPad + (height - bottomPad)) / 2;
    const radiusY = Math.max(48, (height - topPad - bottomPad) / 2);
    const sidePad = Math.min(68, Math.max(54, width * 0.1));
    const radiusX = Math.max(44, Math.min(width * 0.4, width / 2 - sidePad));
    if (!outer.length) {
      result.set(center.name, { x: width / 2, y: centerY });
      return result;
    }
    if (outer.length === 1) {
      const spread = Math.max(54, Math.min(radiusX * 0.72, width / 2 - sidePad));
      result.set(center.name, { x: width / 2 - spread, y: centerY });
      result.set(outer[0].name, { x: width / 2 + spread, y: centerY });
      return result;
    }
    if (outer.length === 2) {
      const topY = Math.max(topPad, centerY - radiusY * 0.78);
      const bottomY = Math.min(height - bottomPad, centerY + radiusY * 0.72);
      const spread = Math.max(54, Math.min(radiusX * 0.85, width / 2 - sidePad));
      result.set(center.name, { x: width / 2, y: topY });
      result.set(outer[0].name, { x: width / 2 - spread, y: bottomY });
      result.set(outer[1].name, { x: width / 2 + spread, y: bottomY });
      return result;
    }
    result.set(center.name, { x: width / 2, y: centerY });
    outer.forEach((node, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / outer.length;
      result.set(node.name, { x: width / 2 + Math.cos(angle) * radiusX, y: centerY + Math.sin(angle) * radiusY });
    });
    return result;
  }

  function mentionsGridLayout(count, width) {
    return count > 12 || (count > 5 && width < 380) || (count > 8 && width < 465);
  }

  function mentionsMinimumHeight(count, width) {
    if (mentionsGridLayout(count, width)) {
      const cols = Math.max(1, Math.floor(Math.max(width - 24, 140) / 145));
      const rows = Math.ceil(count / cols);
      return Math.max(360, rows * 68 + 80);
    }
    if (count >= 11) return 680;
    if (count >= 9) return 560;
    if (count >= 7) return 470;
    if (count >= 5) return 400;
    return 360;
  }

  function layoutMentions(nodes, width, height) {
    const result = new Map();
    if (!nodes?.length) return result;
    const narrow = width < 465;
    const ordered = [];
    const coord = nodes.find(node => node.role === 'coordinator' || node.name === 'coordinator');
    if (coord) ordered.push(coord);
    for (const node of nodes) if (node !== coord) ordered.push(node);

    if (mentionsGridLayout(ordered.length, width)) {
      const maxPillW = Math.max(...ordered.map(n => nodeBox(n, { variant: 'pill', narrow }).halfW * 2), 116);
      const cols = Math.max(1, Math.floor((width - 24) / (maxPillW + 14)));
      const rows = Math.ceil(ordered.length / cols);
      const colW = width / cols;
      const topPad = 42;
      const bottomPad = 46;
      const usableH = Math.max(40, height - topPad - bottomPad);
      ordered.forEach((node, index) => {
        const row = Math.floor(index / cols);
        const inRow = Math.min(cols, ordered.length - row * cols);
        const y = rows === 1 ? height / 2 : topPad + (row / (rows - 1)) * usableH;
        const x = colW * ((index % cols) + 0.5 + (cols - inRow) / 2);
        result.set(node.name, { x, y });
      });
      return result;
    }

    if (ordered.length === 1) {
      result.set(ordered[0].name, { x: width / 2, y: height / 2 });
      return result;
    }

    const maxHalfW = Math.max(...ordered.map(n => nodeBox(n, { variant: 'pill', narrow }).halfW), 56);
    const maxHalfH = Math.max(...ordered.map(n => nodeBox(n, { variant: 'pill', narrow }).halfH), 17);
    const topPad = maxHalfH + 18;
    const bottomPad = maxHalfH + 22;
    const sidePad = Math.min(width * 0.28, maxHalfW + 18);
    const centerX = width / 2;
    const centerY = (topPad + (height - bottomPad)) / 2;
    const radiusX = Math.max(48, Math.min(width * 0.42, width / 2 - sidePad));
    const radiusY = Math.max(44, (height - topPad - bottomPad) / 2);

    ordered.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / ordered.length;
      result.set(node.name, {
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + Math.sin(angle) * radiusY,
      });
    });
    return result;
  }

  function estimateNameLines(name, charsPerLine) {
    const text = String(name ?? '').trim();
    if (!text) return 1;
    const limit = Math.max(6, charsPerLine);
    const tokens = text.match(/[^-\s_/]+[-\s_/]*|[-\s_/]+/g) ?? [text];
    let lines = 1, used = 0;
    for (const token of tokens) {
      let remaining = token;
      while (remaining.length > limit) {
        if (used > 0) { lines++; used = 0; }
        remaining = remaining.slice(limit);
        lines++;
      }
      if (used > 0 && used + remaining.length > limit) {
        lines++;
        used = remaining.length;
      } else used += remaining.length;
    }
    return Math.max(1, lines);
  }

  function nodeBox(node, { variant = 'card', cardWidth, narrow = false } = {}) {
    if (variant === 'pill') {
      const raw = String(node?.name ?? '');
      const labelText = raw === 'user' ? 'You' : raw === 'system' ? 'System' : raw;
      const halfH = narrow ? 16 : 18;
      const maxW = narrow ? 156 : 210;
      const minW = narrow ? 88 : 104;
      const charW = narrow ? 6.4 : 7.2;
      const beeAndDot = narrow ? 38 : 46;
      const width = Math.min(maxW, Math.max(minW, beeAndDot + labelText.length * charW));
      return { halfW: width / 2, halfH, offsetX: 0, offsetY: 0, radius: halfH };
    }
    if (variant === 'hex') {
      const maxLabelW = narrow ? 84 : 128;
      const raw = String(node?.name ?? '');
      const labelText = raw === 'user' ? 'You' : raw === 'system' ? 'System' : '@' + raw;
      const charsPerLine = Math.max(8, Math.floor((maxLabelW - 12) / 6.3));
      const lines = estimateNameLines(labelText, charsPerLine);
      const labelW = Math.min(maxLabelW, Math.max(38, 12 + labelText.length * 6.3));
      const unmentioned = unmentionedNode(node ?? {});
      const halfW = Math.max(unmentioned ? 32 : 28, labelW / 2);
      const top = unmentioned ? 32 : (node?.broadcasts ? 29 : 24);
      const bottom = 29 + lines * 15 + 4;
      return { halfW, halfH: (top + bottom) / 2, offsetX: 0, offsetY: (bottom - top) / 2, radius: 10 };
    }
    const width = cardWidth ?? (narrow ? 92 : 112);
    const charsPerLine = Math.max(7, Math.floor((width - 20) / 7.4));
    const lines = estimateNameLines(node?.name ?? '', charsPerLine);
    const height = 64 + lines * 16;
    return { halfW: width / 2, halfH: height / 2, offsetX: 0, offsetY: 0, radius: 10 };
  }

  function normalizeBox(point, box) {
    if (!box) return { cx: point.x, cy: point.y, halfW: 26, halfH: 26, radius: 10 };
    if (Number.isFinite(box.left) && Number.isFinite(box.right) && Number.isFinite(box.top) && Number.isFinite(box.bottom)) {
      return {
        cx: point.x + (box.right - box.left) / 2,
        cy: point.y + (box.bottom - box.top) / 2,
        halfW: (box.left + box.right) / 2,
        halfH: (box.top + box.bottom) / 2,
        radius: Math.max(0, box.radius ?? 8),
      };
    }
    const halfW = Number.isFinite(box.halfW) ? box.halfW : (Number.isFinite(box.width) ? box.width / 2 : 26);
    const halfH = Number.isFinite(box.halfH) ? box.halfH : (Number.isFinite(box.height) ? box.height / 2 : 26);
    return {
      cx: (Number.isFinite(box.cx) ? box.cx : point.x + (box.offsetX ?? 0)),
      cy: (Number.isFinite(box.cy) ? box.cy : point.y + (box.offsetY ?? 0)),
      halfW: Math.max(1, halfW),
      halfH: Math.max(1, halfH),
      radius: Math.max(0, box.radius ?? 8),
    };
  }

  function roundedRectSignedDistance(px, py, box) {
    const r = Math.max(0, Math.min(box.radius ?? 0, box.halfW, box.halfH));
    const qx = Math.abs(px - box.cx) - (box.halfW - r);
    const qy = Math.abs(py - box.cy) - (box.halfH - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }

  function bezierPoint(p0, c, p1, t) {
    const u = 1 - t;
    return {
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    };
  }

  function blossomControl(p0, c, p1, u, v) {
    const a = (1 - u) * (1 - v);
    const b = (1 - u) * v + u * (1 - v);
    const d = u * v;
    return {
      x: a * p0.x + b * c.x + d * p1.x,
      y: a * p0.y + b * c.y + d * p1.y,
    };
  }

  function clipQuadratic(p0, c, p1, absFrom, absTo, marginStart, marginEnd, minLength) {
    const steps = 32;
    let lastInFrom = -1;
    for (let i = 0; i <= steps; i++) {
      const pt = bezierPoint(p0, c, p1, i / steps);
      if (roundedRectSignedDistance(pt.x, pt.y, absFrom) <= marginStart) lastInFrom = i;
    }
    if (lastInFrom >= steps) return null;
    let tStart = 0;
    if (lastInFrom >= 0) {
      let lo = lastInFrom / steps, hi = (lastInFrom + 1) / steps;
      for (let iter = 0; iter < 22; iter++) {
        const mid = (lo + hi) / 2;
        const pt = bezierPoint(p0, c, p1, mid);
        if (roundedRectSignedDistance(pt.x, pt.y, absFrom) <= marginStart) lo = mid; else hi = mid;
      }
      tStart = hi;
    }
    let firstInTo = -1;
    const scanFrom = Math.max(0, lastInFrom + 1);
    for (let i = scanFrom; i <= steps; i++) {
      const pt = bezierPoint(p0, c, p1, i / steps);
      if (roundedRectSignedDistance(pt.x, pt.y, absTo) <= marginEnd) { firstInTo = i; break; }
    }
    if (firstInTo <= 0) return null;
    let lo = (firstInTo - 1) / steps, hi = firstInTo / steps;
    for (let iter = 0; iter < 22; iter++) {
      const mid = (lo + hi) / 2;
      const pt = bezierPoint(p0, c, p1, mid);
      if (roundedRectSignedDistance(pt.x, pt.y, absTo) <= marginEnd) hi = mid; else lo = mid;
    }
    const tEnd = lo;
    if (tEnd <= tStart + 1e-4) return null;
    const start = bezierPoint(p0, c, p1, tStart);
    const end = bezierPoint(p0, c, p1, tEnd);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < minLength) return null;
    const control = blossomControl(p0, c, p1, tStart, tEnd);
    const mid = bezierPoint(p0, c, p1, (tStart + tEnd) / 2);
    const endDx = end.x - control.x, endDy = end.y - control.y;
    const startDx = control.x - start.x, startDy = control.y - start.y;
    const endAngle = Math.hypot(endDx, endDy) > 1e-4 ? Math.atan2(endDy, endDx) : Math.atan2(end.y - start.y, end.x - start.x);
    const startAngle = Math.hypot(startDx, startDy) > 1e-4 ? Math.atan2(startDy, startDx) : Math.atan2(end.y - start.y, end.x - start.x);
    const d = 'M' + start.x.toFixed(1) + ' ' + start.y.toFixed(1) + ' Q' + control.x.toFixed(1) + ' ' + control.y.toFixed(1) + ' ' + end.x.toFixed(1) + ' ' + end.y.toFixed(1);
    return { start, control, end, mid, startAngle, endAngle, length, tStart, tEnd, d };
  }

  function curveClearance(clipped, obstacles) {
    if (!obstacles.length) return Infinity;
    let minClear = Infinity;
    for (let i = 0; i <= 24; i++) {
      const pt = bezierPoint(clipped.start, clipped.control, clipped.end, i / 24);
      for (const box of obstacles) {
        const dist = roundedRectSignedDistance(pt.x, pt.y, box);
        if (dist < minClear) minClear = dist;
      }
    }
    for (const box of obstacles) {
      const midDist = roundedRectSignedDistance(clipped.mid.x, clipped.mid.y, box) - 10;
      if (midDist < minClear) minClear = midDist;
    }
    return minClear;
  }

  function clipEdge(from, to, fromBox, toBox, {
    marginStart = 6,
    marginEnd = 7,
    bidirectional = false,
    bend,
    obstacles = [],
    obstacleMargin = 8,
    minLength = 8,
  } = {}) {
    if (!from || !to) return null;
    const absFrom = normalizeBox(from, fromBox);
    const absTo = normalizeBox(to, toBox);
    const p0 = { x: absFrom.cx, y: absFrom.cy };
    const p1 = { x: absTo.cx, y: absTo.cy };
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return null;
    const ux = dx / distance, uy = dy / distance;
    const nx = -uy, ny = ux;
    const absObstacles = obstacles.map(item => item?.box ? normalizeBox(item, item.box) : normalizeBox(item, item));
    const candidates = [];
    if (Number.isFinite(bend)) {
      candidates.push(bend);
    } else if (bidirectional) {
      const base = Math.min(34, Math.max(18, distance * 0.145));
      candidates.push(
        base,
        Math.min(54, base * 1.45),
        Math.max(10, base * 0.55),
        Math.min(72, distance * 0.3),
        Math.max(6, base * 0.3)
      );
    } else {
      const base = Math.min(20, Math.max(8, distance * 0.065));
      const maxBend = Math.min(82, distance * 0.34);
      candidates.push(
        base,
        -base,
        0,
        Math.min(maxBend, base * 2),
        -Math.min(maxBend, base * 2),
        Math.min(maxBend, base * 3.2),
        -Math.min(maxBend, base * 3.2),
        maxBend,
        -maxBend
      );
    }

    const attempt = (mStart, mEnd, minLen) => {
      let best = null, bestClear = -Infinity;
      for (const offset of candidates) {
        const c = { x: (p0.x + p1.x) / 2 + nx * offset, y: (p0.y + p1.y) / 2 + ny * offset };
        const clipped = clipQuadratic(p0, c, p1, absFrom, absTo, mStart, mEnd, minLen);
        if (!clipped) continue;
        const clear = curveClearance(clipped, absObstacles);
        const result = { ...clipped, bend: offset, clearance: clear };
        if (clear >= obstacleMargin) return result;
        if (clear > bestClear) { bestClear = clear; best = result; }
      }
      return best;
    };

    return attempt(marginStart, marginEnd, minLength) ??
      attempt(Math.min(marginStart, 2), Math.min(marginEnd, 3), Math.min(minLength, 4));
  }

  function routeEdges(projection, points, {
    variant = 'card',
    boxes,
    cardWidth,
    narrow = false,
    marginStart = 6,
    marginEnd = 7,
    obstacleMargin = 8,
    minLength = 8,
  } = {}) {
    const nodeBoxes = new Map();
    for (const node of projection.nodes ?? []) {
      const custom = boxes?.get?.(node.name);
      nodeBoxes.set(node.name, custom ?? nodeBox(node, { variant, cardWidth, narrow }));
    }
    const keys = new Set((projection.links ?? []).map(link => link.from + '>' + link.to));
    const byKey = new Map();
    const routed = [];
    const obstaclesFor = (fromName, toName) => {
      const list = [];
      for (const node of projection.nodes ?? []) {
        if (node.name === fromName || node.name === toName) continue;
        const pt = points.get(node.name);
        if (!pt) continue;
        list.push({ x: pt.x, y: pt.y, box: nodeBoxes.get(node.name) });
      }
      return list;
    };
    for (const link of projection.links ?? []) {
      const start = points.get(link.from), end = points.get(link.to);
      if (!start || !end) continue;
      const fromBox = nodeBoxes.get(link.from) ?? nodeBox({ name: link.from }, { variant, cardWidth, narrow });
      const toBox = nodeBoxes.get(link.to) ?? nodeBox({ name: link.to }, { variant, cardWidth, narrow });
      const obstacles = obstaclesFor(link.from, link.to);
      const bidirectional = keys.has(link.to + '>' + link.from);
      const edge = clipEdge(start, end, fromBox, toBox, {
        marginStart, marginEnd, bidirectional, obstacles, obstacleMargin, minLength,
      });
      if (edge) {
        const entry = { link, edge, bidirectional, fromBox, toBox, obstacles };
        routed.push(entry);
        byKey.set(link.from + '>' + link.to, entry);
      }
    }
    for (const entry of routed) {
      if (!entry.bidirectional || entry.edge.clearance >= Math.min(obstacleMargin, 16)) continue;
      const twin = byKey.get(entry.link.to + '>' + entry.link.from);
      if (!twin || twin.edge.clearance < Math.min(obstacleMargin, 16)) continue;
      const aPt = points.get(entry.link.from), bPt = points.get(entry.link.to);
      for (const innerBend of [-18, -26, -36, -48]) {
        const altInner = clipEdge(aPt, bPt, entry.fromBox, entry.toBox, {
          marginStart, marginEnd, bidirectional: true, bend: innerBend, obstacles: entry.obstacles, obstacleMargin, minLength,
        });
        if (!altInner || altInner.clearance < 10) continue;
        const outerBend = Math.max(twin.edge.bend, Math.abs(innerBend) + 28);
        const altOuter = clipEdge(bPt, aPt, twin.fromBox, twin.toBox, {
          marginStart, marginEnd, bidirectional: true, bend: outerBend, obstacles: twin.obstacles, obstacleMargin, minLength,
        });
        if (altOuter && altOuter.clearance >= 10 && Math.hypot(altInner.mid.x - altOuter.mid.x, altInner.mid.y - altOuter.mid.y) >= 12) {
          entry.edge = altInner;
          twin.edge = altOuter;
          break;
        }
      }
    }
    const placedPills = [];
    const pillClear = (pt, obstacles, minObs) => {
      for (const item of obstacles) {
        const box = item?.box ? normalizeBox(item, item.box) : normalizeBox(item, item);
        if (roundedRectSignedDistance(pt.x, pt.y, box) < minObs) return false;
      }
      for (const other of placedPills) {
        if (Math.hypot(pt.x - other.x, pt.y - other.y) < 26) return false;
      }
      return true;
    };
    const allBoxes = [];
    for (const node of projection.nodes ?? []) {
      const pt = points.get(node.name);
      if (pt) allBoxes.push({ x: pt.x, y: pt.y, box: nodeBoxes.get(node.name) });
    }
    for (const entry of routed) {
      const { edge, link } = entry;
      if (edge.length < 40) continue;
      const p0 = edge.start, c = edge.control, p1 = edge.end;
      let chosen = edge.mid;
      if (!pillClear(chosen, allBoxes, 12)) {
        for (const t of [0.38, 0.62, 0.32, 0.68, 0.44, 0.56]) {
          const cand = bezierPoint(p0, c, p1, t);
          if (pillClear(cand, allBoxes, 12)) { chosen = cand; break; }
        }
      }
      edge.mid = chosen;
      if (link.count > 1) placedPills.push(chosen);
    }
    return routed.map(({ link, edge, bidirectional }) => ({ link, edge, bidirectional }));
  }

  function projectHive(posts, members, cursor) {
    const effectiveCursor = (cursor === null || cursor === undefined) ? Infinity : Number(cursor);
    const validPosts = (posts ?? []).filter(event => isPost(event) && Number.isFinite(event.seq))
      .slice().sort((a, b) => a.seq - b.seq);
    const maxSeq = validPosts.reduce((max, event) => Math.max(max, event.seq), 0);
    const atHead = effectiveCursor >= maxSeq;
    const activePosts = validPosts.filter(event => event.seq <= effectiveCursor);
    const lastPost = activePosts.at(-1) ?? null;

    const lastPostByAuthor = new Map();
    const lastSeqByAuthor = new Map();
    const briefSeqByMember = new Map();
    const mentionSeqByMember = new Map();
    for (const event of activePosts) {
      lastSeqByAuthor.set(event.author, event.seq);
      lastPostByAuthor.set(event.author, event);
      const targets = new Set([...(event.targets ?? []), ...(event.coordinatorMention ? ['coordinator'] : [])]);
      for (const target of targets) {
        if (event.kind === 'brief') briefSeqByMember.set(target, event.seq);
        mentionSeqByMember.set(target, event.seq);
      }
    }

    const roster = members ?? [];
    const coordSource = roster.find(m => m.role === 'coordinator' || m.name === 'coordinator') ??
      { name: 'coordinator', role: 'coordinator', status: 'waiting' };
    const workers = roster.filter(m => m.role !== 'coordinator' && m.name !== 'coordinator');

    const bucketDefs = [
      { id: 'working', label: 'Working', tone: 'working' },
      { id: 'waiting', label: 'Waiting', tone: 'waiting' },
      { id: 'needs', label: 'Needs you', tone: 'needs' },
      { id: 'done', label: 'Done', tone: 'done' },
    ];
    const buckets = new Map(bucketDefs.map(def => [def.id, { ...def, count: 0, members: [] }]));
    const clusterByMember = new Map([['coordinator', 'coordinator']]);

    for (const worker of workers) {
      const latestSeq = lastSeqByAuthor.get(worker.name) ?? 0;
      let status;
      let recoveryRequired = false;
      let pendingWaitFor = [];

      if (atHead) {
        status = worker.status ?? 'waiting';
        recoveryRequired = Boolean(worker.recoveryRequired);
        pendingWaitFor = [...(worker.pendingWaitFor ?? worker.waitFor ?? [])];
      } else {
        const lastP = lastPostByAuthor.get(worker.name);
        const briefSeq = briefSeqByMember.get(worker.name) ?? 0;
        const mentionSeq = mentionSeqByMember.get(worker.name) ?? 0;
        if (effectiveCursor <= 0) status = 'waiting';
        else if (lastP && /\[done\]/i.test(String(lastP.text ?? ''))) status = 'done';
        else if (lastPost?.author === worker.name) status = 'working';
        else if (Math.max(briefSeq, mentionSeq) > (lastP?.seq ?? 0)) status = 'working';
        else status = 'waiting';
      }

      let bucketId;
      if (recoveryRequired || status === 'failed' || status === 'quota') bucketId = 'needs';
      else if (status === 'working') bucketId = 'working';
      else if (status === 'done' || status === 'retired') bucketId = 'done';
      else bucketId = 'waiting';

      const muted = bucketId === 'done';
      const entry = {
        name: worker.name,
        status,
        role: worker.role ?? 'worker',
        tint: worker.tint,
        muted,
        latestSeq,
        pendingWaitFor,
      };
      const bucket = buckets.get(bucketId);
      bucket.members.push(entry);
      bucket.count = bucket.members.length;
      clusterByMember.set(worker.name, bucketId);
    }

    const clusters = bucketDefs
      .map(def => buckets.get(def.id))
      .filter(cluster => cluster.count > 0);

    const totalWorkers = workers.length;
    const doneCount = buckets.get('done').count;
    let phase;
    if (buckets.get('needs').count > 0) phase = 'stalled';
    else if (buckets.get('working').count > 0 || (atHead && coordSource.status === 'working')) phase = 'working';
    else if (totalWorkers > 0 && doneCount === totalWorkers) phase = 'done';
    else phase = 'waiting';

    const coordinator = {
      name: 'coordinator',
      status: atHead ? (coordSource.status ?? phase) : (lastPost?.author === 'coordinator' ? 'working' : phase),
      role: 'coordinator',
      doneCount,
      totalWorkers,
      phase,
      latestSeq: lastSeqByAuthor.get('coordinator') ?? 0,
      tint: coordSource.tint,
    };

    const connectors = [];
    const seenConn = new Set();
    const addConnector = conn => {
      const key = `${conn.from}>${conn.to}>${conn.kind}`;
      if (seenConn.has(key)) return;
      seenConn.add(key);
      connectors.push(conn);
    };

    if (buckets.get('done').count > 0) {
      addConnector({ from: 'done', to: 'coordinator', kind: 'done', label: 'Tasks done' });
    }

    if (lastPost && (effectiveCursor === Infinity || lastPost.seq === effectiveCursor || !atHead)) {
      const fromCell = clusterByMember.get(lastPost.author);
      if (fromCell) {
        const allFlag = lastPost.broadcast ?? /(?:^|[^a-z0-9_])@all(?![a-z0-9_-])/i.test(lastPost.text ?? '');
        const rawTargets = [
          ...(lastPost.targets ?? []),
          ...(lastPost.coordinatorMention ? ['coordinator'] : []),
        ];
        if (allFlag) {
          for (const cluster of clusters) {
            if (cluster.id !== fromCell) {
              addConnector({ from: fromCell, to: cluster.id, kind: 'message', label: 'Message just sent', seq: lastPost.seq });
            }
          }
          if (fromCell !== 'coordinator') {
            addConnector({ from: fromCell, to: 'coordinator', kind: 'message', label: 'Message just sent', seq: lastPost.seq });
          }
        } else {
          for (const target of rawTargets) {
            const toCell = clusterByMember.get(target);
            if (toCell && toCell !== fromCell) {
              addConnector({ from: fromCell, to: toCell, kind: 'message', label: 'Message just sent', seq: lastPost.seq });
            }
          }
        }
      }
    }

    for (const cluster of clusters) {
      for (const member of cluster.members) {
        for (const blocker of member.pendingWaitFor ?? []) {
          const toCell = clusterByMember.get(blocker);
          if (toCell) {
            addConnector({ from: cluster.id, to: toCell, kind: 'waiting', label: 'Waiting on' });
          }
        }
      }
    }

    return {
      currentSeq: lastPost?.seq ?? 0,
      lastPost,
      coordinator,
      clusters,
      connectors,
    };
  }

  function hexVertices(cx, cy, radius) {
    const vertices = [];
    for (let i = 0; i < 6; i++) {
      const angle = (i * Math.PI) / 3;
      vertices.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
    return vertices;
  }

  function hiveSlotRows(count) {
    if (count <= 0) return [];
    if (count <= 3) return [count];
    if (count === 4) return [2, 2];
    if (count === 5) return [3, 2];
    if (count === 6) return [3, 3];
    if (count === 7) return [4, 3];
    if (count === 8) return [4, 4];
    if (count === 9) return [3, 4, 2];
    if (count === 10) return [4, 4, 2];
    if (count === 11) return [4, 4, 3];
    if (count === 12) return [4, 4, 4];
    const rows = [];
    let rem = count;
    while (rem > 0) {
      const take = Math.min(4, rem);
      rows.push(take);
      rem -= take;
    }
    return rows;
  }

  function computeClusterSlots(cx, cy, radius, members) {
    const count = members.length;
    if (!count) return [];
    const halfH = (SQRT3 / 2) * radius;
    const rows = hiveSlotRows(count);
    const rowCount = rows.length;
    const topBand = -halfH * 0.24;
    const bottomBand = halfH * 0.62;
    const bandCenter = rowCount === 1 ? halfH * 0.12 : (topBand + bottomBand) / 2;
    const bandSpan = bottomBand - topBand;
    const beeScale = count > 6
      ? Math.max(0.7, Math.min(0.98, radius / 106))
      : Math.max(0.82, Math.min(1.12, radius / 95));

    const slots = [];
    let idx = 0;
    for (let r = 0; r < rowCount; r++) {
      const cols = rows[r];
      const ry = rowCount === 1
        ? cy + bandCenter
        : cy + topBand + (r / (rowCount - 1)) * bandSpan;
      const dy = ry - cy;
      // Exact horizontal half-span inside flat-top hexagon at dy (with margin for bee + label height).
      const usableHalfW = Math.max(14, radius - (Math.abs(dy) + 14) / SQRT3 - 10);
      const maxSpacing = count > 6 ? 42 : 58;
      const stepX = cols === 1 ? 0 : Math.min(maxSpacing, (usableHalfW * 1.9) / Math.max(cols - 0.35, 1));
      const slotWidth = cols === 1 ? Math.min(82, usableHalfW * 1.75) : Math.max(24, stepX - 4);
      for (let c = 0; c < cols; c++) {
        const rx = cx + (c - (cols - 1) / 2) * stepX;
        slots.push({
          member: members[idx++],
          x: rx,
          y: ry,
          slotWidth,
          beeScale,
        });
      }
    }
    return slots;
  }

  function hiveMinimumHeight(clusterCount, width) {
    if (clusterCount <= 1) return width < 420 ? 380 : 440;
    if (clusterCount === 2) return width < 420 ? 440 : 430;
    return 490;
  }

  function layoutHive(hiveModel, width = 680, height = 460) {
    const clusters = hiveModel?.clusters ?? [];
    const legendH = 34;
    const topPad = 14;
    const sidePad = 16;
    const availW = Math.max(200, width - sidePad * 2);
    const availH = Math.max(220, height - topPad - legendH);

    let radius;
    const specs = [];

    if (clusters.length === 0) {
      radius = Math.max(48, Math.min(availW / 2.2, availH / (SQRT3 * 1.15), 114));
      specs.push({ id: 'coordinator', ux: 0, uy: 0, isCoord: true });
    } else if (clusters.length === 1) {
      const gap = Math.max(12, Math.min(20, availH * 0.036));
      radius = Math.max(46, Math.min(availW / 2.15, (availH - gap) / (2 * SQRT3), 112));
      const D = SQRT3 * radius + gap;
      const centerX = width / 2;
      const centerY = topPad + availH / 2;
      const cellsById = new Map();
      const topCenter = { x: centerX, y: centerY - D / 2 };
      const botCenter = { x: centerX, y: centerY + D / 2 };

      const c0 = clusters[0];
      const clusterCell = {
        id: c0.id,
        label: c0.label,
        tone: c0.tone,
        count: c0.count,
        x: topCenter.x,
        y: topCenter.y,
        radius,
        vertices: hexVertices(topCenter.x, topCenter.y, radius),
        slots: computeClusterSlots(topCenter.x, topCenter.y, radius, c0.members ?? []),
      };
      const coordCell = {
        id: 'coordinator',
        x: botCenter.x,
        y: botCenter.y,
        radius,
        vertices: hexVertices(botCenter.x, botCenter.y, radius),
        model: hiveModel.coordinator,
      };
      cellsById.set(clusterCell.id, clusterCell);
      cellsById.set('coordinator', coordCell);
      return { width, height, radius, coordinator: coordCell, clusters: [clusterCell], cellsById };
    } else if (clusters.length === 2) {
      specs.push({ id: 'coordinator', ux: 0, uy: 0.35, isCoord: true });
      if (availW >= availH * 0.85) {
        specs.push({ id: clusters[0].id, cluster: clusters[0], ux: -SQRT3 / 2, uy: -0.15 });
        specs.push({ id: clusters[1].id, cluster: clusters[1], ux: SQRT3 / 2, uy: -0.15 });
      } else {
        specs.push({ id: clusters[0].id, cluster: clusters[0], ux: 0, uy: -0.65 });
        specs.push({ id: clusters[1].id, cluster: clusters[1], ux: 0, uy: 1.35 });
      }
    } else if (clusters.length === 3) {
      specs.push({ id: 'coordinator', ux: 0, uy: 0, isCoord: true });
      specs.push({ id: clusters[0].id, cluster: clusters[0], ux: 0, uy: -1 });
      specs.push({ id: clusters[1].id, cluster: clusters[1], ux: -SQRT3 / 2, uy: 0.5 });
      specs.push({ id: clusters[2].id, cluster: clusters[2], ux: SQRT3 / 2, uy: 0.5 });
    } else {
      specs.push({ id: 'coordinator', ux: 0, uy: 0, isCoord: true });
      specs.push({ id: clusters[0].id, cluster: clusters[0], ux: -SQRT3 / 2, uy: -0.5 });
      specs.push({ id: clusters[1].id, cluster: clusters[1], ux: SQRT3 / 2, uy: -0.5 });
      specs.push({ id: clusters[2].id, cluster: clusters[2], ux: -SQRT3 / 2, uy: 0.5 });
      specs.push({ id: clusters[3].id, cluster: clusters[3], ux: SQRT3 / 2, uy: 0.5 });
      for (let i = 4; i < clusters.length; i++) {
        specs.push({ id: clusters[i].id, cluster: clusters[i], ux: 0, uy: i === 4 ? -1 : 1 });
      }
    }

    const minUX = Math.min(...specs.map(s => s.ux));
    const maxUX = Math.max(...specs.map(s => s.ux));
    const minUY = Math.min(...specs.map(s => s.uy));
    const maxUY = Math.max(...specs.map(s => s.uy));
    const spanUX = maxUX - minUX;
    const spanUY = maxUY - minUY;
    const gap = Math.max(10, Math.min(18, availH * 0.03));

    const maxRWidth = (availW - spanUX * gap) / (spanUX * SQRT3 + 2);
    const maxRHeight = (availH - spanUY * gap) / (spanUY * SQRT3 + SQRT3);
    radius = Math.max(40, Math.min(maxRWidth, maxRHeight, 108));

    const D = SQRT3 * radius + gap;
    const midUX = (minUX + maxUX) / 2;
    const midUY = (minUY + maxUY) / 2;
    const originX = width / 2 - midUX * D;
    const originY = topPad + availH / 2 - midUY * D;

    const cellsById = new Map();
    let coordCell = null;
    const clusterCells = [];

    for (const spec of specs) {
      const cx = originX + spec.ux * D;
      const cy = originY + spec.uy * D;
      const vertices = hexVertices(cx, cy, radius);
      if (spec.isCoord) {
        coordCell = { id: 'coordinator', x: cx, y: cy, radius, vertices, model: hiveModel?.coordinator };
        cellsById.set('coordinator', coordCell);
      } else {
        const cl = spec.cluster;
        const cell = {
          id: cl.id,
          label: cl.label,
          tone: cl.tone,
          count: cl.count,
          x: cx,
          y: cy,
          radius,
          vertices,
          slots: computeClusterSlots(cx, cy, radius, cl.members ?? []),
        };
        clusterCells.push(cell);
        cellsById.set(cell.id, cell);
      }
    }

    return {
      width,
      height,
      radius,
      coordinator: coordCell,
      clusters: clusterCells,
      cellsById,
    };
  }

  function hexRayExit(cell, ux, uy) {
    const apothem = (SQRT3 / 2) * cell.radius;
    const d1 = Math.abs(uy);
    const d2 = Math.abs(0.8660254037844386 * ux + 0.5 * uy);
    const d3 = Math.abs(0.8660254037844386 * ux - 0.5 * uy);
    return apothem / Math.max(d1, d2, d3, 1e-6);
  }

  function drawGrid(ctx, width, height, color) {
    const r = 22;
    const h = Math.sqrt(3) * r;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let col = -1; col < width / (r * 1.5) + 1; col++) {
      for (let row = -1; row < height / h + 1; row++) {
        const x = col * 1.5 * r;
        const y = row * h + ((col % 2) * h / 2);
        for (let side = 0; side < 6; side++) {
          const angle = side * Math.PI / 3;
          const px = x + r * Math.cos(angle), py = y + r * Math.sin(angle);
          if (side === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  }

  function pillPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    const x0 = x - w / 2, y0 = y - h / 2, x1 = x + w / 2, y1 = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + radius, y0);
    ctx.lineTo(x1 - radius, y0);
    ctx.quadraticCurveTo(x1, y0, x1, y0 + radius);
    ctx.lineTo(x1, y1 - radius);
    ctx.quadraticCurveTo(x1, y1, x1 - radius, y1);
    ctx.lineTo(x0 + radius, y1);
    ctx.quadraticCurveTo(x0, y1, x0, y1 - radius);
    ctx.lineTo(x0, y0 + radius);
    ctx.quadraticCurveTo(x0, y0, x0 + radius, y0);
    ctx.closePath();
  }

  function draw(canvas, projection, points, focus, highlight, color) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const scale = Math.min(devicePixelRatio || 1, 2);
    const pixelsWide = Math.round(width * scale), pixelsHigh = Math.round(height * scale);
    if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
      canvas.width = pixelsWide;
      canvas.height = pixelsHigh;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, width, height, color.grid);
    ctx.strokeStyle = color.accent;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([3, 3]);
    for (const node of projection.nodes) {
      const point = points.get(node.name);
      if (!point || !unmentionedNode(node)) continue;
      ctx.globalAlpha = !focus || focus === node.name ? 0.85 : 0.2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 31, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const routed = routeEdges(projection, points, {
      variant: 'hex', narrow: width < 465, marginStart: 6, marginEnd: 6, obstacleMargin: width < 465 ? 14 : 24,
    });
    for (const { link, edge } of routed) {
      const { start: a, control: c, end: b, mid, endAngle: angle } = edge;
      const pulse = link.lastSeq === highlight;
      const related = !focus || link.from === focus || link.to === focus;
      const stroke = pulse && related ? color.accent : color.link;
      ctx.globalAlpha = related ? (pulse ? 1 : 0.78) : 0.16;
      ctx.strokeStyle = ctx.fillStyle = stroke;
      ctx.lineWidth = Math.min(3.8, 1.1 + Math.sqrt(link.count) * 0.65);
      ctx.lineCap = 'round';
      ctx.setLineDash(link.direct ? [] : [4, 4]);
      const shaftInset = Math.min(4.5, edge.length * 0.25);
      const sx = b.x - Math.cos(angle) * shaftInset;
      const sy = b.y - Math.sin(angle) * shaftInset;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, sx, sy);
      ctx.stroke();
      ctx.setLineDash([]);
      const headLen = 9;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - headLen * Math.cos(angle - 0.44), b.y - headLen * Math.sin(angle - 0.44));
      ctx.lineTo(b.x - (headLen * 0.72) * Math.cos(angle), b.y - (headLen * 0.72) * Math.sin(angle));
      ctx.lineTo(b.x - headLen * Math.cos(angle + 0.44), b.y - headLen * Math.sin(angle + 0.44));
      ctx.closePath();
      ctx.fill();
      if (related && edge.length >= 40 && (link.count > 1 || pulse || focus)) {
        const label = String(link.count);
        const pillW = Math.max(20, label.length * 6.5 + 10);
        ctx.globalAlpha = 0.98;
        pillPath(ctx, mid.x, mid.y, pillW, 15, 7.5);
        ctx.fillStyle = color.paper;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = pulse ? color.accent : color.link;
        ctx.stroke();
        ctx.fillStyle = pulse ? color.accent : color.text;
        ctx.fillText(label, mid.x, mid.y + 0.25);
      }
    }
    ctx.globalAlpha = 1;
  }

  function themePalette(theme) {
    if (theme === 'dark') {
      return {
        bg: '#17140f',
        surface: '#221d16',
        ink: '#f5eddd',
        muted: '#bdb19a',
        border: '#43392b',
        edge: '#8c785c',
        pulse: '#c297ff',
        accent: '#f0b84b',
        doneFill: '#18281c',
        doneStroke: '#6ac47e',
        workingFill: '#2a2213',
        workingStroke: '#f0b84b',
        waitingFill: '#192133',
        waitingStroke: '#7da3f0',
        needsFill: '#2d1919',
        needsStroke: '#ef766e',
      };
    }
    return {
      bg: '#f8f9fb',
      surface: '#ffffff',
      ink: '#24292f',
      muted: '#6e7781',
      border: '#d0d7de',
      edge: '#b4bcc6',
      pulse: '#8250df',
      accent: '#bf8700',
      doneFill: '#eef6ee',
      doneStroke: '#55943c',
      workingFill: '#fdf6e7',
      workingStroke: '#d18d22',
      waitingFill: '#eef3fc',
      waitingStroke: '#4d78cc',
      needsFill: '#fdf0ef',
      needsStroke: '#cf483f',
    };
  }

  function toneStyle(tone, palette) {
    if (tone === 'done') return { fill: palette.doneFill, stroke: palette.doneStroke };
    if (tone === 'working') return { fill: palette.workingFill, stroke: palette.workingStroke };
    if (tone === 'needs' || tone === 'stalled') return { fill: palette.needsFill, stroke: palette.needsStroke };
    return { fill: palette.waitingFill, stroke: palette.waitingStroke };
  }

  function statusDotColor(status, palette) {
    if (status === 'working') return palette.doneStroke;
    if (status === 'failed' || status === 'quota') return palette.needsStroke;
    if (status === 'waiting' || status === 'queued') return palette.waitingStroke;
    return palette.muted;
  }

  function resolveBees(explicitBees) {
    if (explicitBees) return explicitBees;
    if (typeof window !== 'undefined' && window.HiveBee) return window.HiveBee;
    return globalThis.HiveBee;
  }

  function drawBeeOnCtx(ctx, x, y, name, beeOpts, beesLib) {
    if (beesLib?.drawSprite) {
      beesLib.drawSprite(ctx, x, y, name, beeOpts);
      return;
    }
    if (beesLib?.sprite && typeof document !== 'undefined') {
      const sprite = beesLib.sprite(name, beeOpts);
      const scale = beeOpts?.scale ?? 1;
      ctx.drawImage?.(sprite, x, y, sprite.width * scale, sprite.height * scale);
    }
  }

  function truncateFit(text, maxChars) {
    const str = String(text ?? '');
    if (str.length <= maxChars) return str;
    if (maxChars <= 3) return str.slice(0, maxChars);
    return str.slice(0, maxChars - 1) + '…';
  }

  function drawArrowHead(ctx, x, y, angle, len = 8) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - len * Math.cos(angle - 0.44), y - len * Math.sin(angle - 0.44));
    ctx.lineTo(x - (len * 0.7) * Math.cos(angle), y - (len * 0.7) * Math.sin(angle));
    ctx.lineTo(x - len * Math.cos(angle + 0.44), y - len * Math.sin(angle + 0.44));
    ctx.closePath();
    ctx.fill();
  }

  function drawHexPolygon(ctx, vertices) {
    ctx.beginPath();
    vertices.forEach((pt, idx) => {
      if (idx === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.closePath();
  }

  function renderHiveFrame(ctx, opts, palette, beesLib) {
    const { posts = [], members = [], cursor = null, phase, width = 680, height = 460, focus = null } = opts;
    const hiveModel = projectHive(posts, members, cursor);
    if (phase && (cursor === null || cursor === undefined)) {
      if (phase === 'done' && hiveModel.coordinator.totalWorkers > 0 && hiveModel.coordinator.doneCount === hiveModel.coordinator.totalWorkers) {
        hiveModel.coordinator.phase = 'done';
      } else if (phase === 'stalled' || phase === 'budget') {
        hiveModel.coordinator.phase = 'stalled';
      }
    }
    const hiveLayout = layoutHive(hiveModel, width, height);

    // Draw connectors between hex borders.
    for (const conn of hiveModel.connectors) {
      const fromCell = hiveLayout.cellsById.get(conn.from);
      const toCell = hiveLayout.cellsById.get(conn.to);
      if (!fromCell || !toCell) continue;
      const stroke = conn.kind === 'message' ? palette.pulse
        : conn.kind === 'waiting' ? palette.workingStroke
          : palette.doneStroke;
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = conn.kind === 'message' ? 2.2 : 1.5;
      ctx.setLineDash?.(conn.kind === 'waiting' ? [4, 4] : []);

      if (fromCell === toCell) {
        const vx = fromCell.x + fromCell.radius * 0.72;
        const vy = fromCell.y - (SQRT3 / 2) * fromCell.radius * 0.4;
        ctx.beginPath();
        ctx.arc(vx + 8, vy, 10, -Math.PI * 0.8, Math.PI * 0.8);
        ctx.stroke();
        ctx.setLineDash?.([]);
        continue;
      }

      const dx = toCell.x - fromCell.x;
      const dy = toCell.y - fromCell.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      const ux = dx / dist, uy = dy / dist;
      const exitA = hexRayExit(fromCell, ux, uy);
      const exitB = hexRayExit(toCell, -ux, -uy);
      const lateral = conn.kind === 'message' ? 8 : conn.kind === 'waiting' ? -8 : 0;
      const nx = -uy, ny = ux;
      const ax = fromCell.x + ux * (exitA + 2) + nx * lateral;
      const ay = fromCell.y + uy * (exitA + 2) + ny * lateral;
      const bx = toCell.x - ux * (exitB + 2) + nx * lateral;
      const by = toCell.y - uy * (exitB + 2) + ny * lateral;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash?.([]);
      if (conn.kind !== 'done') {
        drawArrowHead(ctx, bx, by, Math.atan2(by - ay, bx - ax), 7);
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw state cluster hexagons.
    for (const cluster of hiveLayout.clusters) {
      const style = toneStyle(cluster.tone, palette);
      const hasFocus = Boolean(focus);
      const clusterFocused = !hasFocus || cluster.slots.some(s => s.member.name === focus);
      ctx.globalAlpha = clusterFocused ? 1 : 0.38;
      drawHexPolygon(ctx, cluster.vertices);
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.stroke;
      ctx.stroke();

      const halfH = (SQRT3 / 2) * cluster.radius;
      ctx.fillStyle = palette.ink;
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(cluster.label, cluster.x, cluster.y - halfH * 0.68);
      ctx.fillStyle = palette.muted;
      ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(String(cluster.count), cluster.x, cluster.y - halfH * 0.50);

      for (const slot of cluster.slots) {
        const s = slot.beeScale;
        const beeW = 20 * s;
        const beeH = 18 * s;
        const slotDim = hasFocus && focus !== slot.member.name;
        ctx.globalAlpha = slotDim ? 0.35 : 1;
        if (hasFocus && focus === slot.member.name) {
          ctx.strokeStyle = palette.accent;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(slot.x, slot.y - 2, Math.max(beeW, beeH) * 0.72, 0, Math.PI * 2);
          ctx.stroke();
        }
        drawBeeOnCtx(ctx, slot.x - beeW / 2, slot.y - beeH * 0.68, slot.member.name, {
          status: slot.member.status,
          coordinator: false,
          tint: slot.member.tint,
          muted: slot.member.muted,
          scale: s,
        }, beesLib);
        ctx.fillStyle = slot.member.muted ? palette.muted : palette.ink;
        ctx.font = '500 10px "Segoe UI", system-ui, sans-serif';
        const maxChars = Math.max(5, Math.floor(slot.slotWidth / 5.4));
        ctx.fillText(truncateFit(slot.member.name, maxChars), slot.x, slot.y + beeH * 0.62);
      }
    }

    // Draw Coordinator hexagon.
    const coord = hiveLayout.coordinator;
    if (coord) {
      const coordTone = toneStyle(coord.model?.phase ?? 'waiting', palette);
      ctx.globalAlpha = !focus || focus === 'coordinator' ? 1 : 0.45;
      drawHexPolygon(ctx, coord.vertices);
      ctx.fillStyle = coordTone.fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = coordTone.stroke;
      ctx.stroke();

      const coordScale = Math.max(1.2, Math.min(2.1, coord.radius / 48));
      const cBeeW = 20 * coordScale;
      const cBeeH = 18 * coordScale;
      drawBeeOnCtx(ctx, coord.x - cBeeW / 2, coord.y - cBeeH * 0.78, 'coordinator', {
        status: coord.model?.status ?? 'waiting',
        coordinator: true,
        tint: coord.model?.tint,
        muted: false,
        scale: coordScale,
      }, beesLib);

      const halfH = (SQRT3 / 2) * coord.radius;
      ctx.fillStyle = palette.ink;
      ctx.font = '650 12px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('Coordinator', coord.x, coord.y + halfH * 0.34);
      ctx.fillStyle = palette.muted;
      ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`${coord.model?.doneCount ?? 0} of ${coord.model?.totalWorkers ?? 0} done`, coord.x, coord.y + halfH * 0.56);
    }

    // Bottom legend matching Screenshot 1.
    ctx.globalAlpha = 1;
    const ly = height - 16;
    let lx = 24;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';

    ctx.strokeStyle = palette.doneStroke;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.fillStyle = palette.muted;
    ctx.fillText('Tasks done', lx + 22, ly);
    lx += 102;

    ctx.strokeStyle = palette.pulse;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.fillText('Message just sent', lx + 22, ly);
    lx += 136;

    ctx.strokeStyle = palette.workingStroke;
    ctx.fillStyle = palette.workingStroke;
    ctx.setLineDash?.([3, 3]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.setLineDash?.([]);
    drawArrowHead(ctx, lx + 20, ly, 0, 5);
    ctx.fillStyle = palette.muted;
    ctx.fillText('Waiting on', lx + 26, ly);
  }

  function renderMentionsFrame(ctx, opts, palette, beesLib) {
    const {
      posts = [], members = [], cursor = null, width = 680, height = 460,
      hideInactive = false, expandBroadcast = false, focus = null,
    } = opts;
    const validPosts = (posts ?? []).filter(isPost).slice().sort((a, b) => a.seq - b.seq);
    const effectiveSeq = (cursor === null || cursor === undefined)
      ? (validPosts.at(-1)?.seq ?? Infinity)
      : Number(cursor);
    const currentPost = validPosts.filter(p => p.seq <= effectiveSeq).at(-1) ?? null;
    const projection = project(posts, members, effectiveSeq, { hideInactive, expandBroadcast });
    const stageH = Math.max(220, height - 42);
    const narrow = width < 465;
    const points = layoutMentions(projection.nodes, width, stageH);

    const boxes = new Map();
    for (const node of projection.nodes) {
      boxes.set(node.name, nodeBox(node, { variant: 'pill', narrow }));
    }
    const routed = routeEdges(projection, points, {
      variant: 'pill', boxes, narrow, marginStart: 4, marginEnd: 6, obstacleMargin: 10,
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw routed Bézier mention edges.
    for (const { link, edge } of routed) {
      const { start: a, control: c, end: b, mid, endAngle: angle } = edge;
      const pulse = Boolean(currentPost && link.lastSeq === currentPost.seq);
      const related = !focus || link.from === focus || link.to === focus;
      const stroke = pulse && related ? palette.pulse : palette.edge;
      ctx.globalAlpha = related ? (pulse ? 0.96 : 0.72) : 0.16;
      ctx.strokeStyle = ctx.fillStyle = stroke;
      ctx.lineWidth = Math.min(4.2, 1.2 + Math.sqrt(link.count) * 0.72);
      ctx.setLineDash?.(link.direct ? [] : [4, 4]);
      const shaftInset = Math.min(4.5, edge.length * 0.25);
      const sx = b.x - Math.cos(angle) * shaftInset;
      const sy = b.y - Math.sin(angle) * shaftInset;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(c.x, c.y, sx, sy);
      ctx.stroke();
      ctx.setLineDash?.([]);
      drawArrowHead(ctx, b.x, b.y, angle, 8);

      if (related && edge.length >= 36 && (link.count > 1 || pulse || focus)) {
        const label = String(link.count);
        const badgeW = Math.max(16, label.length * 6.5 + 8);
        ctx.globalAlpha = 0.96;
        pillPath(ctx, mid.x, mid.y, badgeW, 14, 7);
        ctx.fillStyle = palette.bg;
        ctx.fill();
        ctx.fillStyle = pulse ? palette.pulse : palette.ink;
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.fillText(label, mid.x, mid.y + 0.5);
      }
    }

    // Draw capsule pill nodes.
    for (const node of projection.nodes) {
      const pt = points.get(node.name);
      const box = boxes.get(node.name);
      if (!pt || !box) continue;
      const isCoord = node.role === 'coordinator' || node.name === 'coordinator';
      const isRetired = node.status === 'retired';
      const isDone = node.status === 'done' || isRetired;
      const related = !focus || focus === node.name ||
        projection.links.some(l => (l.from === focus && l.to === node.name) || (l.to === focus && l.from === node.name));
      ctx.globalAlpha = related ? (isRetired ? 0.56 : 1) : 0.24;

      const unmentioned = unmentionedNode(node);
      pillPath(ctx, pt.x, pt.y, box.halfW * 2, box.halfH * 2, box.radius);
      ctx.fillStyle = palette.surface;
      ctx.fill();
      ctx.lineWidth = focus === node.name ? 1.8 : 1.1;
      ctx.strokeStyle = focus === node.name ? palette.pulse : palette.border;
      ctx.setLineDash?.(unmentioned ? [3, 3] : []);
      ctx.stroke();
      ctx.setLineDash?.([]);

      const leftEdge = pt.x - box.halfW;
      const rightEdge = pt.x + box.halfW;
      const beeScale = narrow ? 0.85 : 0.92;
      const beeW = 20 * beeScale;
      const beeH = 18 * beeScale;
      drawBeeOnCtx(ctx, leftEdge + 10, pt.y - beeH / 2, node.name, {
        status: node.status ?? 'observer',
        coordinator: isCoord,
        tint: node.tint,
        muted: !isCoord && isDone,
        scale: beeScale,
      }, beesLib);

      const labelText = node.name === 'user' ? 'You' : node.name === 'system' ? 'System' : node.name;
      const textX = (leftEdge + 10 + beeW + 6 + rightEdge - 14) / 2;
      ctx.fillStyle = isRetired ? palette.muted : palette.ink;
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      const maxChars = Math.max(5, Math.floor((box.halfW * 2 - beeW - 28) / 6.2));
      const drawnLabel = truncateFit(labelText, maxChars);
      ctx.fillText(drawnLabel, textX, pt.y + 0.5);

      if (isRetired) {
        const lineW = Math.min(box.halfW * 2 - beeW - 28, drawnLabel.length * 6.2);
        ctx.strokeStyle = palette.muted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(textX - lineW / 2, pt.y + 0.5);
        ctx.lineTo(textX + lineW / 2, pt.y + 0.5);
        ctx.stroke();
      }

      // Status indicator dot at right end of pill.
      ctx.fillStyle = statusDotColor(node.status, palette);
      ctx.beginPath();
      ctx.arc(rightEdge - 10, pt.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bottom legend matching Screenshot 2.
    ctx.globalAlpha = 1;
    const ly = height - 22;
    let lx = 24;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';

    ctx.strokeStyle = palette.edge;
    ctx.fillStyle = palette.edge;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 14, ly); ctx.stroke();
    drawArrowHead(ctx, lx + 18, ly, 0, 5);
    ctx.fillStyle = palette.muted;
    ctx.fillText('@mention, width = count', lx + 24, ly);
    lx += 168;

    ctx.strokeStyle = palette.edge;
    ctx.fillStyle = palette.edge;
    ctx.setLineDash?.([3, 3]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 14, ly); ctx.stroke();
    ctx.setLineDash?.([]);
    drawArrowHead(ctx, lx + 18, ly, 0, 5);
    ctx.fillStyle = palette.muted;
    ctx.fillText('via @all', lx + 24, ly);
    lx += 78;

    ctx.strokeStyle = palette.border;
    ctx.setLineDash?.([2, 2]);
    pillPath(ctx, lx + 8, ly, 16, 10, 5);
    ctx.stroke();
    ctx.setLineDash?.([]);
    ctx.fillStyle = palette.muted;
    ctx.fillText('posted with no mention', lx + 22, ly);

    if (projection.broadcasts > 0 && height >= 60) {
      const tag = '@all ' + projection.broadcasts;
      const by = height - 7;
      pillPath(ctx, 40, by - 1, 36, 14, 7);
      ctx.fillStyle = palette.border;
      ctx.fill();
      ctx.fillStyle = palette.ink;
      ctx.font = '600 9.5px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(tag, 40, by);
      ctx.textAlign = 'left';
      ctx.fillStyle = palette.muted;
      ctx.font = '500 10.5px "Segoe UI", system-ui, sans-serif';
      ctx.fillText('@all posts, drawn by Expand @all', 64, by);
    }
  }

  function renderGraphFrame(ctx, opts = {}) {
    if (!ctx) return;
    const width = opts.width ?? 680;
    const height = opts.height ?? 460;
    const theme = opts.theme === 'dark' ? 'dark' : 'light';
    const mode = opts.mode === 'mentions' ? 'mentions' : 'hive';
    const palette = themePalette(theme);
    const beesLib = resolveBees(opts.bees);

    ctx.save?.();
    ctx.clearRect?.(0, 0, width, height);
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    if (mode === 'mentions') {
      renderMentionsFrame(ctx, opts, palette, beesLib);
    } else {
      renderHiveFrame(ctx, opts, palette, beesLib);
    }
    ctx.restore?.();
  }

  globalThis.HiveGraph = Object.freeze({
    isPost, project, elapsedSpan, unmentionedNode, minimumHeight, layout,
    nodeBox, roundedRectSignedDistance, clipEdge, routeEdges, draw,
    smartTaskLabel, mentionsMinimumHeight, layoutMentions,
    projectHive, hiveMinimumHeight, layoutHive, renderGraphFrame,
  });
})();
