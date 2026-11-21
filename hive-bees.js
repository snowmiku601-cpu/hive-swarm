(() => {
  'use strict';
  const palette = [
    ['#efac37', '#ffe18d', '#bb641d'],
    ['#75baef', '#cdefff', '#3974bb'],
    ['#55cbb2', '#b8f8df', '#268c7d'],
    ['#e68db3', '#ffcee2', '#a24275'],
    ['#b3ce64', '#e9f6a1', '#6c9137'],
    ['#ad9ce8', '#e3d4ff', '#6d58af'],
    ['#f09a71', '#ffd3b7', '#af5833'],
    ['#95cbd1', '#defbfa', '#4a8d9d'],
    ['#d1a76a', '#ffe2a9', '#987044'],
  ];

  const mutedPalette = ['#aaafb6', '#d6dae0', '#848991'];

  function colors(name, coordinator, tint) {
    if (coordinator) return palette[0];
    if (Number.isInteger(tint)) return palette[1 + (Math.abs(tint) % (palette.length - 1))];
    const hash = [...String(name ?? '')].reduce((sum, letter) => sum * 31 + letter.charCodeAt(0), 0) >>> 0;
    return palette[hash % palette.length];
  }

  function hexRgb(hex) {
    const clean = String(hex).replace('#', '');
    const value = Number.parseInt(clean, 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  function tintStyle(name, coordinator, tint) {
    const [base, highlight, shade] = colors(name, coordinator, tint);
    const [r, g, b] = hexRgb(base);
    const [sr, sg, sb] = hexRgb(shade);
    const tr = Math.round(sr * 0.78);
    const tg = Math.round(sg * 0.78);
    const tb = Math.round(sb * 0.78);
    const text = '#' + [tr, tg, tb].map(c => c.toString(16).padStart(2, '0')).join('');
    return {
      base,
      highlight,
      shade,
      bg: `rgba(${r}, ${g}, ${b}, 0.14)`,
      border: `rgba(${r}, ${g}, ${b}, 0.42)`,
      text,
    };
  }

  function paintRects(ctx, color, rects, ox = 0, oy = 0, scale = 1) {
    ctx.fillStyle = color;
    for (const [rx, ry, rw, rh] of rects) {
      if (ox === 0 && oy === 0 && scale === 1) ctx.fillRect(rx, ry, rw, rh);
      else ctx.fillRect(ox + rx * scale, oy + ry * scale, rw * scale, rh * scale);
    }
  }

  function drawSprite(ctx, x, y, name, { status = 'working', coordinator = false, tint, muted = false, scale = 1 } = {}) {
    if (!ctx) return;
    const [base, highlight, shade] = muted ? mutedPalette : colors(name, coordinator, tint);
    const asleep = !muted && ['waiting', 'quota', 'retired', 'done'].includes(status);

    const outline = muted ? '#727880' : '#201915';
    const wingRim = muted ? '#828a94' : '#24313d';
    const wingFill = muted ? '#ced3d9' : '#a9c6db';
    const wingLight = muted ? '#eef1f4' : '#e7f2fa';
    const stripe = muted ? '#767c84' : '#2c221c';

    paintRects(ctx, outline, [[3, 2, 1, 3], [6, 3, 1, 2], [5, 1, 2, 1], [2, 3, 1, 1], [5, 5, 10, 8], [3, 7, 13, 5],
      [4, 12, 11, 2], [6, 14, 7, 1], [16, 9, 2, 2], [7, 14, 1, 2], [12, 14, 1, 2]], x, y, scale);
    paintRects(ctx, wingRim, [[7, 3, 6, 4], [8, 2, 4, 6], [12, 3, 4, 4], [13, 2, 2, 1]], x, y, scale);
    paintRects(ctx, wingFill, [[8, 3, 3, 4], [12, 4, 3, 2], [9, 7, 2, 1]], x, y, scale);
    paintRects(ctx, wingLight, [[9, 3, 2, 2], [12, 4, 2, 1], [8, 4, 1, 2]], x, y, scale);
    paintRects(ctx, base, [[4, 7, 8, 5], [5, 6, 6, 7], [12, 7, 3, 5], [13, 12, 1, 1], [6, 13, 1, 1]], x, y, scale);
    paintRects(ctx, highlight, [[5, 7, 3, 1], [4, 9, 2, 2], [10, 7, 2, 1], [13, 8, 1, 2], [5, 12, 2, 1]], x, y, scale);
    paintRects(ctx, shade, [[6, 12, 7, 1], [12, 11, 3, 1], [13, 12, 1, 1]], x, y, scale);
    paintRects(ctx, stripe, [[8, 6, 2, 7], [12, 7, 1, 6], [15, 9, 2, 1]], x, y, scale);

    if (asleep) {
      paintRects(ctx, outline, [[4, 10, 2, 1]], x, y, scale);
      paintRects(ctx, '#d7dcff', coordinator
        ? [[0, 0, 2, 1], [1, 1, 1, 1], [0, 2, 2, 1], [15, 0, 4, 1], [17, 1, 1, 2], [15, 3, 4, 1]]
        : [[1, 1, 3, 1], [2, 2, 1, 1], [1, 3, 3, 1], [15, 0, 4, 1], [17, 1, 1, 2], [15, 3, 4, 1]], x, y, scale);
    } else {
      paintRects(ctx, muted ? '#555b63' : '#201915', [[5, 8, 1, 2]], x, y, scale);
      paintRects(ctx, muted ? '#e5e8ec' : '#fff6d7', [[5, 8, 1, 1]], x, y, scale);
    }

    if (coordinator) {
      paintRects(ctx, muted ? '#727880' : '#6d4219', [[2, 1, 1, 4], [8, 1, 1, 4], [2, 4, 7, 1]], x, y, scale);
      paintRects(ctx, muted ? '#c7cbd1' : '#ffd86b', [[2, 0, 1, 2], [5, 0, 1, 3], [8, 0, 1, 2], [3, 2, 5, 2], [4, 1, 3, 1]], x, y, scale);
      paintRects(ctx, muted ? '#9da3ab' : '#e7a52f', [[3, 4, 5, 1], [3, 3, 5, 1]], x, y, scale);
      paintRects(ctx, muted ? '#eceef1' : '#fff3bf', [[3, 2, 1, 1], [7, 2, 1, 1], [5, 3, 1, 1]], x, y, scale);
    }
  }

  function sprite(name, { status = 'working', coordinator = false, tint, muted = false } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bee-pixel';
    canvas.width = 20;
    canvas.height = 18;
    canvas.setAttribute('aria-hidden', 'true');
    const asleep = !muted && ['waiting', 'quota', 'retired', 'done'].includes(status);
    canvas.dataset.pose = muted ? 'muted' : (asleep ? 'sleeping' : 'awake');
    if (muted) canvas.dataset.muted = 'true';
    const ctx = canvas.getContext('2d');
    drawSprite(ctx, 0, 0, name, { status, coordinator, tint, muted, scale: 1 });
    return canvas;
  }

  globalThis.HiveBee = Object.freeze({ sprite, colors, tintStyle, drawSprite });
})();
