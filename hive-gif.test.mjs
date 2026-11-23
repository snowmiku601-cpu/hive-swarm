import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import './hive-bees.js';
import './hive-graph.js';
import './hive-gif.js';

// Independent GIF89a + variable-length LZW binary parser for round-trip verification.
function decodeGif89a(bytes) {
  let pos = 0;
  const u8 = () => bytes[pos++];
  const u16 = () => {
    const val = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    return val;
  };
  const ascii = len => {
    let out = '';
    for (let i = 0; i < len; i++) out += String.fromCharCode(bytes[pos++]);
    return out;
  };

  const header = ascii(6);
  const width = u16();
  const height = u16();
  const packed = u8();
  const bgIndex = u8();
  const aspect = u8();

  const hasGct = Boolean(packed & 0x80);
  const gctSize = hasGct ? (1 << ((packed & 0x07) + 1)) : 0;
  const gct = [];
  for (let i = 0; i < gctSize; i++) {
    gct.push([u8(), u8(), u8()]);
  }

  let netscapeLoop = null;
  let pendingDelayCs = 0;
  const frames = [];
  let sawTrailer = false;

  while (pos < bytes.length) {
    const intro = u8();
    if (intro === 0x3B) {
      sawTrailer = true;
      break;
    }
    if (intro === 0x21) {
      const label = u8();
      if (label === 0xF9) {
        const blockLen = u8();
        assert.equal(blockLen, 4, 'GCE block length must be 4');
        const gcePacked = u8();
        pendingDelayCs = u16();
        const transIdx = u8();
        const term = u8();
        assert.equal(term, 0);
        void gcePacked;
        void transIdx;
      } else if (label === 0xFF) {
        const appLen = u8();
        const appId = ascii(appLen);
        const subBlocks = [];
        while (true) {
          const sbLen = u8();
          if (sbLen === 0) break;
          subBlocks.push(bytes.slice(pos, pos + sbLen));
          pos += sbLen;
        }
        if (appId === 'NETSCAPE2.0' && subBlocks.length === 1 && subBlocks[0].length === 3 && subBlocks[0][0] === 1) {
          netscapeLoop = subBlocks[0][1] | (subBlocks[0][2] << 8);
        }
      } else {
        while (true) {
          const sbLen = u8();
          if (sbLen === 0) break;
          pos += sbLen;
        }
      }
      continue;
    }

    if (intro === 0x2C) {
      const left = u16();
      const top = u16();
      const fw = u16();
      const fh = u16();
      const imgPacked = u8();
      let palette = gct;
      if (imgPacked & 0x80) {
        const lctSize = 1 << ((imgPacked & 0x07) + 1);
        palette = [];
        for (let i = 0; i < lctSize; i++) palette.push([u8(), u8(), u8()]);
      }
      const minCodeSize = u8();
      const compressed = [];
      while (true) {
        const sbLen = u8();
        if (sbLen === 0) break;
        for (let i = 0; i < sbLen; i++) compressed.push(bytes[pos++]);
      }

      // Variable-length LZW decode
      const clearCode = 1 << minCodeSize;
      const eoiCode = clearCode + 1;
      let codeSize = minCodeSize + 1;
      let nextCode = eoiCode + 1;
      let dict = [];
      const resetDict = () => {
        dict = new Array(4096);
        for (let i = 0; i < clearCode; i++) dict[i] = [i];
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      };
      resetDict();

      let bitBuf = 0;
      let bitCount = 0;
      let bytePos = 0;
      const readCode = () => {
        while (bitCount < codeSize) {
          assert.ok(bytePos < compressed.length, 'unexpected end of LZW stream');
          bitBuf |= compressed[bytePos++] << bitCount;
          bitCount += 8;
        }
        const mask = (1 << codeSize) - 1;
        const code = bitBuf & mask;
        bitBuf >>>= codeSize;
        bitCount -= codeSize;
        return code;
      };

      const indices = [];
      let prevEntry = null;
      while (true) {
        const code = readCode();
        if (code === clearCode) {
          resetDict();
          prevEntry = null;
          continue;
        }
        if (code === eoiCode) break;

        let entry;
        if (code < nextCode && dict[code]) {
          entry = dict[code];
        } else if (code === nextCode && prevEntry) {
          entry = [...prevEntry, prevEntry[0]];
        } else {
          assert.fail(`Invalid LZW code ${code} (nextCode=${nextCode}, codeSize=${codeSize})`);
        }
        for (const px of entry) indices.push(px);

        if (prevEntry && nextCode < 4096) {
          dict[nextCode++] = [...prevEntry, entry[0]];
          if (nextCode === (1 << codeSize) && codeSize < 12) {
            codeSize++;
          }
        }
        prevEntry = entry;
      }

      assert.equal(indices.length, fw * fh, 'decoded pixel count matches frame area');
      frames.push({ left, top, width: fw, height: fh, delayCs: pendingDelayCs, indices, palette, minCodeSize });
      pendingDelayCs = 0;
    }
  }

  assert.equal(pos, bytes.length, 'trailer must be exact EOF');
  return { header, width, height, bgIndex, aspect, gct, netscapeLoop, frames, sawTrailer };
}

test('encodeGif produces valid GIF89a with NETSCAPE2.0 loop, 0x3B trailer, and exact LZW pixel round-trip', () => {
  const { encodeGif } = globalThis.HiveGif;
  const width = 24;
  const height = 24;
  const colors = [
    [248, 249, 251], // background
    [85, 148, 60],   // green
    [130, 80, 223],  // purple
    [239, 172, 55],  // gold
  ];
  const makeFrame = (patternFn, delayCs) => {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = colors[patternFn(x, y)];
        const p = (y * width + x) * 4;
        rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255;
      }
    }
    return { rgba, delayCs };
  };

  const f0 = makeFrame((x, y) => ((x + y) % 4 === 0 ? 1 : 0), 25);
  const f1 = makeFrame((x, y) => (x >= 4 && x < 20 && y >= 6 && y < 18 ? ((x ^ y) & 1 ? 2 : 3) : 0), 40);
  const f2 = makeFrame((x, y) => (y < 12 ? 1 : 2), 150);

  const bytes = encodeGif([f0, f1, f2], { width, height, loop: 0 });
  assert.ok(bytes instanceof Uint8Array);

  const decoded = decodeGif89a(bytes);
  assert.equal(decoded.header, 'GIF89a');
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.netscapeLoop, 0);
  assert.equal(decoded.sawTrailer, true);
  assert.equal(decoded.frames.length, 3);
  assert.deepEqual(decoded.frames.map(f => f.delayCs), [25, 40, 150]);

  const originals = [f0.rgba, f1.rgba, f2.rgba];
  for (let fi = 0; fi < decoded.frames.length; fi++) {
    const frame = decoded.frames[fi];
    const orig = originals[fi];
    for (let i = 0; i < width * height; i++) {
      const [r, g, b] = frame.palette[frame.indices[i]];
      assert.deepEqual([r, g, b], [orig[i * 4], orig[i * 4 + 1], orig[i * 4 + 2]],
        `frame ${fi} pixel ${i} round-trips cleanly`);
    }
  }
});

test('encodeGif handles >4096 LZW dictionary resets and quantizes high-color frames into clean 64/128 palettes', () => {
  const { encodeGif } = globalThis.HiveGif;
  const width = 128;
  const height = 96;
  const rgba = new Uint8ClampedArray(width * height * 4);

  // Build deterministic high-entropy image with >200 distinct colors to exercise both quantization and LZW >4096 resets.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const hash = ((x * 73 + y * 151 + (x ^ y) * 37) & 255);
      rgba[p] = (hash * 3) & 255;
      rgba[p + 1] = (hash * 5 + x * 2) & 255;
      rgba[p + 2] = (hash * 7 + y * 3) & 255;
      rgba[p + 3] = 255;
    }
  }

  const bytes64 = encodeGif([{ rgba, delayCs: 20 }], { width, height, loop: 3, maxColors: 64 });
  const dec64 = decodeGif89a(bytes64);
  assert.equal(dec64.header, 'GIF89a');
  assert.equal(dec64.netscapeLoop, 3);
  assert.equal(dec64.sawTrailer, true);
  assert.ok(dec64.gct.length <= 64);
  assert.equal(dec64.frames[0].indices.length, width * height);

  const bytes128 = encodeGif([{ rgba, delayCs: 20 }], { width, height, loop: 0, maxColors: 128 });
  const dec128 = decodeGif89a(bytes128);
  assert.ok(dec128.gct.length <= 128);
  assert.equal(dec128.frames[0].indices.length, width * height);
});

test('exportGraphReplayGif renders hive and mentions replay GIFs cleanly in headless Node and honors maxFrames', () => {
  const { exportGraphReplayGif } = globalThis.HiveGif;
  const members = [
    { name: 'coordinator', role: 'coordinator', status: 'waiting' },
    { name: 'alpha', status: 'done' },
    { name: 'beta', status: 'done' },
  ];
  const posts = [
    { seq: 1, kind: 'brief', author: 'coordinator', targets: ['alpha'], text: 'Start alpha', time: '2026-11-21T00:00:00Z' },
    { seq: 2, kind: 'message', author: 'alpha', targets: ['beta'], text: 'Check beta', time: '2026-11-21T00:01:00Z' },
    { seq: 3, kind: 'message', author: 'beta', targets: ['coordinator'], text: '[done] Beta ready', time: '2026-11-21T00:02:00Z' },
  ];

  for (const mode of ['hive', 'mentions']) {
    const out = exportGraphReplayGif({
      mode,
      posts,
      members,
      phase: 'done',
      pacing: 'real',
      speed: 2,
      theme: mode === 'hive' ? 'light' : 'dark',
      width: 320,
      height: 240,
      graph: globalThis.HiveGraph,
      bees: globalThis.HiveBee,
    });
    assert.equal(out.width, 320);
    assert.equal(out.height, 240);
    assert.equal(out.frameCount, 4); // initial cursor=0 + 3 posts
    assert.ok(out.bytes instanceof Uint8Array);
    const decoded = decodeGif89a(out.bytes);
    assert.equal(decoded.header, 'GIF89a');
    assert.equal(decoded.netscapeLoop, 0);
    assert.equal(decoded.sawTrailer, true);
    assert.equal(decoded.frames.length, 4);
    assert.ok(decoded.frames.at(-1).delayCs >= 150, 'final frame holds >= 1.5s before loop');
  }

  // Verify maxFrames cap when post count exceeds maxFrames
  const manyPosts = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    kind: 'message',
    author: i % 2 === 0 ? 'alpha' : 'beta',
    targets: ['coordinator'],
    text: 'Update ' + (i + 1),
  }));
  const capped = exportGraphReplayGif({
    mode: 'hive',
    posts: manyPosts,
    members,
    width: 240,
    height: 180,
    maxFrames: 10,
    graph: globalThis.HiveGraph,
    bees: globalThis.HiveBee,
  });
  assert.ok(capped.frameCount <= 10 && capped.frameCount >= 2);
  const decCapped = decodeGif89a(capped.bytes);
  assert.equal(decCapped.frames.length, capped.frameCount);

  // Empty posts still produces valid 1-frame GIF
  const emptyOut = exportGraphReplayGif({
    mode: 'hive',
    posts: [],
    members,
    width: 240,
    height: 180,
    graph: globalThis.HiveGraph,
    bees: globalThis.HiveBee,
  });
  assert.equal(emptyOut.frameCount, 1);
  assert.equal(decodeGif89a(emptyOut.bytes).sawTrailer, true);
});

test('scripts/build-dsh-client.mjs registers hive:gif alias in both API and CLI builders', () => {
  const source = readFileSync(new URL('./scripts/build-dsh-client.mjs', import.meta.url), 'utf8');
  assert.match(source, /--alias:hive:gif=/, 'cliBuild includes hive:gif alias');
  assert.match(source, /hive:\(graph\|bees\|gif\|icon\)/, 'esbuild plugin resolves hive:gif');
  assert.match(source, /HiveGif/, 'exports globalThis.HiveGif for DSH client');
});

test('exportGraphReplayGif and buildReplayFrames forward threads/channels and render specialized honeycomb replays', () => {
  const { exportGraphReplayGif, buildReplayFrames } = globalThis.HiveGif;
  assert.equal(typeof buildReplayFrames, 'function');

  const threads = [
    { id: 'core', title: 'Core Engine & Bug Fixes', members: ['alpha', 'alpha-2'] },
    { id: 'ui', title: 'Dashboard UI Polish', members: ['beta'] },
  ];
  const channels = [{ name: 'main', archived: false }];
  const members = [
    { name: 'coordinator', role: 'coordinator', status: 'waiting' },
    { name: 'alpha', status: 'done' },
    { name: 'alpha-2', status: 'done' },
    { name: 'beta', status: 'done', waitFor: ['alpha'] },
  ];
  const posts = [
    { seq: 1, kind: 'message', author: 'alpha', targets: ['alpha-2'], text: 'Intra-hex sync', time: '2026-11-21T00:00:00Z' },
    { seq: 2, kind: 'message', author: 'alpha', targets: ['coordinator'], text: '[done] Alpha done', time: '2026-11-21T00:01:00Z' },
    { seq: 3, kind: 'message', author: 'beta', targets: ['coordinator'], text: '[done] Beta done', time: '2026-11-21T00:02:00Z' },
  ];

  const seenCursors = [];
  const spyGraph = {
    ...globalThis.HiveGraph,
    renderGraphFrame(ctx, opts) {
      seenCursors.push({ cursor: opts.cursor, threads: opts.threads, channels: opts.channels });
      return globalThis.HiveGraph.renderGraphFrame(ctx, opts);
    },
  };

  const out = exportGraphReplayGif({
    mode: 'hive',
    posts,
    members,
    threads,
    channels,
    phase: 'done',
    width: 480,
    height: 460,
    graph: spyGraph,
    bees: globalThis.HiveBee,
  });
  assert.equal(out.frameCount, 4);
  assert.equal(seenCursors.length, 4);
  assert.ok(seenCursors.every(c => c.threads === threads && c.channels === channels),
    'threads and channels forwarded on every replay frame');
  const decoded = decodeGif89a(out.bytes);
  assert.equal(decoded.header, 'GIF89a');
  assert.equal(decoded.sawTrailer, true);
  assert.equal(decoded.frames.length, 4);
  // Mid-replay frames (cursor=0, cursor=1) should differ visually from cursor=2 because Waiting on arrow disappears
  const same01 = decoded.frames[1].indices.every((v, idx) => v === decoded.frames[2].indices[idx]);
  assert.equal(same01, false, 'mid-replay frame at seq=1 differs from seq=2');
});

test('software canvas honors ctx.textAlign center/left/right and save/restore for textBaseline', () => {
  const { buildReplayFrames } = globalThis.HiveGif;
  let capturedAlign, capturedBaseline;
  const { frames } = buildReplayFrames({
    width: 120,
    height: 60,
    graph: {
      renderGraphFrame(ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 120, 60);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        assert.equal(ctx.textAlign, 'center');
        assert.equal(ctx.textBaseline, 'middle');
        ctx.fillStyle = '#000000';
        ctx.fillText('CenteredLabel', 60, 30);
        ctx.restore();
        capturedAlign = ctx.textAlign;
        capturedBaseline = ctx.textBaseline;
      },
    },
    bees: globalThis.HiveBee,
  });

  assert.equal(capturedAlign, 'left');
  assert.equal(capturedBaseline, 'alphabetic');
  const rgba = frames[0].rgba;
  let minX = 120, maxX = -1;
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < 120; x++) {
      const p = (y * 120 + x) * 4;
      if (rgba[p] < 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  assert.ok(minX < 40 && maxX > 80 && maxX < 100,
    `centered text must span symmetrically around x=60 (got ${minX}..${maxX})`);
});
