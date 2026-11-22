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

  function shouldMergeUserToCoordinator(members) {
    const list = members ?? [];
    const hasDedicatedCoordinator = list.some(m => (m.role === 'coordinator' || m.name === 'coordinator') && !m.external);
    const hasExplicitUserMember = list.some(m => m.name === 'user');
    return !hasDedicatedCoordinator && !hasExplicitUserMember;
  }

  function project(posts, members, cursor, { hideInactive = false, expandBroadcast = false } = {}) {
    const mergeUser = shouldMergeUserToCoordinator(members);
    const resolveActor = name => (mergeUser && name === 'user') ? 'coordinator' : name;
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
      const author = resolveActor(event.author);
      const targets = [...new Set([...(event.targets ?? []).map(resolveActor), ...(event.coordinatorMention ? ['coordinator'] : [])])];
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
      if (!all && !targets.some(to => to !== author)) outgoing.unmentioned++;
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

  function humanizeSlug(slug) {
    const parts = String(slug ?? '').trim().split(/[-_\s]+/).filter(Boolean);
    if (!parts.length) return 'Other';
    return parts.map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
  }

  function channelTopic(channels, name) {
    if (!channels || !name) return '';
    let entry;
    if (Array.isArray(channels)) entry = channels.find(c => c && c.name === name);
    else if (typeof channels.get === 'function') entry = channels.get(name);
    else if (typeof channels === 'object') entry = channels[name];
    const topic = typeof entry === 'string' ? entry : entry?.topic;
    return typeof topic === 'string' ? topic.trim() : '';
  }

  function normMemberKey(value) {
    return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
  }

  function workerBucketStatus(status, recoveryRequired) {
    if (recoveryRequired || status === 'failed' || status === 'quota') return 'needs';
    if (status === 'working') return 'working';
    if (status === 'done' || status === 'retired') return 'done';
    return 'waiting';
  }

  function buildGroupCluster({ id, title, goal = '', items, usedIds }) {
    let finalId = id === 'coordinator' ? 'group-coordinator' : id;
    while (usedIds.has(finalId)) finalId += '-2';
    usedIds.add(finalId);
    let doneCount = 0;
    let workingCount = 0;
    let needsCount = 0;
    for (const item of items) {
      if (item.bucketStatus === 'done') doneCount++;
      else if (item.bucketStatus === 'working') workingCount++;
      else if (item.bucketStatus === 'needs') needsCount++;
    }
    const totalCount = items.length;
    const tone = needsCount > 0 ? 'needs'
      : workingCount > 0 ? 'working'
        : (totalCount > 0 && doneCount === totalCount) ? 'done'
          : 'waiting';
    return {
      id: finalId,
      label: title,
      fullTitle: title,
      goal,
      mode: 'group',
      count: totalCount,
      totalCount,
      doneCount,
      workingCount,
      needsCount,
      subtitle: `${doneCount}/${totalCount}`,
      tone,
      members: items.map(item => item.entry),
    };
  }

  /**
   * Project board posts and roster into Hive clusters, coordinator summary, and connectors.
   * Supports 3-tier grouping: explicit threads -> worker group/non-main channel -> status buckets.
   */
  function projectHive(posts, members, cursor, options = {}) {
    const { threads = null, channels = null } = options ?? {};
    const mergeUser = shouldMergeUserToCoordinator(members);
    const resolveActor = name => (mergeUser && name === 'user') ? 'coordinator' : name;
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
    const doneAuthors = new Set();
    for (const event of activePosts) {
      const author = resolveActor(event.author);
      lastSeqByAuthor.set(author, event.seq);
      lastPostByAuthor.set(author, event);
      if (/\[done\]/i.test(String(event.text ?? ''))) doneAuthors.add(author);
      const targets = new Set([...(event.targets ?? []).map(resolveActor), ...(event.coordinatorMention ? ['coordinator'] : [])]);
      for (const target of targets) {
        if (event.kind === 'brief') briefSeqByMember.set(target, event.seq);
        mentionSeqByMember.set(target, event.seq);
      }
    }

    const roster = members ?? [];
    const coordSource = roster.find(m => m.role === 'coordinator' || m.name === 'coordinator') ??
      { name: 'coordinator', role: 'coordinator', status: 'waiting' };
    const workers = roster.filter(m => m.role !== 'coordinator' && m.name !== 'coordinator');

    const workerRecords = workers.map(worker => {
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
        const postedDone = Boolean(lastP && /\[done\]/i.test(String(lastP.text ?? '')));
        const rawWait = worker.waitFor ?? worker.pendingWaitFor ?? [];
        pendingWaitFor = postedDone
          ? []
          : rawWait.filter(dep => !doneAuthors.has(resolveActor(dep)));

        if (effectiveCursor <= 0) status = 'waiting';
        else if (postedDone) status = 'done';
        else if (resolveActor(lastPost?.author) === worker.name) status = 'working';
        else if (pendingWaitFor.length > 0) status = 'waiting';
        else if (Math.max(briefSeq, mentionSeq) > (lastP?.seq ?? 0)) status = 'working';
        else status = 'waiting';
      }

      const bucketStatus = workerBucketStatus(status, recoveryRequired);
      const entry = {
        name: worker.name,
        status,
        role: worker.role ?? 'worker',
        tint: worker.tint,
        muted: bucketStatus === 'done',
        latestSeq,
        pendingWaitFor,
        ...(worker.taskLabel ? { taskLabel: worker.taskLabel } : {}),
      };
      return { worker, entry, bucketStatus };
    });

    const clusters = [];
    const hasThreads = Array.isArray(threads) && threads.length > 0;
    const hasGroupOrChannel = !hasThreads && workerRecords.some(({ worker }) =>
      Boolean(String(worker.group ?? '').trim()) ||
      (Array.isArray(worker.channels) && worker.channels.some(ch => ch && ch !== 'main'))
    );

    if (hasThreads) {
      const assigned = new Set();
      const usedIds = new Set(['coordinator']);
      for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];
        if (!thread || typeof thread !== 'object') continue;
        const refs = new Set((thread.members ?? []).map(normMemberKey).filter(Boolean));
        const tIdNorm = normMemberKey(thread.id);
        const tTitleNorm = normMemberKey(thread.title);
        const matched = workerRecords.filter(({ worker }) => {
          if (assigned.has(worker.name)) return false;
          const wName = normMemberKey(worker.name);
          const wGroup = normMemberKey(worker.group);
          const wThread = normMemberKey(worker.thread);
          return refs.has(wName) ||
            (wGroup && refs.has(wGroup)) ||
            (wThread && (wThread === tIdNorm || wThread === tTitleNorm));
        });
        if (!matched.length) continue;
        for (const rec of matched) assigned.add(rec.worker.name);
        const title = String(thread.title ?? thread.id ?? 'Work group').trim() || 'Work group';
        clusters.push(buildGroupCluster({
          id: String(thread.id || `thread-${i + 1}`),
          title,
          goal: String(thread.goal ?? '').trim(),
          items: matched,
          usedIds,
        }));
      }
      const unassigned = workerRecords.filter(({ worker }) => !assigned.has(worker.name));
      if (unassigned.length) {
        clusters.push(buildGroupCluster({
          id: usedIds.has('other') ? 'other-unassigned' : 'other',
          title: 'Other',
          goal: '',
          items: unassigned,
          usedIds,
        }));
      }
    } else if (hasGroupOrChannel) {
      const grouped = new Map();
      const unassigned = [];
      for (const rec of workerRecords) {
        const groupSlug = String(rec.worker.group ?? '').trim();
        const primaryChannel = (rec.worker.channels ?? []).find(ch => ch && ch !== 'main');
        if (groupSlug) {
          const key = 'group:' + groupSlug;
          let bucket = grouped.get(key);
          if (!bucket) {
            bucket = { id: groupSlug, title: humanizeSlug(groupSlug), items: [] };
            grouped.set(key, bucket);
          }
          bucket.items.push(rec);
        } else if (primaryChannel) {
          const key = 'channel:' + primaryChannel;
          let bucket = grouped.get(key);
          if (!bucket) {
            const title = channelTopic(channels, primaryChannel) || humanizeSlug(primaryChannel);
            bucket = { id: primaryChannel, title, items: [] };
            grouped.set(key, bucket);
          }
          bucket.items.push(rec);
        } else {
          unassigned.push(rec);
        }
      }
      const usedIds = new Set(['coordinator']);
      for (const bucket of grouped.values()) {
        clusters.push(buildGroupCluster({ id: bucket.id, title: bucket.title, goal: '', items: bucket.items, usedIds }));
      }
      if (unassigned.length) {
        clusters.push(buildGroupCluster({
          id: usedIds.has('other') ? 'other-unassigned' : 'other',
          title: 'Other',
          goal: '',
          items: unassigned,
          usedIds,
        }));
      }
    } else {
      const bucketDefs = [
        { id: 'working', label: 'Working', tone: 'working' },
        { id: 'waiting', label: 'Waiting', tone: 'waiting' },
        { id: 'needs', label: 'Needs you', tone: 'needs' },
        { id: 'done', label: 'Done', tone: 'done' },
      ];
      const buckets = new Map(bucketDefs.map(def => [def.id, []]));
      for (const rec of workerRecords) buckets.get(rec.bucketStatus).push(rec);
      for (const def of bucketDefs) {
        const items = buckets.get(def.id);
        if (!items.length) continue;
        const count = items.length;
        clusters.push({
          id: def.id,
          label: def.label,
          fullTitle: def.label,
          goal: '',
          mode: 'status',
          count,
          totalCount: count,
          doneCount: def.id === 'done' ? count : 0,
          workingCount: def.id === 'working' ? count : 0,
          needsCount: def.id === 'needs' ? count : 0,
          subtitle: String(count),
          tone: def.tone,
          members: items.map(item => item.entry),
        });
      }
    }

    const clusterByMember = new Map([['coordinator', 'coordinator']]);
    for (const cluster of clusters) {
      for (const member of cluster.members) clusterByMember.set(member.name, cluster.id);
    }

    const totalWorkers = workers.length;
    let doneCount = 0;
    let workingCount = 0;
    let needsCount = 0;
    for (const rec of workerRecords) {
      if (rec.bucketStatus === 'done') doneCount++;
      else if (rec.bucketStatus === 'working') workingCount++;
      else if (rec.bucketStatus === 'needs') needsCount++;
    }

    let phase;
    if (needsCount > 0) phase = 'stalled';
    else if (workingCount > 0 || (atHead && coordSource.status === 'working')) phase = 'working';
    else if (totalWorkers > 0 && doneCount === totalWorkers) phase = 'done';
    else phase = 'waiting';

    const coordinator = {
      name: 'coordinator',
      status: atHead ? (coordSource.status ?? phase) : (resolveActor(lastPost?.author) === 'coordinator' ? 'working' : phase),
      role: 'coordinator',
      doneCount,
      totalWorkers,
      subtitle: `${doneCount} of ${totalWorkers} done`,
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

    for (const cluster of clusters) {
      const completed = cluster.mode === 'group'
        ? (cluster.totalCount > 0 && cluster.doneCount === cluster.totalCount)
        : (cluster.id === 'done' && cluster.count > 0);
      if (completed) {
        addConnector({ from: cluster.id, to: 'coordinator', kind: 'done', label: 'Tasks done' });
      }
    }

    if (lastPost && (effectiveCursor === Infinity || lastPost.seq === effectiveCursor || !atHead)) {
      const authorActor = resolveActor(lastPost.author);
      const fromCell = clusterByMember.get(authorActor);
      if (fromCell) {
        const allFlag = lastPost.broadcast ?? /(?:^|[^a-z0-9_])@all(?![a-z0-9_-])/i.test(lastPost.text ?? '');
        const rawTargets = [
          ...(lastPost.targets ?? []).map(resolveActor),
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
            if (target === authorActor) continue;
            const toCell = clusterByMember.get(target);
            if (toCell) {
              addConnector({ from: fromCell, to: toCell, kind: 'message', label: 'Message just sent', seq: lastPost.seq });
            }
          }
        }
      }
    }

    for (const cluster of clusters) {
      for (const member of cluster.members) {
        for (const blocker of member.pendingWaitFor ?? []) {
          const toCell = clusterByMember.get(resolveActor(blocker));
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

  /**
   * Wrap and optionally ellipsis-truncate a hex work-group title to fit within maxLines.
   */
  function wrapHexTitle(title, maxCharsPerLine = 14, maxLines = 2) {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    const limit = Math.max(4, Math.floor(Number(maxCharsPerLine) || 14));
    const lineCap = Math.max(1, Math.floor(Number(maxLines) || 2));
    if (!clean) return { lines: [], truncated: false };
    if (clean.length <= limit) return { lines: [clean], truncated: false };

    const words = clean.split(' ');
    const lines = [];
    let idx = 0;

    while (idx < words.length && lines.length < lineCap - 1) {
      const word = words[idx];
      if (word.length > limit) {
        lines.push(word.slice(0, limit));
        words[idx] = word.slice(limit);
        continue;
      }
      let line = word;
      idx++;
      while (idx < words.length && line.length + 1 + words[idx].length <= limit) {
        line += ' ' + words[idx];
        idx++;
      }
      lines.push(line);
    }

    if (idx >= words.length) return { lines, truncated: false };

    const remaining = words.slice(idx).join(' ');
    if (remaining.length <= limit) {
      lines.push(remaining);
      return { lines, truncated: false };
    }

    const budget = Math.max(1, limit - 3);
    let last = '';
    for (let i = idx; i < words.length; i++) {
      const cand = last ? last + ' ' + words[i] : words[i];
      if (cand.length <= budget) last = cand;
      else break;
    }
    if (!last) {
      last = words[idx].slice(0, budget);
    } else {
      const trimmed = last.replace(/[&,;:/-]+$/, '').trim();
      if (trimmed) last = trimmed;
    }
    lines.push(limit <= 3 ? '.'.repeat(limit) : last + '...');
    return { lines, truncated: true };
  }

  function computeClusterSlots(cx, cy, radius, members, bounds = null) {
    const count = members.length;
    if (!count) return [];
    const halfH = (SQRT3 / 2) * radius;
    const rows = hiveSlotRows(count);
    const rowCount = rows.length;
    const topY = bounds?.topY ?? (cy - halfH * 0.34);
    const bottomY = bounds?.bottomY ?? (cy + halfH * 0.72);
    const availBeeH = Math.max(22, bottomY - topY);

    let beeScale = count > 6
      ? Math.max(0.64, Math.min(0.98, radius / 106))
      : Math.max(0.72, Math.min(1.08, radius / 98));
    if (rowCount >= 2 && availBeeH < rowCount * 29) {
      beeScale = Math.max(0.52, Math.min(beeScale, availBeeH / (rowCount * 30)));
    }

    const slotTopPad = 12.5 * beeScale + 2;
    const slotBotPad = Math.max(10, 11 * beeScale + 4);
    const minRowY = topY + slotTopPad;
    const maxRowY = Math.max(minRowY, bottomY - slotBotPad);

    const slots = [];
    let idx = 0;
    for (let r = 0; r < rowCount; r++) {
      const cols = rows[r];
      let ry;
      if (rowCount === 1) {
        ry = Math.min((minRowY + maxRowY) / 2, Math.max(minRowY, cy + halfH * 0.14));
      } else {
        const span = Math.min(maxRowY - minRowY, (rowCount - 1) * 40);
        const startY = minRowY + Math.max(0, ((maxRowY - minRowY) - span) * 0.3);
        ry = startY + (r / (rowCount - 1)) * span;
      }
      const dy = ry - cy;
      // Exact horizontal half-span inside flat-top hexagon covering bee top and label bottom.
      const usableHalfW = Math.max(16, radius - Math.max(Math.abs(dy - 14 * beeScale), Math.abs(dy + 16)) / SQRT3 - 8);
      const maxSpacing = count > 6 ? 42 : 52;
      const stepX = cols === 1 ? 0 : Math.min(maxSpacing, (usableHalfW * 2 - 4) / cols);
      const slotWidth = cols === 1 ? Math.min(88, usableHalfW * 1.85) : Math.max(30, stepX - 2);
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

  function hiveMinimumHeight(clusterCount, width = 680) {
    if (clusterCount <= 1) return width < 420 ? 380 : 440;
    if (clusterCount === 2) return width < 420 ? 440 : 430;
    if (clusterCount <= 6) return 490;
    if (clusterCount <= 10) return width < 500 ? 640 : 540;
    if (clusterCount <= 12) return width < 500 ? 740 : 580;
    return width < 500 ? 820 : 680;
  }

  function outerHexAxialSlots(count, width) {
    const ring1 = [[-1, 0], [1, -1], [-1, 1], [1, 0], [0, -1], [0, 1]];
    const lateralRing2 = [[-2, 0], [2, -2], [-2, 1], [2, -1], [-2, 2], [2, 0]];
    const verticalRing2 = [[-1, -1], [1, -2], [-1, 2], [1, 1], [0, -2], [0, 2]];
    const axial = width < 500
      ? [...ring1, ...verticalRing2, ...lateralRing2]
      : [...ring1, ...lateralRing2, ...verticalRing2];
    for (let ring = 3; axial.length < count; ring++) {
      for (let q = -ring; q <= ring && axial.length < count; q++) {
        for (let r = -ring; r <= ring && axial.length < count; r++) {
          if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === ring) {
            axial.push([q, r]);
          }
        }
      }
    }
    return axial.slice(0, count).map(([q, r]) => ({ ux: q * (SQRT3 / 2), uy: r + q * 0.5 }));
  }

  function buildClusterLayoutCell(cl, cx, cy, radius) {
    const halfH = (SQRT3 / 2) * radius;
    const titleFontSize = radius < 65 ? 10.5 : 11.5;
    const subtitleFontSize = radius < 65 ? 10 : 11;
    const titleLineHeight = radius < 65 ? 11.5 : 13;
    const maxTitleChars = Math.max(8, Math.floor((1.36 * radius - 14) / (titleFontSize * 0.56)));
    const rawTitle = cl.fullTitle ?? cl.label ?? '';
    const wrapped = wrapHexTitle(rawTitle, maxTitleChars, 2);
    const titleLines = wrapped.lines.length ? wrapped.lines : [String(cl.label ?? '')];
    const headerTopPad = Math.max(7, halfH * 0.12);
    const titleY = cy - halfH + headerTopPad + titleLineHeight * 0.5;
    const lastTitleY = titleY + (titleLines.length - 1) * titleLineHeight;
    const subtitleGap = radius < 65 ? 11.5 : 13;
    const subtitleY = lastTitleY + subtitleGap;
    const subtitleBottom = subtitleY + subtitleFontSize * 0.55;
    const beeBoxTop = subtitleBottom + 4;
    const beeBoxBottom = cy + halfH - 5;
    const beeBoxHalfW = Math.max(16, radius - Math.max(Math.abs(beeBoxTop - cy), Math.abs(beeBoxBottom - cy)) / SQRT3 - 6);
    const beeBox = {
      x: cx - beeBoxHalfW,
      y: beeBoxTop,
      width: beeBoxHalfW * 2,
      height: Math.max(0, beeBoxBottom - beeBoxTop),
      top: beeBoxTop,
      bottom: beeBoxBottom,
      cx,
      cy: (beeBoxTop + beeBoxBottom) / 2,
    };
    const slots = computeClusterSlots(cx, cy, radius, cl.members ?? [], { topY: beeBoxTop, bottomY: beeBoxBottom });
    return {
      id: cl.id,
      label: cl.label,
      fullTitle: rawTitle,
      goal: cl.goal ?? '',
      mode: cl.mode ?? 'status',
      tone: cl.tone,
      count: cl.count,
      totalCount: cl.totalCount ?? cl.count,
      doneCount: cl.doneCount ?? 0,
      workingCount: cl.workingCount ?? 0,
      needsCount: cl.needsCount ?? 0,
      subtitle: cl.subtitle ?? String(cl.count ?? 0),
      x: cx,
      y: cy,
      radius,
      vertices: hexVertices(cx, cy, radius),
      titleLines,
      titleTruncated: wrapped.truncated,
      titleY,
      titleLineHeight,
      titleFontSize,
      subtitleY,
      subtitleFontSize,
      maxTitleChars,
      beeBox,
      slots,
    };
  }

  function buildCoordLayoutCell(coordModel, cx, cy, radius) {
    const halfH = (SQRT3 / 2) * radius;
    const coordScale = Math.max(1.1, Math.min(2.1, radius / 48));
    const beeW = 20 * coordScale;
    const beeH = 18 * coordScale;
    const coordBeeY = cy - halfH * 0.22;
    const titleFontSize = radius < 65 ? 11 : 12;
    const subtitleFontSize = radius < 65 ? 10 : 11;
    const titleLineHeight = radius < 65 ? 12 : 13.5;
    const titleY = cy + halfH * 0.35;
    const subtitleY = cy + halfH * 0.58;
    const subtitle = coordModel?.subtitle ?? `${coordModel?.doneCount ?? 0} of ${coordModel?.totalWorkers ?? 0} done`;
    const beeBox = {
      x: cx - beeW / 2,
      y: coordBeeY - beeH * 0.78,
      width: beeW,
      height: beeH,
      top: coordBeeY - beeH * 0.78,
      bottom: coordBeeY + beeH * 0.22,
      cx,
      cy: coordBeeY,
    };
    const member = coordModel ?? { name: 'coordinator', role: 'coordinator', status: 'waiting' };
    return {
      id: 'coordinator',
      label: 'Coordinator',
      fullTitle: 'Coordinator',
      subtitle,
      x: cx,
      y: cy,
      radius,
      vertices: hexVertices(cx, cy, radius),
      titleLines: ['Coordinator'],
      titleTruncated: false,
      titleY,
      titleLineHeight,
      titleFontSize,
      subtitleY,
      subtitleFontSize,
      beeBox,
      slots: [{ member, x: cx, y: coordBeeY, slotWidth: radius * 1.1, beeScale: coordScale }],
      model: coordModel,
    };
  }

  function layoutHive(hiveModel, width = 680, height = 460) {
    const clusters = hiveModel?.clusters ?? [];
    const legendH = 34;
    const topPad = 14;
    const sidePad = 16;
    const availW = Math.max(200, width - sidePad * 2);
    const availH = Math.max(220, height - topPad - legendH);

    let radius;
    const placed = [];

    if (clusters.length === 0) {
      radius = Math.max(40, Math.min(availW / 2.2, availH / (SQRT3 * 1.15), 114));
      placed.push({ isCoord: true, x: width / 2, y: topPad + availH / 2 });
    } else if (clusters.length === 1) {
      const gap = Math.max(12, Math.min(20, availH * 0.036));
      radius = Math.max(40, Math.min(availW / 2.15, (availH - gap) / (2 * SQRT3), 112));
      const D = SQRT3 * radius + gap;
      const centerX = width / 2;
      const centerY = topPad + availH / 2;
      placed.push({ cluster: clusters[0], x: centerX, y: centerY - D / 2 });
      placed.push({ isCoord: true, x: centerX, y: centerY + D / 2 });
    } else {
      const specs = [];
      if (clusters.length === 2) {
        specs.push({ isCoord: true, ux: 0, uy: 0.35 });
        if (availW >= availH * 0.85) {
          specs.push({ cluster: clusters[0], ux: -SQRT3 / 2, uy: -0.15 });
          specs.push({ cluster: clusters[1], ux: SQRT3 / 2, uy: -0.15 });
        } else {
          specs.push({ cluster: clusters[0], ux: 0, uy: -0.65 });
          specs.push({ cluster: clusters[1], ux: 0, uy: 1.35 });
        }
      } else if (clusters.length === 3) {
        specs.push({ isCoord: true, ux: 0, uy: 0 });
        specs.push({ cluster: clusters[0], ux: 0, uy: -1 });
        specs.push({ cluster: clusters[1], ux: -SQRT3 / 2, uy: 0.5 });
        specs.push({ cluster: clusters[2], ux: SQRT3 / 2, uy: 0.5 });
      } else {
        specs.push({ isCoord: true, ux: 0, uy: 0 });
        const axialCoords = outerHexAxialSlots(clusters.length, width);
        for (let i = 0; i < clusters.length; i++) {
          specs.push({ cluster: clusters[i], ux: axialCoords[i].ux, uy: axialCoords[i].uy });
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
      radius = Math.max(24, Math.min(maxRWidth, maxRHeight, 108));

      const D = SQRT3 * radius + gap;
      const midUX = (minUX + maxUX) / 2;
      const midUY = (minUY + maxUY) / 2;
      const originX = width / 2 - midUX * D;
      const originY = topPad + availH / 2 - midUY * D;
      for (const spec of specs) {
        placed.push({ ...spec, x: originX + spec.ux * D, y: originY + spec.uy * D });
      }
    }

    const cellsById = new Map();
    let coordCell = null;
    const clusterCells = [];

    for (const item of placed) {
      if (item.isCoord) {
        coordCell = buildCoordLayoutCell(hiveModel?.coordinator, item.x, item.y, radius);
        cellsById.set('coordinator', coordCell);
      } else {
        const cell = buildClusterLayoutCell(item.cluster, item.x, item.y, radius);
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

  function hexSignedDistance(px, py, cell) {
    const apothem = (SQRT3 / 2) * cell.radius;
    const dx = Math.abs(px - cell.x);
    const dy = Math.abs(py - cell.y);
    return Math.max(dy, 0.8660254037844386 * dx + 0.5 * dy) - apothem;
  }

  function rayExitFromPoint(cell, ox, oy, ux, uy) {
    if (Math.abs(ox - cell.x) < 1e-4 && Math.abs(oy - cell.y) < 1e-4) {
      return hexRayExit(cell, ux, uy);
    }
    const apothem = (SQRT3 / 2) * cell.radius;
    const rx = ox - cell.x;
    const ry = oy - cell.y;
    const axes = [
      [0, 1],
      [0.8660254037844386, 0.5],
      [0.8660254037844386, -0.5],
    ];
    let tEnter = -Infinity;
    let tExit = Infinity;
    for (const [ax, ay] of axes) {
      const p0 = rx * ax + ry * ay;
      const dv = ux * ax + uy * ay;
      if (Math.abs(dv) < 1e-6) {
        if (Math.abs(p0) > apothem) return hexRayExit(cell, ux, uy);
        continue;
      }
      const t1 = (-apothem - p0) / dv;
      const t2 = (apothem - p0) / dv;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit = Math.min(tExit, Math.max(t1, t2));
    }
    return tExit > 0 && tEnter <= tExit ? tExit : hexRayExit(cell, ux, uy);
  }

  function lookupLayoutCell(layout, id) {
    if (!layout || !id) return null;
    const fromMap = layout.cellsById?.get?.(id) ?? layout.cellsById?.[id];
    if (fromMap) return fromMap;
    if (id === 'coordinator') return layout.coordinator ?? null;
    return layout.clusters?.find(c => c.id === id) ?? null;
  }

  function routeSelfLoopConnector(cell, kind, layout) {
    const fmt = n => n.toFixed(1);
    let angle = kind === 'waiting' ? Math.PI / 6 : -Math.PI / 6;
    if (cell.x + cell.radius * 1.38 > (layout?.width ?? Infinity)) angle = Math.PI - angle;
    if (cell.y - cell.radius * 1.15 < 0 && Math.sin(angle) < 0) angle = -angle;

    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const tx = -ny;
    const ty = nx;
    const edgeDist = hexRayExit(cell, nx, ny) + 2;
    const anchor = { x: cell.x + nx * edgeDist, y: cell.y + ny * edgeDist };
    const span = Math.max(10, Math.min(16, cell.radius * 0.22));
    const depth = Math.max(24, Math.min(34, cell.radius * 0.45));
    const spread = span * 0.9;

    const start = { x: anchor.x - tx * (span * 0.45), y: anchor.y - ty * (span * 0.45) };
    const end = { x: anchor.x + tx * (span * 0.45), y: anchor.y + ty * (span * 0.45) };
    const c1 = { x: start.x + nx * depth - tx * spread, y: start.y + ny * depth - ty * spread };
    const c2 = { x: end.x + nx * depth + tx * spread, y: end.y + ny * depth + ty * spread };
    const mid = {
      x: 0.125 * (start.x + end.x) + 0.375 * (c1.x + c2.x),
      y: 0.125 * (start.y + end.y) + 0.375 * (c1.y + c2.y),
    };
    const endAngle = Math.atan2(end.y - c2.y, end.x - c2.x);
    return {
      path: `M${fmt(start.x)} ${fmt(start.y)} C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(end.x)} ${fmt(end.y)}`,
      start,
      end,
      mid,
      control: c1,
      control2: c2,
      arrow: { x: end.x, y: end.y, angle: endAngle },
      isSelfLoop: true,
      curved: true,
    };
  }

  function selectCurveControl(fromCell, toCell, coord, others, lateral, width, height) {
    const dx = toCell.x - fromCell.x;
    const dy = toCell.y - fromCell.y;
    const dist = Math.hypot(dx, dy);
    const nx = -dy / dist;
    const ny = dx / dist;
    const midChord = { x: (fromCell.x + toCell.x) / 2, y: (fromCell.y + toCell.y) / 2 };

    let prefSign = 1;
    if (coord && fromCell !== coord && toCell !== coord && Math.hypot(midChord.x - coord.x, midChord.y - coord.y) > 4) {
      prefSign = ((midChord.x - coord.x) * nx + (midChord.y - coord.y) * ny) >= 0 ? 1 : -1;
    }

    const coordRadius = coord?.radius ?? fromCell.radius;
    const isCenterLink = fromCell === coord || toCell === coord;
    const baseBend = isCenterLink
      ? Math.max(coordRadius * 1.45, dist * 0.48)
      : Math.max(coordRadius * 2.15, dist * 0.56);
    const mags = [baseBend, baseBend * 1.25, baseBend * 1.55, baseBend * 0.85, baseBend * 2.0];
    const p0 = { x: fromCell.x, y: fromCell.y };
    const p1 = { x: toCell.x, y: toCell.y };
    const stageW = width ?? Infinity;
    const stageH = height ?? Infinity;

    let bestCtrl = null;
    let bestScore = -Infinity;

    for (const mag of mags) {
      for (const sign of [prefSign, -prefSign]) {
        const offset = sign * mag + lateral * 0.7;
        const cand = { x: midChord.x + nx * offset, y: midChord.y + ny * offset };
        let minCoord = Infinity;
        let minOther = Infinity;
        let outOfBounds = 0;
        for (let step = 1; step <= 19; step++) {
          const pt = bezierPoint(p0, cand, p1, step / 20);
          if (hexSignedDistance(pt.x, pt.y, fromCell) <= 1 || hexSignedDistance(pt.x, pt.y, toCell) <= 1) continue;
          if (coord && !isCenterLink) minCoord = Math.min(minCoord, hexSignedDistance(pt.x, pt.y, coord));
          for (const obs of others) minOther = Math.min(minOther, hexSignedDistance(pt.x, pt.y, obs));
          if (pt.x < 6 || pt.x > stageW - 6 || pt.y < 6 || pt.y > stageH - 36) outOfBounds++;
        }
        if (minCoord >= 10 && minOther >= 2 && outOfBounds === 0) return cand;
        const score = (minCoord >= 8 ? minOther : minCoord - 1000) - outOfBounds * 40 - (sign !== prefSign ? 2 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestCtrl = cand;
        }
      }
    }
    return bestCtrl;
  }

  /**
   * Route a Hive connector between cells, curving outer-to-outer chords around the
   * center Coordinator (and intermediate hexes) and computing intra-hex self-loop arcs.
   */
  function routeHiveConnector(connector, layout) {
    const fromCell = lookupLayoutCell(layout, connector?.from);
    const toCell = lookupLayoutCell(layout, connector?.to);
    if (!fromCell || !toCell) return null;
    if (fromCell === toCell) return routeSelfLoopConnector(fromCell, connector.kind, layout);

    const fmt = n => n.toFixed(1);
    const dx = toCell.x - fromCell.x;
    const dy = toCell.y - fromCell.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return null;

    const ux = dx / dist;
    const uy = dy / dist;
    const nx = -uy;
    const ny = ux;
    const lateral = connector.kind === 'message' ? 8 : connector.kind === 'waiting' ? -8 : 0;
    const pad = lateral ? 4 : 2;

    const coord = layout?.coordinator ?? null;
    const allCells = [coord, ...(layout?.clusters ?? [])].filter(Boolean);
    const others = allCells.filter(c => c !== fromCell && c !== toCell);

    // Check if the straight shifted segment slices through or grazes the Coordinator or another hex.
    let needsCurve = false;
    if (others.length) {
      const sA = { x: fromCell.x + nx * lateral, y: fromCell.y + ny * lateral };
      const sB = { x: toCell.x + nx * lateral, y: toCell.y + ny * lateral };
      for (let step = 1; step < 12 && !needsCurve; step++) {
        const t = step / 12;
        const px = sA.x + (sB.x - sA.x) * t;
        const py = sA.y + (sB.y - sA.y) * t;
        if (coord && fromCell !== coord && toCell !== coord && hexSignedDistance(px, py, coord) < 10) needsCurve = true;
        else if (others.some(obs => hexSignedDistance(px, py, obs) < 4)) needsCurve = true;
      }
    }

    if (!needsCurve) {
      const oxA = fromCell.x + nx * lateral;
      const oyA = fromCell.y + ny * lateral;
      const oxB = toCell.x + nx * lateral;
      const oyB = toCell.y + ny * lateral;
      const exitA = rayExitFromPoint(fromCell, oxA, oyA, ux, uy) + pad;
      const exitB = rayExitFromPoint(toCell, oxB, oyB, -ux, -uy) + pad;
      const start = { x: oxA + ux * exitA, y: oyA + uy * exitA };
      const end = { x: oxB - ux * exitB, y: oyB - uy * exitB };
      if (Math.hypot(end.x - start.x, end.y - start.y) < 1) return null;
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      return {
        path: `M${fmt(start.x)} ${fmt(start.y)} L${fmt(end.x)} ${fmt(end.y)}`,
        start,
        end,
        mid,
        control: null,
        control2: null,
        arrow: { x: end.x, y: end.y, angle },
        isSelfLoop: false,
        curved: false,
      };
    }

    const p0 = { x: fromCell.x, y: fromCell.y };
    const p1 = { x: toCell.x, y: toCell.y };
    const chosenCtrl = selectCurveControl(fromCell, toCell, coord, others, lateral, layout?.width, layout?.height);

    // Clip quadratic Bezier cleanly at hex borders using binary search + Blossom control.
    let lo = 0;
    let hi = 0.45;
    for (let it = 0; it < 20; it++) {
      const m = (lo + hi) / 2;
      if (hexSignedDistance(bezierPoint(p0, chosenCtrl, p1, m).x, bezierPoint(p0, chosenCtrl, p1, m).y, fromCell) <= pad) lo = m;
      else hi = m;
    }
    const tStart = hi;

    lo = 0.55;
    hi = 1;
    for (let it = 0; it < 20; it++) {
      const m = (lo + hi) / 2;
      if (hexSignedDistance(bezierPoint(p0, chosenCtrl, p1, m).x, bezierPoint(p0, chosenCtrl, p1, m).y, toCell) <= pad) hi = m;
      else lo = m;
    }
    const tEnd = lo;
    if (tEnd <= tStart + 1e-4) return null;

    const start = bezierPoint(p0, chosenCtrl, p1, tStart);
    const end = bezierPoint(p0, chosenCtrl, p1, tEnd);
    const control = blossomControl(p0, chosenCtrl, p1, tStart, tEnd);
    const mid = bezierPoint(start, control, end, 0.5);
    const endAngle = Math.atan2(end.y - control.y, end.x - control.x);

    return {
      path: `M${fmt(start.x)} ${fmt(start.y)} Q${fmt(control.x)} ${fmt(control.y)} ${fmt(end.x)} ${fmt(end.y)}`,
      start,
      end,
      mid,
      control,
      control2: null,
      arrow: { x: end.x, y: end.y, angle: endAngle },
      isSelfLoop: false,
      curved: true,
    };
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
        messageStroke: '#c297ff',
        accent: '#f0b84b',
        doneFill: '#18281c',
        doneStroke: '#5ec26a',
        doneConnector: '#5ec26a',
        workingFill: '#172336',
        workingStroke: '#63a4ff',
        waitingFill: '#292113',
        waitingStroke: '#e8ad44',
        waitingConnector: '#e8ad44',
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
      messageStroke: '#8250df',
      accent: '#bf8700',
      doneFill: '#edf7ed',
      doneStroke: '#4d9938',
      doneConnector: '#4d9938',
      workingFill: '#edf4fc',
      workingStroke: '#2268b8',
      waitingFill: '#fdf6e7',
      waitingStroke: '#d18d22',
      waitingConnector: '#d18d22',
      needsFill: '#fdf0ef',
      needsStroke: '#cf483f',
    };
  }

  function toneStyle(tone, palette = themePalette('light')) {
    if (tone === 'done') return { fill: palette.doneFill, stroke: palette.doneStroke };
    if (tone === 'working' || tone === 'active') return { fill: palette.workingFill, stroke: palette.workingStroke };
    if (tone === 'needs' || tone === 'stalled' || tone === 'blocked') return { fill: palette.needsFill, stroke: palette.needsStroke };
    return { fill: palette.waitingFill, stroke: palette.waitingStroke };
  }

  function statusDotColor(status, palette) {
    if (status === 'working') return palette.workingStroke;
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

  function renderHiveFrame(ctx, opts = {}, paletteArg, beesArg) {
    const {
      posts = [], members = [], cursor = null, threads = null, channels = null,
      phase, width = 680, height = 460, focus = null, theme = 'light',
    } = opts;
    const palette = paletteArg ?? themePalette(theme === 'dark' ? 'dark' : 'light');
    const beesLib = resolveBees(beesArg ?? opts.bees);
    const hiveModel = projectHive(posts, members, cursor, { threads, channels });
    if (phase && (cursor === null || cursor === undefined)) {
      if (phase === 'done' && hiveModel.coordinator.totalWorkers > 0 && hiveModel.coordinator.doneCount === hiveModel.coordinator.totalWorkers) {
        hiveModel.coordinator.phase = 'done';
      } else if (phase === 'stalled' || phase === 'budget') {
        hiveModel.coordinator.phase = 'stalled';
      }
    }
    const hiveLayout = layoutHive(hiveModel, width, height);

    // Draw connectors between hex borders using shared curved/self-loop routing.
    for (const conn of hiveModel.connectors) {
      const route = routeHiveConnector(conn, hiveLayout);
      if (!route) continue;
      const stroke = conn.kind === 'message' ? (palette.messageStroke ?? palette.pulse)
        : conn.kind === 'waiting' ? (palette.waitingConnector ?? palette.waitingStroke)
          : (palette.doneConnector ?? palette.doneStroke);
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = conn.kind === 'message' ? 2.2 : 1.6;
      ctx.setLineDash?.(conn.kind === 'waiting' ? [4, 4] : []);

      ctx.beginPath();
      ctx.moveTo(route.start.x, route.start.y);
      if (route.control2) {
        if (typeof ctx.bezierCurveTo === 'function') {
          ctx.bezierCurveTo(route.control.x, route.control.y, route.control2.x, route.control2.y, route.end.x, route.end.y);
        } else {
          ctx.quadraticCurveTo(route.mid.x, route.mid.y, route.end.x, route.end.y);
        }
      } else if (route.control) {
        ctx.quadraticCurveTo(route.control.x, route.control.y, route.end.x, route.end.y);
      } else {
        ctx.lineTo(route.end.x, route.end.y);
      }
      ctx.stroke();
      ctx.setLineDash?.([]);

      if (conn.kind !== 'done' && route.arrow) {
        drawArrowHead(ctx, route.arrow.x, route.arrow.y, route.arrow.angle, 7);
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw state/group cluster hexagons.
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

      ctx.fillStyle = palette.ink;
      ctx.font = `600 ${cluster.titleFontSize}px "Segoe UI", system-ui, sans-serif`;
      const lines = cluster.titleLines?.length ? cluster.titleLines : [cluster.label];
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], cluster.x, cluster.titleY + i * cluster.titleLineHeight);
      }
      ctx.fillStyle = palette.muted;
      ctx.font = `500 ${cluster.subtitleFontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(String(cluster.subtitle ?? cluster.count), cluster.x, cluster.subtitleY);

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
        ctx.font = '500 9.5px "Segoe UI", system-ui, sans-serif';
        const maxChars = Math.max(6, Math.floor(slot.slotWidth / 4.6));
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

      const coordSlot = coord.slots?.[0];
      const coordScale = coordSlot?.beeScale ?? Math.max(1.1, Math.min(2.1, coord.radius / 48));
      const cBeeW = 20 * coordScale;
      const cBeeH = 18 * coordScale;
      const beeX = (coordSlot?.x ?? coord.x) - cBeeW / 2;
      const beeY = (coordSlot?.y ?? coord.y) - cBeeH * 0.56;
      drawBeeOnCtx(ctx, beeX, beeY, 'coordinator', {
        status: coord.model?.status ?? 'waiting',
        coordinator: true,
        tint: coord.model?.tint,
        muted: false,
        scale: coordScale,
      }, beesLib);

      ctx.fillStyle = palette.ink;
      ctx.font = `650 ${coord.titleFontSize ?? 12}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText('Coordinator', coord.x, coord.titleY);
      ctx.fillStyle = palette.muted;
      ctx.font = `500 ${coord.subtitleFontSize ?? 11}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(coord.subtitle ?? `${coord.model?.doneCount ?? 0} of ${coord.model?.totalWorkers ?? 0} done`, coord.x, coord.subtitleY);
    }

    // Bottom legend.
    ctx.globalAlpha = 1;
    const ly = height - 16;
    let lx = 24;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '500 11px "Segoe UI", system-ui, sans-serif';

    ctx.strokeStyle = palette.doneConnector ?? palette.doneStroke;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.fillStyle = palette.muted;
    ctx.fillText('Tasks done', lx + 22, ly);
    lx += 102;

    ctx.strokeStyle = palette.messageStroke ?? palette.pulse;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.fillText('Message just sent', lx + 22, ly);
    lx += 136;

    const waitColor = palette.waitingConnector ?? palette.waitingStroke;
    ctx.strokeStyle = waitColor;
    ctx.fillStyle = waitColor;
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
    isPost, shouldMergeUserToCoordinator, project, elapsedSpan, unmentionedNode, minimumHeight, layout,
    nodeBox, roundedRectSignedDistance, clipEdge, routeEdges, draw,
    smartTaskLabel, mentionsMinimumHeight, layoutMentions,
    projectHive, hiveMinimumHeight, layoutHive, renderHiveFrame, renderGraphFrame,
    hexRayExit, wrapHexTitle, routeHiveConnector, themePalette, toneStyle,
  });
})();
