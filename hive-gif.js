(() => {
  'use strict';

  function resolveGraph(explicit) {
    if (explicit) return explicit;
    if (typeof window !== 'undefined' && window.HiveGraph) return window.HiveGraph;
    return globalThis.HiveGraph;
  }

  function resolveBees(explicit) {
    if (explicit) return explicit;
    if (typeof window !== 'undefined' && window.HiveBee) return window.HiveBee;
    return globalThis.HiveBee;
  }

  function buildPalette(frames, maxColors = 128) {
    const limit = Math.max(2, Math.min(256, maxColors | 0));
    const counts = new Map();
    const sampleCount = Math.min(frames.length, 16);
    const step = frames.length <= sampleCount ? 1 : (frames.length - 1) / (sampleCount - 1);
    const sampledIndices = new Set();
    for (let i = 0; i < sampleCount; i++) sampledIndices.add(Math.round(i * step));
    sampledIndices.add(0);
    sampledIndices.add(frames.length - 1);

    const first = frames[0].rgba;
    const bgRgb = first.length >= 4 && first[3] >= 128
      ? ((first[0] << 16) | (first[1] << 8) | first[2])
      : 0xFFFFFF;

    for (const idx of sampledIndices) {
      const rgba = frames[idx].rgba;
      let lastRgb = -1;
      let run = 0;
      for (let p = 0; p + 3 < rgba.length; p += 4) {
        const rgb = rgba[p + 3] < 128
          ? bgRgb
          : ((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
        if (rgb === lastRgb) {
          run++;
        } else {
          if (lastRgb !== -1) counts.set(lastRgb, (counts.get(lastRgb) ?? 0) + run);
          lastRgb = rgb;
          run = 1;
        }
      }
      if (lastRgb !== -1) counts.set(lastRgb, (counts.get(lastRgb) ?? 0) + run);
    }

    let paletteColors;
    if (counts.size <= limit) {
      paletteColors = [...counts.keys()];
    } else {
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const preserveCount = Math.min(sorted.length, Math.max(2, Math.floor(limit * 0.48)));
      paletteColors = sorted.slice(0, preserveCount).map(entry => entry[0]);
      const preservedSet = new Set(paletteColors);

      // Bucket remaining colors into 5-bit RGB space for fast weighted median-cut.
      const bucketWeights = new Map();
      for (let i = preserveCount; i < sorted.length; i++) {
        const [rgb, weight] = sorted[i];
        const r5 = (rgb >> 19) & 31;
        const g5 = (rgb >> 11) & 31;
        const b5 = (rgb >> 3) & 31;
        const key5 = (r5 << 10) | (g5 << 5) | b5;
        let entry = bucketWeights.get(key5);
        if (!entry) {
          entry = { rSum: 0, gSum: 0, bSum: 0, w: 0 };
          bucketWeights.set(key5, entry);
        }
        entry.rSum += ((rgb >> 16) & 255) * weight;
        entry.gSum += ((rgb >> 8) & 255) * weight;
        entry.bSum += (rgb & 255) * weight;
        entry.w += weight;
      }

      const items = [];
      for (const entry of bucketWeights.values()) {
        items.push({
          r: Math.round(entry.rSum / entry.w),
          g: Math.round(entry.gSum / entry.w),
          b: Math.round(entry.bSum / entry.w),
          w: entry.w,
        });
      }

      const remainingSlots = limit - paletteColors.length;
      if (items.length <= remainingSlots) {
        for (const item of items) {
          const rgb = (item.r << 16) | (item.g << 8) | item.b;
          if (!preservedSet.has(rgb)) {
            preservedSet.add(rgb);
            paletteColors.push(rgb);
          }
        }
      } else {
        const makeBox = list => {
          let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0, totalW = 0;
          for (const it of list) {
            if (it.r < rMin) rMin = it.r;
            if (it.r > rMax) rMax = it.r;
            if (it.g < gMin) gMin = it.g;
            if (it.g > gMax) gMax = it.g;
            if (it.b < bMin) bMin = it.b;
            if (it.b > bMax) bMax = it.b;
            totalW += it.w;
          }
          const spanR = rMax - rMin;
          const spanG = gMax - gMin;
          const spanB = bMax - bMin;
          const axis = spanG >= spanR && spanG >= spanB ? 'g' : (spanR >= spanB ? 'r' : 'b');
          return { list, span: Math.max(spanR, spanG, spanB), axis, totalW };
        };

        const boxes = [makeBox(items)];
        while (boxes.length < remainingSlots) {
          let bestIdx = -1;
          let bestScore = -1;
          for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (box.list.length > 1 && box.span > 0) {
              const score = box.span * Math.log2(box.totalW + 2);
              if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
              }
            }
          }
          if (bestIdx === -1) break;
          const chosen = boxes.splice(bestIdx, 1)[0];
          const axis = chosen.axis;
          chosen.list.sort((a, b) => a[axis] - b[axis]);
          let half = chosen.totalW / 2;
          let acc = 0;
          let split = 1;
          for (let i = 0; i < chosen.list.length - 1; i++) {
            acc += chosen.list[i].w;
            if (acc >= half) {
              split = i + 1;
              break;
            }
          }
          boxes.push(makeBox(chosen.list.slice(0, split)), makeBox(chosen.list.slice(split)));
        }

        for (const box of boxes) {
          let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
          for (const it of box.list) {
            rSum += it.r * it.w;
            gSum += it.g * it.w;
            bSum += it.b * it.w;
            wSum += it.w;
          }
          const r = Math.round(rSum / wSum);
          const g = Math.round(gSum / wSum);
          const b = Math.round(bSum / wSum);
          const rgb = (r << 16) | (g << 8) | b;
          if (!preservedSet.has(rgb)) {
            preservedSet.add(rgb);
            paletteColors.push(rgb);
          }
        }
      }
    }

    if (!paletteColors.length) paletteColors = [0xFFFFFF];
    let bits = 1;
    while ((1 << bits) < paletteColors.length && bits < 8) bits++;
    const tableLength = 1 << bits;
    const minCodeSize = Math.max(2, bits);
    const tableSizeFlag = bits - 1;

    const paletteR = new Uint8Array(paletteColors.length);
    const paletteG = new Uint8Array(paletteColors.length);
    const paletteB = new Uint8Array(paletteColors.length);
    const exactLookup = new Map();
    for (let i = 0; i < paletteColors.length; i++) {
      const rgb = paletteColors[i];
      paletteR[i] = (rgb >> 16) & 255;
      paletteG[i] = (rgb >> 8) & 255;
      paletteB[i] = rgb & 255;
      exactLookup.set(rgb, i);
    }

    return {
      colors: paletteColors,
      paletteR,
      paletteG,
      paletteB,
      tableLength,
      minCodeSize,
      tableSizeFlag,
      bgRgb,
      exactLookup,
    };
  }

  function mapPixels(rgba, pixelCount, palette) {
    const { paletteR, paletteG, paletteB, bgRgb, exactLookup } = palette;
    const len = paletteR.length;
    const indices = new Uint8Array(pixelCount);
    let lastRgb = -1;
    let lastIndex = 0;

    for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
      const rgb = rgba[p + 3] < 128
        ? bgRgb
        : ((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]);
      if (rgb === lastRgb) {
        indices[i] = lastIndex;
        continue;
      }
      let idx = exactLookup.get(rgb);
      if (idx === undefined) {
        const r = (rgb >> 16) & 255;
        const g = (rgb >> 8) & 255;
        const b = rgb & 255;
        let bestDist = Infinity;
        idx = 0;
        for (let k = 0; k < len; k++) {
          const dr = r - paletteR[k];
          const dg = g - paletteG[k];
          const db = b - paletteB[k];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestDist) {
            bestDist = dist;
            idx = k;
            if (dist === 0) break;
          }
        }
        if (exactLookup.size < 65536) exactLookup.set(rgb, idx);
      }
      lastRgb = rgb;
      lastIndex = idx;
      indices[i] = idx;
    }
    return indices;
  }

  class ByteWriter {
    constructor(initialCapacity = 32768) {
      this.buf = new Uint8Array(initialCapacity);
      this.pos = 0;
    }
    ensure(extra) {
      if (this.pos + extra <= this.buf.length) return;
      let nextLen = this.buf.length * 2;
      while (nextLen < this.pos + extra) nextLen *= 2;
      const next = new Uint8Array(nextLen);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }
    byte(value) {
      this.ensure(1);
      this.buf[this.pos++] = value & 0xFF;
    }
    u16(value) {
      this.ensure(2);
      this.buf[this.pos++] = value & 0xFF;
      this.buf[this.pos++] = (value >> 8) & 0xFF;
    }
    bytes(arr) {
      this.ensure(arr.length);
      this.buf.set(arr, this.pos);
      this.pos += arr.length;
    }
    ascii(str) {
      this.ensure(str.length);
      for (let i = 0; i < str.length; i++) this.buf[this.pos++] = str.charCodeAt(i);
    }
    finish() {
      return this.buf.slice(0, this.pos);
    }
  }

  function lzwEncode(indices, minCodeSize, writer) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    const HASH_SIZE = 8192;
    const HASH_MASK = HASH_SIZE - 1;
    const htab = new Int32Array(HASH_SIZE).fill(-1);
    const codetab = new Int16Array(HASH_SIZE);
    const subBlock = new Uint8Array(255);
    let subLen = 0;
    let curAccum = 0;
    let curBits = 0;

    function flushSubBlock() {
      if (!subLen) return;
      writer.byte(subLen);
      writer.bytes(subBlock.subarray(0, subLen));
      subLen = 0;
    }

    function outputCode(code, codeSize) {
      curAccum |= code << curBits;
      curBits += codeSize;
      while (curBits >= 8) {
        subBlock[subLen++] = curAccum & 0xFF;
        if (subLen === 255) flushSubBlock();
        curAccum >>>= 8;
        curBits -= 8;
      }
    }

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let maxCode = 1 << codeSize;

    outputCode(clearCode, codeSize);
    if (!indices.length) {
      outputCode(eoiCode, codeSize);
      if (curBits > 0) subBlock[subLen++] = curAccum & 0xFF;
      flushSubBlock();
      writer.byte(0);
      return;
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      let hash = ((prefix << 5) ^ k ^ (prefix >>> 3)) & HASH_MASK;
      // Odd step guarantees full-period probing over power-of-2 HASH_SIZE (8192).
      const step = ((prefix ^ (k << 3)) | 1) & HASH_MASK;
      let found = false;
      while (htab[hash] !== -1) {
        if (htab[hash] === key) {
          prefix = codetab[hash];
          found = true;
          break;
        }
        hash = (hash + step) & HASH_MASK;
      }
      if (found) continue;

      outputCode(prefix, codeSize);
      if (nextCode < 4096) {
        htab[hash] = key;
        codetab[hash] = nextCode++;
        if (nextCode > maxCode && codeSize < 12) {
          codeSize++;
          maxCode = 1 << codeSize;
        }
      } else {
        outputCode(clearCode, codeSize);
        htab.fill(-1);
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
        maxCode = 1 << codeSize;
      }
      prefix = k;
    }

    outputCode(prefix, codeSize);
    outputCode(eoiCode, codeSize);
    if (curBits > 0) {
      subBlock[subLen++] = curAccum & 0xFF;
      if (subLen === 255) flushSubBlock();
    }
    flushSubBlock();
    writer.byte(0);
  }

  function encodeGif(frames, { width, height, loop = 0, maxColors = 128 } = {}) {
    if (!Array.isArray(frames) || !frames.length) {
      throw new Error('encodeGif requires at least one frame.');
    }
    const w = Math.floor(Number(width));
    const h = Math.floor(Number(height));
    if (!Number.isFinite(w) || w <= 0 || w > 65535 || !Number.isFinite(h) || h <= 0 || h > 65535) {
      throw new Error('encodeGif requires valid width and height (1..65535).');
    }
    const pixelCount = w * h;
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i]?.rgba || frames[i].rgba.length < pixelCount * 4) {
        throw new Error(`Frame ${i} RGBA buffer is smaller than ${w}x${h}x4 bytes.`);
      }
    }

    const palette = buildPalette(frames, maxColors);
    const writer = new ByteWriter(Math.max(16384, pixelCount));

    // GIF89a header + Logical Screen Descriptor.
    writer.ascii('GIF89a');
    writer.u16(w);
    writer.u16(h);
    writer.byte(0x80 | (0x07 << 4) | palette.tableSizeFlag);
    writer.byte(0);
    writer.byte(0);

    // Global Color Table.
    for (let i = 0; i < palette.tableLength; i++) {
      if (i < palette.colors.length) {
        writer.byte(palette.paletteR[i]);
        writer.byte(palette.paletteG[i]);
        writer.byte(palette.paletteB[i]);
      } else {
        writer.byte(0);
        writer.byte(0);
        writer.byte(0);
      }
    }

    // NETSCAPE2.0 looping application extension.
    if (loop !== false && loop !== null && loop !== undefined) {
      const loopCount = Math.max(0, Math.min(65535, Math.floor(Number(loop))));
      writer.byte(0x21);
      writer.byte(0xFF);
      writer.byte(0x0B);
      writer.ascii('NETSCAPE2.0');
      writer.byte(0x03);
      writer.byte(0x01);
      writer.u16(loopCount);
      writer.byte(0x00);
    }

    for (const frame of frames) {
      const delayCs = Math.max(1, Math.min(65535, Math.round(frame.delayCs ?? 50)));
      // Graphic Control Extension.
      writer.byte(0x21);
      writer.byte(0xF9);
      writer.byte(0x04);
      writer.byte(0x04); // Disposal method 1 (do not dispose)
      writer.u16(delayCs);
      writer.byte(0x00);
      writer.byte(0x00);

      // Image Descriptor.
      writer.byte(0x2C);
      writer.u16(0);
      writer.u16(0);
      writer.u16(w);
      writer.u16(h);
      writer.byte(0x00);

      // LZW compressed pixel indices.
      writer.byte(palette.minCodeSize);
      const indices = mapPixels(frame.rgba, pixelCount, palette);
      lzwEncode(indices, palette.minCodeSize, writer);
    }

    writer.byte(0x3B);
    return writer.finish();
  }

  function parseCssColor(color) {
    const str = String(color ?? '').trim();
    if (str.startsWith('#')) {
      const hex = str.slice(1);
      if (hex.length === 3) {
        return [
          Number.parseInt(hex[0] + hex[0], 16),
          Number.parseInt(hex[1] + hex[1], 16),
          Number.parseInt(hex[2] + hex[2], 16),
          255,
        ];
      }
      if (hex.length >= 6) {
        return [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
          hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
        ];
      }
    }
    const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(str);
    if (rgbMatch) {
      const parts = rgbMatch[1].split(',').map(s => Number.parseFloat(s.trim()));
      return [
        parts[0] || 0,
        parts[1] || 0,
        parts[2] || 0,
        parts.length >= 4 ? Math.round(parts[3] * 255) : 255,
      ];
    }
    return [0, 0, 0, 255];
  }

  // Minimal software 2D canvas fallback for Node environments without DOM canvas.
  function createSoftwareCanvas(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    const stack = [];
    let state = { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1, lineDash: [], textAlign: 'left', textBaseline: 'alphabetic' };
    let path = [];
    let curX = 0, curY = 0, startX = 0, startY = 0;

    function blendPixel(px, py, rgba) {
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || ix >= width || iy < 0 || iy >= height) return;
      const alpha = (rgba[3] / 255) * state.globalAlpha;
      if (alpha <= 0) return;
      const off = (iy * width + ix) * 4;
      if (alpha >= 0.995) {
        data[off] = rgba[0]; data[off + 1] = rgba[1]; data[off + 2] = rgba[2]; data[off + 3] = 255;
      } else {
        const inv = 1 - alpha;
        data[off] = Math.round(data[off] * inv + rgba[0] * alpha);
        data[off + 1] = Math.round(data[off + 1] * inv + rgba[1] * alpha);
        data[off + 2] = Math.round(data[off + 2] * inv + rgba[2] * alpha);
        data[off + 3] = 255;
      }
    }

    function drawSeg(x0, y0, x1, y1, rgba, lw, dashState) {
      const segLen = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(segLen));
      const rad = Math.max(0, Math.floor((lw - 1) / 2));
      const dash = state.lineDash;
      const period = dash.length >= 2 ? (dash[0] + dash[1]) : 0;
      for (let i = 0; i <= steps; i++) {
        const distAt = dashState.acc + (segLen * i) / steps;
        if (period > 0 && (distAt % period) >= dash[0]) continue;
        const x = x0 + ((x1 - x0) * i) / steps;
        const y = y0 + ((y1 - y0) * i) / steps;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) blendPixel(x + dx, y + dy, rgba);
        }
      }
      dashState.acc += segLen;
    }

    const ctx = {
      get fillStyle() { return state.fillStyle; },
      set fillStyle(v) { state.fillStyle = v; },
      get strokeStyle() { return state.strokeStyle; },
      set strokeStyle(v) { state.strokeStyle = v; },
      get lineWidth() { return state.lineWidth; },
      set lineWidth(v) { state.lineWidth = v; },
      get globalAlpha() { return state.globalAlpha; },
      set globalAlpha(v) { state.globalAlpha = v; },
      font: '',
      get textAlign() { return state.textAlign; },
      set textAlign(v) { state.textAlign = v; },
      get textBaseline() { return state.textBaseline; },
      set textBaseline(v) { state.textBaseline = v; },
      lineCap: 'butt',
      save() { stack.push({ ...state, lineDash: [...state.lineDash] }); },
      restore() { if (stack.length) state = stack.pop(); },
      setLineDash(arr) { state.lineDash = Array.isArray(arr) ? arr.filter(n => n > 0) : []; },
      clearRect(x, y, w, h) {
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(width, Math.ceil(x + w)), y1 = Math.min(height, Math.ceil(y + h));
        for (let iy = y0; iy < y1; iy++) {
          for (let ix = x0; ix < x1; ix++) {
            const off = (iy * width + ix) * 4;
            data[off] = data[off + 1] = data[off + 2] = data[off + 3] = 0;
          }
        }
      },
      fillRect(x, y, w, h) {
        const rgba = parseCssColor(state.fillStyle);
        const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
        const x1 = Math.min(width, Math.ceil(x + w)), y1 = Math.min(height, Math.ceil(y + h));
        for (let iy = y0; iy < y1; iy++) {
          for (let ix = x0; ix < x1; ix++) blendPixel(ix, iy, rgba);
        }
      },
      beginPath() { path = []; },
      moveTo(x, y) { curX = startX = x; curY = startY = y; path.push([{ x, y }]); },
      lineTo(x, y) {
        if (!path.length) path.push([{ x: curX, y: curY }]);
        path[path.length - 1].push({ x, y });
        curX = x; curY = y;
      },
      quadraticCurveTo(cx, cy, x, y) {
        if (!path.length) path.push([{ x: curX, y: curY }]);
        const sub = path[path.length - 1];
        const x0 = curX, y0 = curY;
        for (let s = 1; s <= 12; s++) {
          const t = s / 12, u = 1 - t;
          sub.push({ x: u * u * x0 + 2 * u * t * cx + t * t * x, y: u * u * y0 + 2 * u * t * cy + t * t * y });
        }
        curX = x; curY = y;
      },
      bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
        if (!path.length) path.push([{ x: curX, y: curY }]);
        const sub = path[path.length - 1];
        const x0 = curX, y0 = curY;
        for (let s = 1; s <= 16; s++) {
          const t = s / 16, u = 1 - t;
          const u2 = u * u, t2 = t * t;
          sub.push({
            x: u2 * u * x0 + 3 * u2 * t * c1x + 3 * u * t2 * c2x + t2 * t * x,
            y: u2 * u * y0 + 3 * u2 * t * c1y + 3 * u * t2 * c2y + t2 * t * y,
          });
        }
        curX = x; curY = y;
      },
      arc(cx, cy, r, a0, a1) {
        const sub = [];
        const steps = 18;
        for (let s = 0; s <= steps; s++) {
          const a = a0 + ((a1 - a0) * s) / steps;
          sub.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
        path.push(sub);
        if (sub.length) { curX = sub.at(-1).x; curY = sub.at(-1).y; startX = sub[0].x; startY = sub[0].y; }
      },
      closePath() {
        if (path.length && path[path.length - 1].length) {
          path[path.length - 1].push({ x: startX, y: startY });
          curX = startX; curY = startY;
        }
      },
      fill() {
        const rgba = parseCssColor(state.fillStyle);
        for (const poly of path) {
          if (poly.length < 3) continue;
          let minY = height, maxY = 0;
          for (const pt of poly) {
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
          }
          const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
          for (let y = y0; y <= y1; y++) {
            const xs = [];
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
              const p1 = poly[i], p2 = poly[j];
              if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                xs.push(p1.x + ((y - p1.y) / (p2.y - p1.y)) * (p2.x - p1.x));
              }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k + 1 < xs.length; k += 2) {
              const xStart = Math.max(0, Math.ceil(xs[k]));
              const xEnd = Math.min(width - 1, Math.floor(xs[k + 1]));
              for (let x = xStart; x <= xEnd; x++) blendPixel(x, y, rgba);
            }
          }
        }
      },
      stroke() {
        const rgba = parseCssColor(state.strokeStyle);
        const lw = state.lineWidth || 1;
        const dashState = { acc: 0 };
        for (const poly of path) {
          for (let i = 1; i < poly.length; i++) {
            drawSeg(poly[i - 1].x, poly[i - 1].y, poly[i].x, poly[i].y, rgba, lw, dashState);
          }
        }
      },
      fillText(text, x, y) {
        const str = String(text ?? '');
        if (!str) return;
        const rgba = parseCssColor(state.fillStyle);
        const w = Math.min(str.length * 5, 120);
        const ox = state.textAlign === 'center' ? x - w / 2 : (state.textAlign === 'right' ? x - w : x);
        const oy = y - 3;
        for (let ix = Math.max(0, Math.floor(ox)); ix < Math.min(width, Math.ceil(ox + w)); ix += 2) {
          for (let iy = Math.max(0, Math.floor(oy)); iy < Math.min(height, Math.ceil(oy + 5)); iy += 2) {
            blendPixel(ix, iy, rgba);
          }
        }
      },
      drawImage() {},
      getImageData(x, y, w, h) {
        if (x === 0 && y === 0 && w === width && h === height) return { data: new Uint8ClampedArray(data), width, height };
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      },
    };

    return {
      width,
      height,
      getContext: () => ctx,
    };
  }

  /**
   * Render chronological replay frames (passing threads and channels for specialized honeycombs).
   */
  function buildReplayFrames({
    mode = 'hive',
    posts = [],
    members = [],
    threads = null,
    channels = null,
    phase = 'done',
    pacing = 'even',
    speed = 1,
    hideInactive = false,
    expandBroadcast = false,
    focus = null,
    theme = 'light',
    width = 680,
    height,
    graph,
    bees,
    createCanvas,
    maxFrames = 90,
  } = {}) {
    const graphLib = resolveGraph(graph);
    const beesLib = resolveBees(bees);
    if (typeof graphLib?.renderGraphFrame !== 'function') {
      throw new Error('HiveGraph.renderGraphFrame is required to export a graph replay GIF.');
    }

    let resolvedHeight = height;
    if (resolvedHeight == null) {
      if (mode === 'hive' && typeof graphLib.projectHive === 'function' && typeof graphLib.hiveMinimumHeight === 'function') {
        const preview = graphLib.projectHive(posts, members, null, { threads, channels });
        resolvedHeight = Math.max(460, graphLib.hiveMinimumHeight(preview.clusters.length, width));
      } else {
        resolvedHeight = 460;
      }
    }

    const isPost = graphLib.isPost ?? (e => e && (e.kind === 'brief' || e.kind === 'message' || (!e.kind && e.author !== 'system')));
    const timeline = (posts ?? []).filter(isPost).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    const snapshots = [{ seq: 0, post: null }];
    const limit = Math.max(2, Math.floor(Number(maxFrames) || 90));
    if (timeline.length > 0) {
      if (timeline.length + 1 <= limit) {
        for (const post of timeline) snapshots.push({ seq: post.seq, post });
      } else {
        const target = limit - 1;
        const chosen = new Set([0, timeline.length - 1]);
        for (let i = 1; i < target - 1; i++) {
          chosen.add(Math.round((i * (timeline.length - 1)) / (target - 1)));
        }
        for (const idx of [...chosen].sort((a, b) => a - b)) {
          snapshots.push({ seq: timeline[idx].seq, post: timeline[idx] });
        }
      }
    }

    const makeCanvas = createCanvas
      ?? (typeof document !== 'undefined'
        ? (w, h) => {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            return c;
          }
        : createSoftwareCanvas);

    const canvas = makeCanvas(width, resolvedHeight);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== resolvedHeight) canvas.height = resolvedHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not obtain 2D canvas context for GIF export.');

    const speedFactor = Math.max(0.25, Number(speed) || 1);
    const frames = [];
    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const isLast = i === snapshots.length - 1;
      const prevPost = i > 0 ? snapshots[i - 1].post : null;
      let delayMs = 620;
      if (pacing === 'real' && snap.post?.time && prevPost?.time) {
        const gap = Date.parse(snap.post.time) - Date.parse(prevPost.time);
        if (Number.isFinite(gap)) delayMs = Math.max(110, Math.min(gap, 2000));
      }
      const rawCs = Math.round(delayMs / speedFactor / 10);
      const delayCs = isLast ? Math.max(150, rawCs) : Math.max(4, Math.min(300, rawCs));

      graphLib.renderGraphFrame(ctx, {
        mode,
        posts,
        members,
        threads,
        channels,
        cursor: isLast && timeline.length ? null : snap.seq,
        phase: isLast ? phase : 'working',
        width,
        height: resolvedHeight,
        theme,
        hideInactive,
        expandBroadcast,
        focus,
        bees: beesLib,
      });

      const image = ctx.getImageData(0, 0, width, resolvedHeight);
      frames.push({
        rgba: image.data instanceof Uint8ClampedArray ? image.data : new Uint8ClampedArray(image.data),
        delayCs,
      });
    }

    return { frames, width, height: resolvedHeight, frameCount: frames.length };
  }

  function exportGraphReplayGif(opts = {}) {
    const { frames, width, height, frameCount } = buildReplayFrames(opts);
    const bytes = encodeGif(frames, { width, height, loop: 0 });
    const blob = typeof Blob !== 'undefined' ? new Blob([bytes], { type: 'image/gif' }) : undefined;
    return {
      bytes,
      blob,
      frameCount,
      width,
      height,
    };
  }

  globalThis.HiveGif = Object.freeze({ encodeGif, exportGraphReplayGif, buildReplayFrames });
})();
