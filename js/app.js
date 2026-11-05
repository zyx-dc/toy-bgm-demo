"use strict";

/* ============================================================
   配乐生成器 · M1 结构层
   时长 → 段落序列 → 逐小节渲染
   ============================================================ */

const $ = (s) => document.querySelector(s);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* ---------------- 随机（可复现） ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let RNG = Math.random;
function setSeed(s) { RNG = mulberry32(s >>> 0); }
const rnd = (a, b) => a + RNG() * (b - a);

/* ---------------- 采样 ---------------- */

const NOTE_OFF = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
function nameToMidi(n) {
  const m = n.match(/^([A-G]s?)(\d)$/);
  return (parseInt(m[2], 10) + 1) * 12 + NOTE_OFF[m[1]];
}

const PIANO_NAMES = [
  "A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7",
  "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8",
  "Ds1", "Ds2", "Ds3", "Ds4", "Ds5", "Ds6", "Ds7",
  "Fs1", "Fs2", "Fs3", "Fs4", "Fs5", "Fs6", "Fs7",
];

const EPIANO_FILES = [
  "29_F1_FF", "29_F1_P", "33_A1_FF", "33_A1_P", "37_C#2_FF", "37_C#2_P",
  "41_F2_FF", "41_F2_P", "45_A2_FF", "45_A2_P", "47_B2_FF", "49_C#3_FF", "49_C#3_P",
  "52_E3_P", "53_F3_FF", "57_A3_FF", "57_A3_P", "61_C#4_FF", "61_C#4_P",
  "65_F4_FF", "65_F4_P", "69_A4_FF", "69_A4_P", "73_C#5_FF", "73_C#5_P",
  "77_F5_FF", "77_F5_P", "81_A5_FF", "81_A5_P", "85_C#6_FF", "85_C#6_P",
  "88_E6_FF", "88_E6_P",
];

const SAMPLES = { piano: [], epiano: [], drums: {}, loaded: false, loading: null };

async function fetchDecode(ctx, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " -> " + res.status);
  const ab = await res.arrayBuffer();
  return await ctx.decodeAudioData(ab);
}

function loadSamples(ctx, onProgress) {
  if (SAMPLES.loaded) return Promise.resolve();
  if (SAMPLES.loading) return SAMPLES.loading;

  const jobs = [];
  const total = PIANO_NAMES.length + EPIANO_FILES.length + 5;
  let done = 0;
  const tick = () => onProgress(++done, total);

  PIANO_NAMES.forEach((name) => {
    jobs.push(fetchDecode(ctx, "./assets/piano/" + name + ".mp3").then((buf) => {
      SAMPLES.piano.push({ midi: nameToMidi(name), buf });
      tick();
    }));
  });

  EPIANO_FILES.forEach((name) => {
    jobs.push(fetchDecode(ctx, "./assets/epiano/" + name.replace("#", "%23") + ".mp3").then((buf) => {
      SAMPLES.epiano.push({ midi: parseInt(name.split("_")[0], 10), layer: /_FF$/.test(name) ? "ff" : "p", buf });
      tick();
    }));
  });

  ["kick", "snare", "snare2", "hat", "ohat"].forEach((k) => {
    jobs.push(fetchDecode(ctx, "./assets/drums/" + k + ".mp3").then((buf) => {
      SAMPLES.drums[k] = buf;
      tick();
    }));
  });

  SAMPLES.loading = Promise.all(jobs).then(() => {
    SAMPLES.piano.sort((a, b) => a.midi - b.midi);
    const groups = {};
    SAMPLES.epiano.forEach((s) => {
      const g = groups[s.midi] || (groups[s.midi] = { midi: s.midi, p: null, ff: null });
      g[s.layer] = s.buf;
    });
    SAMPLES.epiano = Object.keys(groups).map((k) => groups[k]).sort((a, b) => a.midi - b.midi);
    SAMPLES.loaded = true;
  });
  return SAMPLES.loading;
}

function nearestIn(list, midi) {
  let best = list[0], bd = 1e9;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i].midi - midi);
    if (d < bd) { bd = d; best = list[i]; }
  }
  return best;
}

/* ---------------- 全局 ---------------- */

let AC = null;
let live = null;
const S = { srcs: [] };
const reg = (n) => { S.srcs.push(n); return n; };

function ensureCtx() {
  if (!AC) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error("这个浏览器不支持 Web Audio");
    AC = new Ctor({ latencyHint: "interactive" });
  }
  return AC;
}

/* ---------------- 基础 ---------------- */

const noiseCache = new WeakMap();
function getNoise(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 3);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    const nr = mulberry32(0x51ed270b);
    for (let i = 0; i < len; i++) d[i] = nr() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

function reverbIR(ctx, dur, decay) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.floor(ctx.sampleRate * 0.018);
  const taps = [0.009, 0.017, 0.026, 0.038, 0.051, 0.067];
  const nr = mulberry32(0x2f83a1c7);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0;
    for (let i = pre; i < len; i++) {
      const k = 1 - (i - pre) / (len - pre);
      const x = (nr() * 2 - 1) * Math.pow(k, decay);
      last = last * 0.58 + x * 0.42;
      d[i] = last * 2.0;
    }
    taps.forEach((tt, idx) => {
      const pos = pre + Math.floor(tt * ctx.sampleRate * (1 + ch * 0.14));
      if (pos < len) d[pos] += idx % 2 ? -0.30 : 0.30;
    });
  }
  return buf;
}

function softClipCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = Math.tanh(x * 1.1) / Math.tanh(1.1);
  }
  return c;
}

function buildMaster(ctx, style, emo) {
  const input = ctx.createGain();
  const trim = ctx.createGain();
  trim.gain.value = style.trim || 1;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = (style.lp) * (emo ? emo.bright : 1); lp.Q.value = 0.3;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 34;

  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve();
  shaper.oversample = "4x";

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -15; comp.knee.value = 16; comp.ratio.value = 2.4;
  comp.attack.value = 0.008; comp.release.value = 0.24;

  const out = ctx.createGain();
  out.gain.value = 0.8;

  input.connect(trim); trim.connect(lp); lp.connect(hp); hp.connect(comp);
  comp.connect(shaper); shaper.connect(out); out.connect(ctx.destination);

  const conv = ctx.createConvolver();
  conv.buffer = reverbIR(ctx, style.revLen, style.revDecay);
  const wet = ctx.createGain();
  wet.gain.value = style.revMix;
  lp.connect(conv); conv.connect(wet); wet.connect(out);

  return { input, out };
}

/* ---------------- 合成乐器 ---------------- */

function epiano(ctx, dest, midi, t, end, vel) {
  const f = mtof(midi);
  const car = ctx.createOscillator(); car.type = "sine"; car.frequency.value = f;
  const mod = ctx.createOscillator(); mod.type = "sine"; mod.frequency.value = f * 2;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(f * 1.5 * vel, t);
  mg.gain.exponentialRampToValueAtTime(f * 0.04, t + 0.3);
  mod.connect(mg); mg.connect(car.frequency);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.26 * vel, t + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.6, end - t + 0.5));

  const pan = ctx.createStereoPanner(); pan.pan.value = rnd(-0.16, 0.16);
  car.connect(amp); amp.connect(pan); pan.connect(dest);

  const stopAt = t + Math.max(0.7, end - t + 0.7);
  car.start(t); mod.start(t); car.stop(stopAt); mod.stop(stopAt);
  reg(car); reg(mod);
}

function feltPiano(ctx, dest, midi, t, end, vel) {
  const f = mtof(midi);
  const out = ctx.createGain(); out.gain.value = 1; out.connect(dest);
  const spread = 1 + (69 - midi) / 70;
  [[1, 0.50, 1.7], [2, 0.20, 0.95], [3, 0.09, 0.6], [4.01, 0.045, 0.38]].forEach((p) => {
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f * p[0];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p[1] * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + p[2] * spread * 1.6);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + p[2] * spread * 1.6 + 0.1);
    reg(o);
  });
  const n = ctx.createBufferSource(); n.buffer = getNoise(ctx);
  const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1700; bp.Q.value = 0.9;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.045 * vel, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
  n.connect(bp); bp.connect(ng); ng.connect(out);
  n.start(t, RNG() * 2); n.stop(t + 0.09);
  reg(n);
}

function pad(ctx, dest, midi, t, end, vel) {
  const f = mtof(midi);
  const g = ctx.createGain();
  const peak = 0.045 * vel;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.55);
  g.gain.setValueAtTime(peak, Math.max(t + 0.6, end - 0.25));
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.8);

  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1500; lp.Q.value = 0.4;
  const pan = ctx.createStereoPanner(); pan.pan.value = rnd(-0.35, 0.35);
  g.connect(lp); lp.connect(pan); pan.connect(dest);

  [-7, 0, 7].forEach((c) => {
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = c;
    o.connect(g); o.start(t); o.stop(end + 0.9); reg(o);
  });
}

function bass(ctx, dest, midi, t, end, vel, cutoff) {
  const f = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.30 * vel, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.12);

  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = cutoff || 320; lp.Q.value = 0.7;

  const o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = f;
  const o2 = ctx.createOscillator(); o2.type = "triangle"; o2.frequency.value = f * 2;
  const g2 = ctx.createGain(); g2.gain.value = 0.22;
  o2.connect(g2); g2.connect(g);

  o1.connect(g); g.connect(lp); lp.connect(dest);
  o1.start(t); o2.start(t); o1.stop(end + 0.2); o2.stop(end + 0.2);
  reg(o1); reg(o2);
}

function pluck(ctx, dest, midi, t, dur, vel, type, cut) {
  const f = mtof(midi);
  const o = ctx.createOscillator(); o.type = type || "triangle"; o.frequency.value = f;
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass";
  lp.frequency.setValueAtTime(cut || 4200, t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(320, (cut || 4200) * 0.22), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.11 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); lp.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.04);
  reg(o);
}

/* ---------------- 合成鼓 ---------------- */

function kick(ctx, dest, t, vel) {
  const o = ctx.createOscillator(); o.type = "sine";
  o.frequency.setValueAtTime(125, t);
  o.frequency.exponentialRampToValueAtTime(44, t + 0.13);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.95 * vel, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.46);
  reg(o);
}

function noiseHit(ctx, dest, t, opt) {
  const dur = opt.dur || 0.1;
  const src = ctx.createBufferSource(); src.buffer = getNoise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = opt.type || "highpass"; f.frequency.value = opt.freq || 6000; f.Q.value = opt.Q || 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opt.gain || 0.15, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t, RNG() * 2.4); src.stop(t + dur + 0.02);
  reg(src);
}

function snare(ctx, dest, t, vel) {
  noiseHit(ctx, dest, t, { dur: 0.16, type: "bandpass", freq: 1900, Q: 0.8, gain: 0.13 * vel });
  const o = ctx.createOscillator(); o.type = "triangle";
  o.frequency.setValueAtTime(190, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.10 * vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.13);
  reg(o);
}

function clap(ctx, dest, t, vel) {
  for (let i = 0; i < 3; i++) {
    noiseHit(ctx, dest, t + i * 0.011, { dur: 0.03, type: "bandpass", freq: 1400, Q: 1.2, gain: 0.11 * vel });
  }
  noiseHit(ctx, dest, t + 0.034, { dur: 0.14, type: "bandpass", freq: 1500, Q: 0.9, gain: 0.055 * vel });
}

function hat(ctx, dest, t, vel, open) {
  noiseHit(ctx, dest, t, {
    dur: open ? 0.22 : 0.045, type: "highpass", freq: 8200, Q: 0.5,
    gain: (open ? 0.055 : 0.035) * vel,
  });
}

/* ---------------- 采样乐器 ---------------- */

function spiano(ctx, dest, midi, t, end, vel, gainMul) {
  const s = nearestIn(SAMPLES.piano, midi);
  const rate = Math.pow(2, (midi - s.midi) / 12) * (1 + rnd(-0.0012, 0.0012));
  const src = ctx.createBufferSource(); src.buffer = s.buf; src.playbackRate.value = rate;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 900 + 7200 * vel; lp.Q.value = 0.4;

  const g = ctx.createGain();
  const peak = 0.30 * (0.35 + 0.65 * vel) * (gainMul || 1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.004);

  const natural = t + s.buf.duration / rate;
  const stopAt = Math.min(natural, Math.max(end + 0.25, t + 0.4));
  g.gain.setValueAtTime(peak, Math.max(t + 0.01, stopAt - 0.14));
  g.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  const pan = ctx.createStereoPanner(); pan.pan.value = rnd(-0.10, 0.10);
  src.connect(lp); lp.connect(g); g.connect(pan); pan.connect(dest);
  src.start(t); src.stop(stopAt + 0.02);
  reg(src);
}

function sepiano(ctx, dest, midi, t, end, vel, gainMul) {
  const g0 = nearestIn(SAMPLES.epiano, midi);
  if (!g0) return;
  const useFF = vel >= 0.72 && g0.ff;
  const buf = useFF ? g0.ff : (g0.p || g0.ff);
  const rate = Math.pow(2, (midi - g0.midi) / 12) * (1 + rnd(-0.0015, 0.0015));

  const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = useFF ? 8200 : 3800; lp.Q.value = 0.3;

  const g = ctx.createGain();
  const peak = (useFF ? 0.30 : 0.36) * (0.45 + 0.55 * vel) * (gainMul || 1);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.005);

  const natural = t + buf.duration / rate;
  const stopAt = Math.min(natural, Math.max(end + 0.3, t + 0.45));
  g.gain.setValueAtTime(peak, Math.max(t + 0.01, stopAt - 0.16));
  g.gain.exponentialRampToValueAtTime(0.0001, stopAt);

  const pan = ctx.createStereoPanner(); pan.pan.value = rnd(-0.14, 0.14);
  src.connect(lp); lp.connect(g); g.connect(pan); pan.connect(dest);
  src.start(t); src.stop(stopAt + 0.02);
  reg(src);
}

function sdrum(ctx, dest, key, t, vel, rate) {
  const b = SAMPLES.drums[key];
  if (!b) return;
  const src = ctx.createBufferSource(); src.buffer = b; src.playbackRate.value = rate || 1;
  const g = ctx.createGain(); g.gain.value = vel;
  const pan = ctx.createStereoPanner(); pan.pan.value = rnd(-0.06, 0.06);
  src.connect(g); g.connect(pan); pan.connect(dest);
  src.start(t); src.stop(t + b.duration / (rate || 1) + 0.05);
  reg(src);
}

/* ============================================================
   结构层
   ============================================================ */

/* ---------------- 乐理 ---------------- */

const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC = (n) => ((n % 12) + 12) % 12;

function degreeOffset(scale, deg) {
  const i = ((deg % 7) + 7) % 7;
  const o = Math.floor(deg / 7);
  return scale[i] + 12 * o;
}

// 和弦音（音级偏移），三和弦或七和弦
function chordTones(scale, degree, seventh) {
  const steps = seventh ? [0, 2, 4, 6] : [0, 2, 4];
  return steps.map((d) => degreeOffset(scale, degree + d));
}

// 声部连接：在所有转位里挑离上一个和弦最近的那个
function voice(offsets, root, prev, lo, hi) {
  const cands = offsets.map((off) => {
    const arr = [];
    const p = PC(off);
    for (let m = lo; m <= hi; m++) if (PC(m - root) === p) arr.push(m);
    return arr;
  });
  if (cands.some((a) => a.length === 0)) return null;

  let best = null, bestCost = Infinity;
  const walk = (i, acc) => {
    if (i === cands.length) {
      const v = acc.slice().sort((a, b) => a - b);
      let cost = 0;
      if (prev && prev.length) {
        const n = Math.max(v.length, prev.length);
        for (let k = 0; k < n; k++) {
          cost += Math.abs(v[Math.min(k, v.length - 1)] - prev[Math.min(k, prev.length - 1)]);
        }
      } else {
        cost = Math.abs(v[0] - 60) + Math.abs(v[v.length - 1] - 72);
      }
      cost += (v[v.length - 1] - v[0]) * 0.15;
      if (cost < bestCost) { bestCost = cost; best = v; }
      return;
    }
    cands[i].forEach((m) => walk(i + 1, acc.concat([m])));
  };
  walk(0, []);
  return best;
}

function bassNote(root, scale, degree) {
  const p = PC(degreeOffset(scale, degree));
  let best = 40, bd = 1e9;
  for (let m = 33; m <= 45; m++) {
    if (PC(m - root) === p) {
      const d = Math.abs(m - 40);
      if (d < bd) { bd = d; best = m; }
    }
  }
  return best;
}

/* ---------------- 和声模板 ---------------- */

/* ---------------- 情绪 ---------------- */

const EMOTIONS = {
  calm:   { id: "calm",   name: "平静", mode: "minor", bpm: 0.94, bright: 0.82 },
  warm:   { id: "warm",   name: "温暖", mode: "major", bpm: 1.00, bright: 1.00 },
  bright: { id: "bright", name: "明亮", mode: "major", bpm: 1.06, bright: 1.18 },
  tense:  { id: "tense",  name: "紧张", mode: "minor", bpm: 1.08, bright: 1.10 },
};

/* ---------------- 旋律 ---------------- */

// 16 分音符网格上的节奏骨架
const RHYTHMS = [
  [[0, 4], [4, 2], [6, 2], [8, 4], [12, 4]],
  [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
  [[0, 4], [4, 4], [8, 2], [10, 2], [12, 4]],
  [[0, 3], [3, 3], [6, 2], [8, 4], [12, 4]],
  [[0, 6], [6, 2], [8, 4], [12, 4]],
];

// 一个动机 = 节奏骨架 + 轮廓（下行 / 拱形 / 上行），实际音高按当前和弦落地
function realizeBar(rhythm, root, scale, chordOffs, barIdx, type, rng, shape) {
  const scaleSet = new Set(scale);
  const chordSet = new Set(chordOffs.map(PC));
  const top = type === "chorus" ? 84 : 81;
  const bot = type === "chorus" ? 74 : 71;
  const out = [];

  rhythm.forEach(([s, d], i) => {
    const strong = s % 4 === 0;
    const t = i / Math.max(1, rhythm.length - 1);
    const span = top - bot;
    const curve =
      shape === "arch" ? Math.sin(Math.PI * t) :
        shape === "call" ? t :
          1 - t;
    const target = bot + span * curve - barIdx * 1.2;
    let best = null, bc = Infinity;

    for (let m = 67; m <= 86; m++) {
      const off = PC(m - root);
      if (!scaleSet.has(off)) continue;
      if (strong && !chordSet.has(off)) continue;
      let cost = Math.abs(m - target);
      if (out.length) {
        cost += Math.abs(m - out[out.length - 1].midi) * 0.35;
        if (m === out[out.length - 1].midi) cost += 3; // 避免原地重复
      }
      if (cost < bc) { bc = cost; best = m; }
    }
    if (best != null) out.push({ s, d, midi: best });
  });

  return out;
}

/* ---------------- 段落 ---------------- */

// 以 4 小节为单位排段落
function planSections(T) {
  if (T < 12) return [{ type: "loop", bars: T }];

  // 短曲：前奏 4 + 尾奏 2，中间按 4:6 分主歌 / 副歌
  if (T <= 20) {
    const intro = 4, outro = 2;
    const body = T - intro - outro;
    const verse = Math.max(4, Math.round((body * 0.4) / 2) * 2);
    const chorus = body - verse;
    return [
      { type: "intro", bars: intro },
      { type: "verse", bars: verse },
      { type: "chorus", bars: chorus },
      { type: "outro", bars: outro },
    ].filter((s) => s.bars > 0);
  }

  const tail = T % 4;
  const U = (T - tail) / 4;
  let introU = 1, outroU = 1, bridgeU = U >= 10 ? 1 : 0;
  let bodyU = U - introU - outroU - bridgeU;
  if (bodyU < 2) { introU = 1; bridgeU = 0; outroU = 1; bodyU = U - 2; }
  if (bodyU < 1) return [{ type: "loop", bars: T }];

  const per = U >= 12 ? 2 : 1;
  let n = Math.max(2, Math.round(bodyU / per));
  n = Math.min(n, bodyU);
  const base = Math.floor(bodyU / n);
  const rem = bodyU - base * n;
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push((base + (i < rem ? 1 : 0)) * 4);

  const chunks = sizes.map((bars, i) => ({ type: i % 2 === 0 ? "verse" : "chorus", bars }));
  if (chunks.length > 1 && chunks[chunks.length - 1].type === "verse") {
    chunks[chunks.length - 1].type = "chorus";
  }
  if (bridgeU) chunks.splice(Math.max(1, chunks.length - 1), 0, { type: "bridge", bars: bridgeU * 4 });

  const all = [{ type: "intro", bars: introU * 4 }, ...chunks, { type: "outro", bars: outroU * 4 + tail }];

  // 尾奏超过 4 小节时，多出来的并入前一段，尾奏只留 2 小节
  const lastSec = all[all.length - 1];
  const prevSec = all[all.length - 2];
  if (lastSec.type === "outro" && lastSec.bars > 4 && prevSec && prevSec.type !== "intro") {
    const move = lastSec.bars - 2;
    lastSec.bars = 2;
    prevSec.bars += move;
  }

  const merged = [];
  all.forEach((s) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === s.type) prev.bars += s.bars;
    else merged.push({ type: s.type, bars: s.bars });
  });
  return merged;
}

/* ---------------- 和声：功能连接的马尔可夫转移 ---------------- */

// 行 = 当前音级，列 = 下一音级权重；0=i/I 1=ii 2=III/iii 3=iv/IV 4=v/V 5=VI/vi 6=VII/vii°
const HARMONY = {
  minor: [
    [0, 1, 3, 4, 2, 3, 2],
    [4, 0, 1, 2, 1, 1, 1],
    [3, 0, 0, 3, 2, 2, 2],
    [3, 0, 1, 0, 3, 2, 2],
    [5, 0, 1, 1, 0, 1, 1],
    [2, 1, 2, 4, 3, 0, 2],
    [3, 0, 1, 2, 2, 2, 0],
  ],
  major: [
    [0, 1, 2, 4, 3, 3, 0],
    [3, 0, 0, 2, 4, 1, 0],
    [2, 0, 0, 3, 2, 2, 0],
    [3, 1, 1, 0, 4, 3, 0],
    [5, 0, 0, 1, 0, 2, 0],
    [2, 1, 1, 3, 4, 0, 0],
    [4, 0, 0, 1, 3, 2, 0],
  ],
};

function genProg(mode, rng, len) {
  const W = HARMONY[mode];
  const out = [0];
  let guard = 0;

  while (out.length < len - 1 && guard++ < 60) {
    const from = out[out.length - 1];
    const row = W[from];
    let total = 0;
    for (let i = 0; i < row.length; i++) total += row[i];
    let r = rng() * total;
    let pick = -1;
    for (let i = 0; i < row.length; i++) {
      r -= row[i];
      if (r <= 0) { pick = i; break; }
    }
    if (pick < 0) pick = 0;
    if (pick === from) continue;
    out.push(pick);
  }
  while (out.length < len - 1) out.push(0);

  // 终止：属和弦推进下一句，或回到主和弦收住；避免与前一小节重复
  const last = out[out.length - 1];
  let cad = rng() < 0.58 ? 4 : 0;
  if (cad === last) cad = cad === 4 ? 0 : 4;
  out.push(cad);
  return out;
}

/* ---------------- 作一首 ---------------- */

const GROUP_OF = { intro: "verse", outro: "verse", loop: "verse", verse: "verse", chorus: "chorus", bridge: "bridge" };

function getProg(cfg, type, rng) {
  const group = GROUP_OF[type] || "verse";
  if (!cfg.progs) cfg.progs = {};
  if (cfg.progs[group]) return cfg.progs[group];

  let prog = genProg(cfg.mode, rng, 4);
  if (group === "chorus" && cfg.progs.verse && prog.join("") === cfg.progs.verse.join("")) {
    prog = genProg(cfg.mode, rng, 4);
  }
  cfg.progs[group] = prog;
  return prog;
}

function getRhythm(cfg, group, rng) {
  if (!cfg.rhythms) cfg.rhythms = {};
  if (cfg.rhythms[group]) return cfg.rhythms[group];
  const pool = group === "chorus" ? RHYTHMS.slice(2) : RHYTHMS.slice(0, 3);
  cfg.rhythms[group] = pool[Math.floor(rng() * pool.length)];
  return cfg.rhythms[group];
}

const SHAPES = ["down", "down", "arch", "call"];

function getShape(cfg, group, rng) {
  if (!cfg.shapes) cfg.shapes = {};
  if (cfg.shapes[group]) return cfg.shapes[group];
  cfg.shapes[group] = SHAPES[Math.floor(rng() * SHAPES.length)];
  return cfg.shapes[group];
}

// 把任意音高吸附到当前和弦/音阶
function snap(midi, root, scale, chordOffs, strong) {
  const scaleSet = new Set(scale);
  const chordSet = new Set(chordOffs.map(PC));
  let best = midi, bc = Infinity;
  for (let m = 62; m <= 88; m++) {
    const off = PC(m - root);
    if (!scaleSet.has(off)) continue;
    if (strong && !chordSet.has(off)) continue;
    const cost = Math.abs(m - midi);
    if (cost < bc) { bc = cost; best = m; }
  }
  return best;
}

// 桥段：把副歌动机倒影（围绕 76 镜像），再做和弦吸附
function inversionOf(hook, root, scale, chordOffs) {
  return hook.map((n) => ({
    s: n.s,
    d: n.d,
    midi: snap(76 * 2 - n.midi, root, scale, chordOffs, n.s % 4 === 0),
  }));
}

function composeSection(sec, cfg, rng) {
  const scale = SCALES[cfg.mode];
  const group = GROUP_OF[sec.type] || "verse";
  // 同类型段落共用和声与节奏骨架：主歌统一、副歌统一、前奏尾奏跟主歌
  const prog = getProg(cfg, sec.type, rng);
  const rhythm = getRhythm(cfg, group, rng);
  const shape = getShape(cfg, group, rng);

  if (!cfg.mel) cfg.mel = {};

  const barsData = [];
  let prev = null;

  for (let b = 0; b < sec.bars; b++) {
    const degree = prog[b % prog.length];
    const seventh = sec.type !== "intro" && cfg.mode === "minor" ? true : cfg.mode === "major";
    const offs = chordTones(scale, degree, seventh);
    const notes = voice(offs, cfg.root, prev, 55, 76) || [60, 64, 67];
    prev = notes;

    const chord = { notes: notes, bass: bassNote(cfg.root, scale, degree), degree: degree };
    const phrase = b % 4;

    let melody = [];
    const sing = sec.type !== "bridge" &&
      (sec.type === "intro" ? b >= sec.bars - 2 :
        sec.type === "outro" ? b < 2 : true);

    if (sing) {
      const cacheGroup = (sec.type === "intro" || sec.type === "outro") ? sec.type : group;
      const key = cacheGroup + ":" + phrase;
      if (cfg.mel[key]) {
        melody = cfg.mel[key];
      } else {
        const rh = (group === "verse" && sec.type !== "verse") ? rhythm.slice(0, 2) : rhythm;
        melody = realizeBar(rh, cfg.root, scale, offs, phrase, sec.type, rng, shape);
        cfg.mel[key] = melody;
      }
    } else if (sec.type === "bridge") {
      // 桥段：主歌动机的倒影，稀疏出现
      const key = "verse:0";
      const hook = cfg.mel[key] || [];
      if (hook.length && phrase === 0) {
        melody = inversionOf(hook.slice(0, 3), cfg.root, scale, offs);
      }
    }

    barsData.push({ chord: chord, melody: melody });
  }

  sec.barsData = barsData;
  sec.progression = prog;
}

function buildArrangement(style, seconds, seed, emotionId) {
  const emo = EMOTIONS[emotionId] || EMOTIONS.warm;
  const baseBarDur = (60 / (style.bpm * emo.bpm)) * 4;
  const totalBars = Math.max(8, Math.round(seconds / baseBarDur / 2) * 2);
  // 用微调速度把总时长对齐到目标
  const barDur = seconds / totalBars;
  const plan = planSections(totalBars);
  const r = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const root = Math.floor(r() * 12);
  const cfg = { root: root, mode: emo.mode };

  const sections = plan.map((p) => ({ type: p.type, bars: p.bars, startBar: 0 }));
  let acc = 0;
  sections.forEach((s) => { s.startBar = acc; acc += s.bars; });
  sections.forEach((s) => composeSection(s, cfg, r));

  return {
    marks: (state.marks || []).filter((m) => m > 0 && m < acc * barDur),
    barDur: barDur,
    bpm: 240 / barDur,
    totalBars: totalBars,
    sections: sections,
    seconds: acc * barDur,
    root: root,
    mode: emo.mode,
    emo: emo,
  };
}

function scheduleArrangement(ctx, masterInput, style, arr, t0) {
  const step = arr.barDur / 16;
  const drums = ctx.createGain(); drums.gain.value = 1; drums.connect(masterInput);
  const tonal = ctx.createGain(); tonal.gain.value = 1; tonal.connect(masterInput);

  const sampled = SAMPLES.loaded;

  arr.sections.forEach((sec) => {
    for (let b = 0; b < sec.bars; b++) {
      const t = t0 + (sec.startBar + b) * arr.barDur;
      const data = sec.barsData[b];
      style.bar({
        ctx, t, barDur: arr.barDur, step, tonal, drums, sampled,
        chord: data.chord, melody: data.melody,
        type: sec.type, bar: b, secBars: sec.bars,
        isLast: b === sec.bars - 1,
      });
    }
  });

  if (arr.marks && arr.marks.length) {
    arr.marks.forEach((m) => accentAt(ctx, drums, tonal, style, arr, t0 + m, m));
  }

  return arr.totalBars * arr.barDur;
}

function chordAtTime(arr, sec) {
  let bar = Math.floor(sec / arr.barDur);
  bar = Math.max(0, Math.min(arr.totalBars - 1, bar));
  for (let i = 0; i < arr.sections.length; i++) {
    const s = arr.sections[i];
    if (bar >= s.startBar && bar < s.startBar + s.bars) {
      return s.barsData[bar - s.startBar].chord;
    }
  }
  return null;
}

// 卡点重音：按风格给一个短促的强调
function accentAt(ctx, drums, tonal, style, arr, t, sec) {
  const chord = chordAtTime(arr, sec);
  if (!chord) return;
  const sampled = SAMPLES.loaded;

  if (style.id === "piano") {
    chord.notes.forEach((m, i) => {
      if (sampled) spiano(ctx, tonal, m, t + i * 0.012, t + 1.3, 0.92, 0.5);
      else feltPiano(ctx, tonal, m, t + i * 0.012, t + 1.3, 0.9);
    });
    bass(ctx, tonal, chord.bass, t, t + 1.5, 0.75, 320);
    return;
  }

  if (style.id === "electronic") {
    kick(ctx, drums, t, 1);
    clap(ctx, drums, t, 0.9);
    pluck(ctx, tonal, chord.notes[0] + 24, t, 0.18, 0.9, "triangle", 7200);
    return;
  }

  if (sampled) {
    sdrum(ctx, drums, "kick", t, 1, 1);
    sdrum(ctx, drums, "ohat", t, 0.55, 1);
    chord.notes.forEach((m) => sepiano(ctx, tonal, m, t, t + 0.9, 0.92, 0.6));
  } else {
    kick(ctx, drums, t, 1);
    hat(ctx, drums, t, 0.8, true);
    chord.notes.forEach((m) => epiano(ctx, tonal, m, t, t + 0.9, 0.9));
  }
}

/* ============================================================
   三个风格：逐小节渲染
   ============================================================ */

const STYLES = {
  lofi: {
    id: "lofi", name: "Lo-fi", tag: "慢速、电钢、真鼓。深夜聊天 / 读书",
    bpm: 74, lp: 4400, revMix: 0.24, revLen: 2.2, revDecay: 3.2, trim: 1.05,
    bar: function (o) {
      const { ctx, t, step, tonal, drums, chord, type, bar, secBars, sampled } = o;
      const at = (s) => t + s * step;

      let hits;
      if (type === "intro") hits = [[0, 6, 0.65], [8, 6, 0.55]];
      else if (type === "bridge") hits = [[0, 4, 0.72], [8, 4, 0.62]];
      else if (type === "outro") hits = [[0, 3, 0.82], [6, 4, 0.68]];
      else if (type === "chorus") hits = [[0, 2, 1], [2, 2, 0.8], [6, 4, 0.95], [10, 2, 0.85], [12, 2, 0.75]];
      else hits = [[0, 3, 1], [3, 2, 0.72], [6, 4, 0.88], [10, 3, 0.78]];

      hits.forEach((h) => {
        const s = h[0], d = h[1], v = h[2];
        for (let i = 0; i < chord.notes.length; i++) {
          const tt = at(s) + rnd(-0.008, 0.008);
          if (sampled) sepiano(ctx, tonal, chord.notes[i], tt, at(s + d) + 0.25, v * 0.8, 0.75);
          else epiano(ctx, tonal, chord.notes[i], tt, at(s + d) + 0.25, v * rnd(0.85, 1));
        }
      });

      // 副歌：和弦顶部再叠一层八度，拉开亮度
      if (type === "chorus") {
        hits.forEach((h) => {
          const s = h[0], d = h[1], v = h[2];
          const tt = at(s) + rnd(-0.008, 0.008);
          const top = chord.notes[chord.notes.length - 1] + 12;
          if (sampled) sepiano(ctx, tonal, top, tt, at(s + d) + 0.2, v * 0.55, 0.4);
          else epiano(ctx, tonal, top, tt, at(s + d) + 0.2, v * 0.42);
        });
      }

      const root = chord.bass;
      if (type === "intro" || type === "bridge") {
        bass(ctx, tonal, root, at(0), at(8), 0.75, 260);
      } else if (type === "chorus") {
        bass(ctx, tonal, root, at(0), at(4), 0.95, 260);
        bass(ctx, tonal, root + 12, at(4), at(6), 0.6, 300);
        bass(ctx, tonal, root, at(8), at(12), 0.9, 260);
        bass(ctx, tonal, root + 7, at(14), at(15), 0.55, 300);
      } else {
        bass(ctx, tonal, root, at(0), at(6), 0.95, 260);
        bass(ctx, tonal, root, at(8), at(12), 0.72, 260);
        if (bar % 2 === 1) bass(ctx, tonal, root + 7, at(14), at(15), 0.5, 260);
      }

      if (type === "intro" || type === "bridge") {
        if (type === "bridge" && bar % 2 === 1) sdrum(ctx, drums, "kick", at(0), 0.45, 1);
      } else if (type === "chorus") {
        sdrum(ctx, drums, "kick", at(0), 0.95, 1);
        sdrum(ctx, drums, "kick", at(7), 0.6, 0.98);
        sdrum(ctx, drums, "kick", at(10), 0.7, 0.98);
        sdrum(ctx, drums, "snare", at(4), 0.55, 1);
        sdrum(ctx, drums, "snare", at(12), 0.7, 1);
        for (let s = 0; s < 16; s += 2) sdrum(ctx, drums, "hat", at(s), s % 4 === 0 ? 0.5 : 0.3, rnd(0.96, 1.05));
        if (bar % 2 === 1) sdrum(ctx, drums, "ohat", at(14), 0.38, 1);
      } else if (type === "outro") {
        sdrum(ctx, drums, "kick", at(0), 0.6, 1);
        sdrum(ctx, drums, "snare", at(4), 0.35, 1);
        for (let s = 0; s < 16; s += 4) sdrum(ctx, drums, "hat", at(s), 0.25, 1);
      } else {
        sdrum(ctx, drums, "kick", at(0), 0.9, 1);
        sdrum(ctx, drums, "kick", at(10), 0.62, 0.98);
        sdrum(ctx, drums, "snare", at(4), 0.5, 1);
        sdrum(ctx, drums, "snare", at(12), 0.62, 1);
        for (let s = 0; s < 16; s += 2) sdrum(ctx, drums, "hat", at(s), s % 4 === 0 ? 0.5 : 0.28, rnd(0.96, 1.05));
        if (bar % 2 === 0) sdrum(ctx, drums, "ohat", at(14), 0.32, 1);
      }

      o.melody.forEach((n) => {
        const tt = at(n.s) + rnd(-0.01, 0.01);
        const end = at(n.s + n.d) + 0.2;
        if (sampled) {
          sepiano(ctx, tonal, n.midi, tt, end, 0.85, 0.95);
          if (type === "chorus") sepiano(ctx, tonal, n.midi + 12, tt, end, 0.5, 0.55);
        } else {
          epiano(ctx, tonal, n.midi, tt, end, 0.82);
          if (type === "chorus") epiano(ctx, tonal, n.midi + 12, tt, end, 0.4);
        }
      });
    },
  },

  piano: {
    id: "piano", name: "轻钢琴", tag: "真钢琴、弦乐、留白。口播 / 情感",
    bpm: 80, lp: 13000, revMix: 0.32, revLen: 2.8, revDecay: 2.5, trim: 2.45,
    bar: function (o) {
      const { ctx, t, step, tonal, chord, type, bar, secBars, sampled } = o;
      const at = (s) => t + s * step;
      const root = chord.bass;
      const N = chord.notes;
      const pick = (i) => N[i % N.length];

      const seqAll = [
        [0, pick(0) + 12, 1.0], [2, pick(1) + 12, 0.6], [4, pick(2) + 12, 0.72], [6, pick(3) + 12, 0.6],
        [8, pick(2) + 12, 0.55], [10, pick(1) + 12, 0.5], [12, pick(3) + 12, 0.62], [14, pick(2) + 12, 0.45],
      ];
      let seq = seqAll;
      if (type === "intro") seq = seqAll.slice(0, 6);
      if (type === "bridge") seq = [seqAll[0], seqAll[4], seqAll[7]];
      if (type === "outro") seq = seqAll.slice(0, 5);

      seq.forEach((n) => {
        const tt = at(n[0]) + rnd(-0.006, 0.006);
        if (sampled) spiano(ctx, tonal, n[1], tt, at(n[0] + 3), n[2] * rnd(0.88, 1), 0.62);
        else feltPiano(ctx, tonal, n[1], tt, at(n[0] + 3), n[2] * rnd(0.88, 1));
      });

      const padA = type === "intro" ? 0.30 : type === "chorus" ? 0.60 : 0.42;
      const padB = type === "intro" ? 0.22 : type === "chorus" ? 0.44 : 0.30;
      const bassVel = type === "intro" ? 0.30 : type === "outro" ? 0.36 : type === "chorus" ? 0.64 : 0.50;

      pad(ctx, tonal, pick(1) + 12, at(0), at(0) + o.barDur, padA);
      pad(ctx, tonal, pick(3), at(0), at(0) + o.barDur, padB);
      bass(ctx, tonal, root, at(0), at(0) + o.barDur * 0.95, bassVel, 250);

      // 副歌加一层高八度的对位音，拉开密度
      if (type === "chorus") {
        [4, 12].forEach((s) => {
          const tt = at(s) + rnd(-0.006, 0.006);
          if (sampled) spiano(ctx, tonal, pick(3) + 24, tt, at(s + 3), 0.42, 0.55);
          else feltPiano(ctx, tonal, pick(3) + 24, tt, at(s + 3), 0.4);
        });
      }

      o.melody.forEach((n) => {
        const tt = at(n.s) + rnd(-0.008, 0.008);
        const end = at(n.s + n.d) + 0.3;
        if (sampled) {
          spiano(ctx, tonal, n.midi, tt, end, 0.95 * rnd(0.9, 1), 0.8);
          if (type === "chorus") spiano(ctx, tonal, n.midi + 12, tt, end, 0.4, 0.5);
        } else {
          feltPiano(ctx, tonal, n.midi, tt, end, 0.95 * rnd(0.9, 1));
        }
      });
    },
  },

  electronic: {
    id: "electronic", name: "电子", tag: "四踩、侧链、琶音。游戏高光 / 快剪",
    bpm: 112, lp: 17000, revMix: 0.14, revLen: 1.6, revDecay: 4, trim: 0.82,
    bar: function (o) {
      const { ctx, t, step, tonal, drums, chord, type, bar, secBars } = o;
      const at = (s) => t + s * step;
      const root = chord.bass;
      const N = chord.notes;
      const barDur = o.barDur;

      for (let i = 0; i < N.length; i++) {
        pad(ctx, tonal, N[i] + 12, at(0), at(0) + barDur, type === "bridge" ? 1.15 : 1);
      }

      const pat = type === "chorus" ? [0, 2, 3, 6, 8, 10, 11, 14] : [0, 2, 6, 8, 10, 14];
      pat.forEach((s, i) => {
        const oct = i === 3 ? 12 : 0;
        bass(ctx, tonal, root + oct, at(s), at(s + 1.6), type === "intro" ? 0.6 : 0.85, 900);
      });

      if (type !== "intro" && type !== "outro") {
        const tones = N.map((x) => x + 12).concat([N[1 % N.length] + 24]);
        for (let s = 0; s < 16; s++) {
          if (type === "bridge" && s % 2) continue;
          const idx = [0, 1, 2, 3, 2, 1, 0, 2, 1, 3, 2, 1, 3, 2, 1, 0][s] % tones.length;
          pluck(ctx, tonal, tones[idx], at(s), 0.11, s % 4 === 0 ? 0.75 : 0.45, "triangle", type === "bridge" ? 2600 : 5200);
        }
      }

      if (type === "verse" || type === "chorus") {
        for (let s = 0; s < 16; s += 4) {
          kick(ctx, drums, at(s), 0.95);
          const kt = at(s);
          tonal.gain.setValueAtTime(0.55, kt);
          tonal.gain.linearRampToValueAtTime(1, kt + 0.16);
        }
        clap(ctx, drums, at(4), 0.85);
        clap(ctx, drums, at(12), 0.85);
        for (let s = 2; s < 16; s += 4) hat(ctx, drums, at(s), 0.7, true);
        for (let s = 1; s < 16; s += 2) hat(ctx, drums, at(s), 0.35, false);
      } else if (type === "bridge") {
        kick(ctx, drums, at(0), 0.7);
        kick(ctx, drums, at(8), 0.7);
        hat(ctx, drums, at(12), 0.4, true);
      }

      o.melody.forEach((n) => {
        pluck(ctx, tonal, n.midi, at(n.s), n.d * step * 1.6, 0.95, "sawtooth", type === "bridge" ? 3000 : 6000);
        if (type === "chorus") pluck(ctx, tonal, n.midi + 12, at(n.s), n.d * step * 1.6, 0.4, "triangle", 7000);
      });
    },
  },
};

/* ============================================================
   状态与播放
   ============================================================ */

const state = { style: "lofi", seconds: 60, seed: 20261104, emotion: "warm", marks: [], arr: null };

let AC_READY = false;

function currentArr() {
  if (!state.arr) state.arr = buildArrangement(STYLES[state.style], state.seconds, state.seed, state.emotion);
  return state.arr;
}

function rebuild() {
  state.arr = buildArrangement(STYLES[state.style], state.seconds, state.seed, state.emotion);
  renderTimeline();
}

function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }

function setHint(msg, isErr) { showMsg(msg, isErr); }

/* ---------------- 时间轴 ---------------- */

const TYPE_NAME = { intro: "前奏", verse: "主歌", chorus: "副歌", bridge: "桥段", outro: "尾奏", loop: "循环" };
const pad2 = (n) => String(n).padStart(2, "0");

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
}

function buildRuler(arr) {
  const ruler = document.querySelector(".ruler");
  const ticks = $("#rulerTicks");
  if (!ruler || !ticks) return;

  ruler.querySelectorAll(".ruler__label").forEach((n) => n.remove());
  ticks.innerHTML = "";

  const total = arr.seconds;
  const steps = [5, 10, 15, 20, 30, 45, 60, 90, 120];
  let step = 120;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] >= total / 4) { step = steps[i]; break; }
  }

  const labels = [];
  for (let t = 0; t <= total + 1e-6; t += step) labels.push(t);
  if (labels[labels.length - 1] < total - 0.5) labels.push(total);

  labels.forEach((t, i) => {
    const el = document.createElement("span");
    el.className = "ruler__label" + (i === 0 ? " is-first" : "") + (i === labels.length - 1 ? " is-last" : "");
    el.style.left = (t / total * 100) + "%";
    el.textContent = mmss(t);
    ruler.insertBefore(el, ticks);
  });

  const cuts = [0].concat(arr.sections.map((s) => (s.startBar + s.bars) / arr.totalBars));
  cuts.forEach((c, i) => {
    const tick = document.createElement("span");
    tick.className = "ruler__tick" + (i === 0 || i === cuts.length - 1 ? " is-major" : "");
    tick.style.left = (c * 100) + "%";
    ticks.appendChild(tick);
  });
}

function renderTimeline() {
  const arr = currentArr();
  const track = $("#track");
  const head = $("#playhead");

  track.querySelectorAll(".seg").forEach((el) => el.remove());

  arr.sections.forEach((sec, i) => {
    const el = document.createElement("div");
    el.className = "seg is-enter";
    el.dataset.key = sec.type;
    el.style.width = ((sec.bars / arr.totalBars) * 100) + "%";
    el.style.setProperty("--bars", sec.bars);
    el.style.setProperty("--i", i);
    el.innerHTML =
      '<div class="seg__top"><span class="seg__idx">' + pad2(i + 1) + "</span>" +
      '<span class="seg__bars">' + sec.bars + " 小节</span></div>" +
      '<span class="seg__name">' + (TYPE_NAME[sec.type] || sec.type) + "</span>" +
      '<span class="seg__ticks" aria-hidden="true"></span>';
    track.insertBefore(el, head);
  });

  buildRuler(arr);

  $("#seedStatus").textContent =
    NOTE_NAMES[arr.root] + (arr.mode === "minor" ? " 小调" : " 大调") + " · " +
    arr.totalBars + " 小节 · " + fmt(arr.seconds) + " 秒 · " + arr.sections.length + " 段 · " +
    Math.round(arr.bpm) + " BPM";
  $("#deckMeta").textContent = arr.totalBars + " 小节 · " + Math.round(arr.bpm) + " BPM";
  $("#tcNow").textContent = "00:00";
  const head0 = $("#playhead");
  if (head0) head0.style.left = "0%";
  $("#tcTotal").textContent = mmss(arr.seconds);
}

function highlight(idx) {
  document.querySelectorAll(".seg").forEach((el, i) => {
    el.classList.toggle("is-active", i === idx);
  });
}

/* ---------------- 播放 ---------------- */

function showMsg(text, isErr) {
  const el = $("#deckMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-err", !!isErr);
}

function setPlayState(on, label) {
  const b = $("#playBtn");
  b.classList.toggle("is-playing", !!on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.setAttribute("aria-label", on ? "停止" : "播放");
  $("#playLabel").textContent = label || (on ? "停止" : "播放");

  const chip = $("#stateChip");
  if (chip) chip.classList.toggle("is-playing", !!on);
  const lab = $("#stateLabel");
  if (lab) lab.textContent = on ? "PLAYBACK" : "STANDBY";

  const stopBtn = $("#stopBtn");
  if (stopBtn) stopBtn.disabled = !on;

  document.querySelectorAll(".seg").forEach((el) => {
    if (on) {
      el.classList.remove("is-enter");
      el.classList.add("is-armed");
    } else {
      el.classList.remove("is-armed");
      el.classList.add("is-enter");
    }
  });
}

function stop() {
  if (!live) {
    setPlayState(false);
    return;
  }
  S.srcs.forEach((n) => { try { n.stop(); } catch (e) {} });
  S.srcs = [];
  try { live.out.disconnect(); } catch (e) {}
  if (live.timer) clearInterval(live.timer);
  live = null;
  vizStop();

  setPlayState(false);
  TITLE.last = -1;
  if (TITLE.g) {
    TITLE.g.setTransform(1, 0, 0, 1, 0, 0);
    TITLE.g.clearRect(0, 0, TITLE.cv.width, TITLE.cv.height);
  }
  const head = $("#playhead");
  if (head) head.style.left = "0%";
  $("#tcNow").textContent = "00:00";
  const lit = $("#meterLit");
  if (lit) lit.style.setProperty("--lvl", "0");
  highlight(-1);
}

async function play() {
  stop();
  const style = STYLES[state.style];
  const ctx = ensureCtx();
  await ctx.resume();

  if (!SAMPLES.loaded) {
    showMsg("加载采样…");
    $("#playBtn").disabled = true;
    try {
      await loadSamples(ctx, (d, t) => {
        showMsg("加载采样 " + d + " / " + t);
        setPlayState(false, Math.round((d / t) * 100) + "%");
      });
    } catch (e) {
      showMsg("采样加载失败：" + e.message, true);
      $("#playBtn").disabled = false;
      setPlayState(false);
      return;
    }
    $("#playBtn").disabled = false;
  }

  const arr = currentArr();
  setSeed(state.seed);
  S.srcs = [];

  const master = buildMaster(ctx, style, arr.emo);
  const t0 = ctx.currentTime + 0.12;
  const dur = scheduleArrangement(ctx, master.input, style, arr, t0);

  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  an.smoothingTimeConstant = 0.7;
  master.out.connect(an);

  live = { ctx, an, out: master.out, start: t0, dur, arr, timer: null };
  vizStart();

  setPlayState(true);
  showMsg(style.name + " · " + fmt(dur) + " 秒 · " + arr.sections.length + " 段");

  const meterBuf = new Uint8Array(an.fftSize);
  const lit = $("#meterLit");
  const head = $("#playhead");

  live.timer = setInterval(() => {
    if (!live) return;
    const e = Math.max(0, Math.min(live.dur, live.ctx.currentTime - live.start));

    const barIdx = Math.min(live.arr.totalBars - 1, Math.floor(e / live.arr.barDur));
    let si = 0;
    for (let i = 0; i < live.arr.sections.length; i++) {
      const s = live.arr.sections[i];
      if (barIdx >= s.startBar && barIdx < s.startBar + s.bars) { si = i; break; }
    }
    highlight(si);

    if (si !== TITLE.last) {
      TITLE.last = si;
      const NAMES = { intro: "前奏", verse: "主歌", chorus: "副歌", bridge: "桥段", outro: "尾奏", loop: "循环" };
      const sec = live.arr.sections[si];
      showSectionTitle(NAMES[sec.type] || "", sec.type);
    }

    $("#tcNow").textContent = mmss(e);
    if (head) head.style.left = ((e / live.dur) * 100).toFixed(2) + "%";

    live.an.getByteTimeDomainData(meterBuf);
    let sum = 0;
    for (let i = 0; i < meterBuf.length; i++) {
      const v = (meterBuf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / meterBuf.length);
    if (lit) lit.style.setProperty("--lvl", Math.min(1, rms * 2.6).toFixed(3));
  }, 100);

  setTimeout(() => { if (live && live.ctx === ctx) stop(); }, (dur + 0.9) * 1000);
}

/* ---------------- 导出 ---------------- */

function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * 2, true); v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, len * numCh * 2, true);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));

  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

async function exportWav() {
  const btn = $("#exportWav");
  btn.disabled = true; btn.textContent = "渲染中…";
  try {
    const ctx = ensureCtx();
    if (!SAMPLES.loaded) await loadSamples(ctx, (d, t) => setHint("加载采样 " + d + " / " + t));

    const style = STYLES[state.style];
    const arr = currentArr();
    const dur = arr.totalBars * arr.barDur + 2.6;
    const sr = 44100;
    const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
    const master = buildMaster(off, style, arr.emo);

    setSeed(state.seed);
    const keep = S.srcs; S.srcs = [];
    scheduleArrangement(off, master.input, style, arr, 0.05);
    S.srcs = keep;

    const buf = await off.startRendering();
    const blob = encodeWav(buf);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bgm-" + style.id + "-" + Math.round(arr.seconds) + "s.wav";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setHint("已导出 bgm-" + style.id + "-" + Math.round(arr.seconds) + "s.wav");
  } catch (e) {
    setHint("导出失败：" + e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "导出 WAV";
  }
}

/* ---------------- MIDI 导出 ---------------- */

function vlq(n) {
  const out = [n & 0x7f];
  n >>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return out;
}

function smfChunk(id, data) {
  const len = data.length;
  return id.concat([(len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255], data);
}

function trackData(events) {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  events.forEach((e) => {
    out.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  });
  out.push(0x00, 0xff, 0x2f, 0x00);
  return out;
}

function nameEvent(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0x7f);
  return { tick: 0, order: 0, bytes: [0xff, 0x03, bytes.length].concat(bytes) };
}

function noteEvents(tick, dur, midi, ch, vel) {
  return [
    { tick: tick, order: 1, bytes: [0x90 | ch, midi, vel] },
    { tick: tick + Math.max(30, dur), order: 0, bytes: [0x80 | ch, midi, 0] },
  ];
}

// 鼓：16 分网格上的简化节奏，和渲染层一致
function drumSteps(styleId, type, bar) {
  if (styleId === "piano") return [];
  const list = [];
  if (styleId === "lofi") {
    if (type === "chorus") {
      list.push([0, 36, 110], [7, 36, 80], [10, 36, 90], [4, 38, 80], [12, 38, 95]);
      for (let s = 0; s < 16; s += 2) list.push([s, 42, s % 4 === 0 ? 80 : 55]);
      if (bar % 2 === 1) list.push([14, 46, 70]);
    } else if (type === "outro") {
      list.push([0, 36, 75], [4, 38, 55]);
      for (let s = 0; s < 16; s += 4) list.push([s, 42, 45]);
    } else {
      list.push([0, 36, 105], [10, 36, 80], [4, 38, 75], [12, 38, 85]);
      for (let s = 0; s < 16; s += 2) list.push([s, 42, s % 4 === 0 ? 75 : 50]);
    }
  } else if (styleId === "electronic") {
    if (type === "verse" || type === "chorus") {
      for (let s = 0; s < 16; s += 4) list.push([s, 36, 115]);
      list.push([4, 39, 100], [12, 39, 100]);
      for (let s = 2; s < 16; s += 4) list.push([s, 46, 85]);
      for (let s = 1; s < 16; s += 2) list.push([s, 42, 50]);
    } else if (type === "bridge") {
      list.push([0, 36, 85], [8, 36, 85], [12, 46, 55]);
    }
  }
  return list;
}

function buildMidi(arr, style) {
  const PPQ = 480, BAR = PPQ * 4, STEP = PPQ / 4;
  const tracks = [];

  // 0：速度 / 拍号
  const meta = [nameEvent(style.name + " · " + NOTE_NAMES[arr.root] + (arr.mode === "minor" ? "m" : ""))];
  const usec = Math.round(60000000 / arr.bpm);
  meta.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usec >> 16) & 255, (usec >> 8) & 255, usec & 255] });
  meta.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] });
  tracks.push(meta);

  const chordEv = [nameEvent("Chords")];
  const bassEv = [nameEvent("Bass")];
  const melEv = [nameEvent("Melody")];
  const drumEv = [nameEvent("Drums")];

  arr.sections.forEach((sec) => {
    for (let b = 0; b < sec.bars; b++) {
      const barTick = (sec.startBar + b) * BAR;
      const data = sec.barsData[b];

      data.chord.notes.forEach((m) => {
        chordEv.push(...noteEvents(barTick, BAR - 20, m, 0, 70));
      });
      bassEv.push(...noteEvents(barTick, BAR - 20, data.chord.bass, 1, 88));

      data.melody.forEach((n) => {
        melEv.push(...noteEvents(barTick + n.s * STEP, n.d * STEP - 15, n.midi, 2, 96));
      });

      drumSteps(style.id, sec.type, b).forEach(([s, note, vel]) => {
        drumEv.push(...noteEvents(barTick + s * STEP, STEP / 2, note, 9, vel));
      });
    }
  });

  tracks.push(chordEv, bassEv, melEv, drumEv);

  const bytes = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, tracks.length >> 8, tracks.length & 255, PPQ >> 8, PPQ & 255];
  tracks.forEach((evs) => {
    bytes.push(...smfChunk([0x4d, 0x54, 0x72, 0x6b], trackData(evs)));
  });
  return new Uint8Array(bytes);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportMidi() {
  try {
    const arr = currentArr();
    const style = STYLES[state.style];
    const bytes = buildMidi(arr, style);
    downloadBlob(new Blob([bytes], { type: "audio/midi" }), "bgm-" + style.id + "-" + Math.round(arr.seconds) + "s.mid");
    setHint("已导出 MIDI：4 轨（和弦 / 贝斯 / 旋律 / 鼓）");
  } catch (e) {
    setHint("MIDI 导出失败：" + e.message, true);
  }
}


/* ---------------- 背景可视化 ---------------- */

const VIZ = {
  cv: null, g: null, w: 0, h: 0, dpr: 1,
  parts: null, raf: 0, style: 0,
  level: 0, target: 0,
  rec: null, chunks: [], dest: null,
};

const VIZ_NAMES = ["光尘", "丝线", "等高线", "关闭"];

function makeSprite() {
  const c = document.createElement("canvas");
  const S = 64;
  c.width = c.height = S;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, "rgba(255,232,196,1)");
  grd.addColorStop(0.35, "rgba(255,206,150,0.55)");
  grd.addColorStop(1, "rgba(255,190,120,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  return c;
}

function vizResize() {
  if (!VIZ.cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  VIZ.dpr = dpr;
  VIZ.w = window.innerWidth;
  VIZ.h = window.innerHeight;
  VIZ.cv.width = Math.floor(VIZ.w * dpr);
  VIZ.cv.height = Math.floor(VIZ.h * dpr);
}

function vizSeed() {
  VIZ.parts = [];
  for (let i = 0; i < 150; i++) {
    VIZ.parts.push({
      x: Math.random(), y: Math.random(), z: Math.random(),
      p: Math.random() * Math.PI * 2,
    });
  }
}

function vizSection() {
  if (!live) return { name: "", type: "", t: 0, dur: 0, p: 0 };
  const e = Math.max(0, Math.min(live.dur, live.ctx.currentTime - live.start));
  const bar = Math.min(live.arr.totalBars - 1, Math.floor(e / live.arr.barDur));
  let sec = live.arr.sections[0];
  for (let i = 0; i < live.arr.sections.length; i++) {
    const s = live.arr.sections[i];
    if (bar >= s.startBar && bar < s.startBar + s.bars) { sec = s; break; }
  }
  const NAME = { intro: "前奏", verse: "主歌", chorus: "副歌", bridge: "桥段", outro: "尾奏", loop: "循环" };
  return { name: NAME[sec.type] || "", type: sec.type, t: e, dur: live.dur, p: e / live.dur };
}

let vizFreqBuf = null;
let vizTimeBuf = null;

function beatPulse() {
  if (!live) return { p: 0, down: false };
  const e = Math.max(0, live.ctx.currentTime - live.start);
  const beatDur = live.arr.barDur / 4;
  const b = e / beatDur;
  const idx = Math.floor(b);
  const frac = b - idx;
  return { p: Math.pow(1 - frac, 3), down: idx % 4 === 0 };
}

function vizEnergy() {
  if (!live || !live.an) return { rms: 0, low: 0, mid: 0 };
  if (!vizFreqBuf || vizFreqBuf.length !== live.an.frequencyBinCount) {
    vizFreqBuf = new Uint8Array(live.an.frequencyBinCount);
  }
  const buf = vizFreqBuf;
  live.an.getByteFrequencyData(buf);
  const band = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += buf[i];
    return s / ((b - a) * 255);
  };
  if (!vizTimeBuf || vizTimeBuf.length !== live.an.fftSize) {
    vizTimeBuf = new Uint8Array(live.an.fftSize);
  }
  const td = vizTimeBuf;
  live.an.getByteTimeDomainData(td);
  let sum = 0;
  for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v; }
  return { rms: Math.sqrt(sum / td.length), low: band(1, 8), mid: band(8, 40) };
}

let vizLastFrame = 0;

function vizDraw(time) {
  if (!VIZ.cv) return;
  if (time - vizLastFrame < 30) {
    VIZ.raf = requestAnimationFrame(vizDraw);
    return;
  }
  vizLastFrame = time;
  const g = VIZ.g;
  const W = VIZ.w, H = VIZ.h;
  const t = time / 1000;

  VIZ.level += (VIZ.target - VIZ.level) * 0.05;

  if (VIZ.level < 0.01 && VIZ.target === 0) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, VIZ.cv.width, VIZ.cv.height);
    VIZ.raf = 0;
    return;
  }

  if (VIZ.style === 3) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, VIZ.cv.width, VIZ.cv.height);
    VIZ.raf = requestAnimationFrame(vizDraw);
    return;
  }

  const info = vizSection();
  const en = vizEnergy();
  const bp = beatPulse();
  const pulse = bp.p * (bp.down ? 1 : 0.45);
  const energy = Math.min(1.2, en.rms * 4 * (1 + pulse * 0.55));
  const density = info.type === "chorus" ? 1 : info.type === "bridge" ? 0.4
    : info.type === "intro" || info.type === "outro" ? 0.55 : 0.8;

  g.setTransform(VIZ.dpr, 0, 0, VIZ.dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.globalAlpha = VIZ.level;

  if (VIZ.style === 0) {
    if (!VIZ.sprite) VIZ.sprite = makeSprite();
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < VIZ.parts.length; i++) {
      const p = VIZ.parts[i];
      p.y -= (0.0006 + p.z * 0.003) * (1 + energy * 1.5) * density;
      if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); }
      const x = (p.x + Math.sin(t * 0.4 + p.p) * 0.008) * W;
      const y = p.y * H;
      const r = (0.6 + p.z * 2.4 * (1 + energy * 0.6)) * 3.4;
      g.globalAlpha = VIZ.level * Math.min(0.75, 0.18 + p.z * 0.3 + energy * 0.25);
      g.drawImage(VIZ.sprite, x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = VIZ.level;
    g.globalCompositeOperation = "source-over";
  } else if (VIZ.style === 1) {
    const lines = 42;
    g.lineWidth = 1;
    for (let i = 0; i < lines; i++) {
      const k = i / lines;
      const y0 = H * (0.16 + k * 0.7);
      const amp = (10 + en.low * 110 + en.mid * 50) * (0.35 + k * 0.9) * density;
      g.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const u = x / W;
        const y = y0 + Math.sin(u * 6 + t * 0.8 + k * 5) * amp * 0.3 + Math.sin(u * 15 - t * 1.2 + k * 9) * amp * 0.12;
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      const a = 0.03 + (1 - Math.abs(k - 0.5) * 2) * 0.16 + energy * 0.1;
      g.strokeStyle = "rgba(224,169,85," + a.toFixed(3) + ")";
      g.stroke();
    }
  } else {
    const cx = W * 0.5 + Math.sin(t * 0.2) * W * 0.05;
    const cy = H * 0.55 + Math.cos(t * 0.17) * H * 0.03;
    const rings = 12;
    for (let i = 0; i < rings; i++) {
      const base = (i + 1) / rings;
      const r = Math.min(W, H) * (0.15 + base * 0.95) * (1 + energy * 0.35);
      const a = (1 - i / rings) * (0.08 + energy * 0.34) * density + 0.02;
      g.beginPath();
      g.ellipse(cx, cy, r * 1.4, r * 0.78, Math.sin(t * 0.09) * 0.25, 0, Math.PI * 2);
      g.strokeStyle = "rgba(232,196,140," + a.toFixed(3) + ")";
      g.lineWidth = 1;
      g.stroke();
    }
  }

  g.globalAlpha = 1;
  VIZ.raf = requestAnimationFrame(vizDraw);
}

function vizStart() {
  VIZ.target = 1;
  if (!VIZ.cv) {
    VIZ.cv = $("#bgViz");
    VIZ.g = VIZ.cv.getContext("2d");
    vizResize();
    vizSeed();
    window.addEventListener("resize", vizResize);
  }
  if (VIZ.cv) VIZ.cv.classList.add("is-on");
  if (!VIZ.raf) {
    vizResize();
    VIZ.raf = requestAnimationFrame(vizDraw);
  }
}

function vizStop() {
  VIZ.target = 0;
  if (VIZ.cv) VIZ.cv.classList.remove("is-on");
  if (stopRec) stopRec();
}

function stopRec() {
  if (!VIZ.rec) return;
  const r = VIZ.rec;
  VIZ.rec = null;
  try { r.stop(); } catch (e) {}
  const btn = $("#vRec");
  if (btn) btn.textContent = "录视频";
  const cv = $("#bgViz");
  if (cv) cv.classList.remove("is-rec");
  if (VIZ.dest && live) { try { live.out.disconnect(VIZ.dest); } catch (e) {} }
  VIZ.dest = null;
}

async function startRec() {
  if (VIZ.rec) { stopRec(); return; }
  if (!live) await play();
  if (!live || !VIZ.cv) return;

  const dest = AC.createMediaStreamDestination();
  live.out.connect(dest);
  VIZ.dest = dest;

  const vs = VIZ.cv.captureStream(30);
  const stream = new MediaStream(vs.getVideoTracks().concat(dest.stream.getAudioTracks()));

  let mime = "video/webm;codecs=vp9,opus";
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) mime = "video/webm";

  VIZ.chunks = [];
  VIZ.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  VIZ.rec.ondataavailable = (e) => { if (e.data && e.data.size) VIZ.chunks.push(e.data); };
  VIZ.rec.onstop = () => {
    const blob = new Blob(VIZ.chunks, { type: "video/webm" });
    downloadBlob(blob, "bgm-" + STYLES[state.style].id + "-" + Math.round(live ? live.dur : 0) + "s.webm");
    showMsg("视频已导出（" + (blob.size / 1048576).toFixed(1) + " MB）");
  };

  VIZ.rec.start(1000);
  VIZ.cv.classList.add("is-rec");
  const btn = $("#vRec");
  if (btn) btn.textContent = "停止录制";
  showMsg("录制中：画面和声音实时写入，约需 " + Math.round(live.dur) + " 秒。");

  setTimeout(() => { if (VIZ.rec) stopRec(); }, (live.dur + 0.6) * 1000);
}


/* ---------------- 段落标题动画（参考 Folia 的逐字入场 / 强调 / 退场） ---------------- */

const TITLE = {
  cv: null, g: null, w: 0, h: 0, dpr: 1,
  text: "", type: "", start: 0, raf: 0, last: -1,
};

const TITLE_DUR = 2.6;

function titleResize() {
  if (!TITLE.cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  TITLE.dpr = dpr;
  TITLE.w = window.innerWidth;
  TITLE.h = window.innerHeight;
  TITLE.cv.width = Math.floor(TITLE.w * dpr);
  TITLE.cv.height = Math.floor(TITLE.h * dpr);
}

function easeOutBack(t, s) {
  s = s === undefined ? 1.70158 : s;
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
}
function easeInCubic(t) { return t * t * t; }
function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }

function showSectionTitle(text, type) {
  if (!TITLE.cv) {
    TITLE.cv = $("#titleLayer");
    if (!TITLE.cv) return;
    TITLE.g = TITLE.cv.getContext("2d");
    titleResize();
    window.addEventListener("resize", titleResize);
  }
  TITLE.text = text;
  TITLE.type = type || "";
  TITLE.start = performance.now();
  if (!TITLE.raf) TITLE.raf = requestAnimationFrame(titleDraw);
}

function titleDraw(now) {
  const g = TITLE.g;
  if (!g) return;
  const W = TITLE.w, H = TITLE.h;
  const p = (now - TITLE.start) / 1000;

  g.setTransform(TITLE.dpr, 0, 0, TITLE.dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  if (p > TITLE_DUR) {
    TITLE.raf = 0;
    return;
  }

  const chars = Array.from(TITLE.text);
  const base = TITLE.type === "chorus" ? Math.min(W * 0.088, H * 0.135) : Math.min(W * 0.062, H * 0.1);
  const size = base;
  g.font = "650 " + size + "px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";

  const gap = size * 0.08;
  const widths = chars.map((c) => g.measureText(c).width + gap);
  const total = widths.reduce((s, v) => s + v, 0) - gap;
  let x = W / 2 - total / 2;
  const y = H * 0.34;

  const inP = 0.62;
  const holdEnd = 1.75;

  for (let i = 0; i < chars.length; i++) {
    const cw = widths[i];
    const cx = x + cw / 2 - gap / 2;
    x += cw;

    const delay = i * 0.055;
    let dy = 0, alpha = 1, rot = 0, scale = 1, blur = 0;

    if (p < inP) {
      const q = clamp01((p - delay) / (inP - delay));
      const e = easeOutBack(q, 2.1);
      dy = -(1 - e) * size * 1.15;
      alpha = clamp01(q * 3);
      rot = (q - 1) * 0.10;
      scale = 0.92 + 0.08 * e;
      blur = (1 - q) * 6;
    } else if (p < holdEnd) {
      const q = (p - inP) / (holdEnd - inP);
      const bpm = beatPulse();
      const hit = bpm.p * (bpm.down ? 1 : 0.5);
      scale = 1 + 0.012 * Math.sin(q * Math.PI * 2) + hit * (bpm.down ? 0.045 : 0.022);
      alpha = 1;
      dy = -hit * size * 0.035;
      rot = 0;
      blur = 0;
    } else {
      const q = clamp01((p - holdEnd) / (TITLE_DUR - holdEnd));
      const e = easeInCubic(q);
      dy = -size * 2.0 * e;
      alpha = 1 - Math.pow(q, 1.3);
      scale = 1 + 0.06 * q;
      blur = q * 8;
    }

    g.save();
    g.globalAlpha = alpha * 0.92;
    g.translate(cx, y + dy);
    g.rotate(rot);
    g.scale(scale, scale);
    if (blur > 0.4) g.filter = "blur(" + blur.toFixed(1) + "px)";
    else g.filter = "none";
    g.fillStyle = "rgba(247,232,208,0.96)";
    g.fillText(chars[i], 0, 0);
    g.restore();
  }

  g.filter = "none";

  TITLE.raf = requestAnimationFrame(titleDraw);
}

/* ---------------- 界面 ---------------- */

function saveState() {
  try {
    localStorage.setItem("bgm-prefs", JSON.stringify({
      style: state.style, seconds: state.seconds, seed: state.seed, emotion: state.emotion,
    }));
  } catch (e) {}
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("bgm-prefs") || "null");
    if (!s) return;
    if (s.style && STYLES[s.style]) state.style = s.style;
    if (s.seconds) state.seconds = s.seconds;
    if (s.seed) state.seed = s.seed;
    if (s.emotion && EMOTIONS[s.emotion]) state.emotion = s.emotion;
  } catch (e) {}
}

const MOOD_UI = { calm: "平静", warm: "温暖", bright: "明亮", tense: "紧张" };
const MOOD_BY_UI = { "平静": "calm", "温暖": "warm", "明亮": "bright", "紧张": "tense" };
const STYLE_UI = { lofi: "lofi", piano: "piano", electronic: "electro" };
const STYLE_BY_UI = { lofi: "lofi", piano: "piano", electro: "electronic" };

function syncUI() {
  document.querySelectorAll("[data-duration]").forEach((b) => {
    b.setAttribute("aria-pressed", +b.dataset.duration === state.seconds ? "true" : "false");
  });
  document.querySelectorAll("[data-mood]").forEach((b) => {
    b.setAttribute("aria-pressed", MOOD_BY_UI[b.dataset.mood] === state.emotion ? "true" : "false");
  });
  document.querySelectorAll("[data-style]").forEach((b) => {
    b.setAttribute("aria-pressed", STYLE_BY_UI[b.dataset.style] === state.style ? "true" : "false");
  });
  $("#seedInput").value = String(state.seed);
}

function buildUI() {
  document.querySelectorAll("[data-duration]").forEach((b) => {
    b.addEventListener("click", () => {
      state.seconds = parseInt(b.dataset.duration, 10);
      stop();
      rebuild();
      saveState();
      syncUI();
      showMsg("目标 " + state.seconds + " 秒，已按小节对齐。");
    });
  });

  document.querySelectorAll("[data-mood]").forEach((b) => {
    b.addEventListener("click", () => {
      state.emotion = MOOD_BY_UI[b.dataset.mood] || "warm";
      stop();
      rebuild();
      saveState();
      syncUI();
      const emo = EMOTIONS[state.emotion];
      showMsg("情绪：" + emo.name + " · " + (emo.mode === "minor" ? "小调" : "大调"));
    });
  });

  document.querySelectorAll("[data-style]").forEach((b) => {
    b.addEventListener("click", () => {
      state.style = STYLE_BY_UI[b.dataset.style] || "lofi";
      stop();
      rebuild();
      saveState();
      syncUI();
      showMsg("风格：" + STYLES[state.style].name);
    });
  });

  $("#seedInput").addEventListener("change", () => {
    const v = parseInt($("#seedInput").value, 10);
    if (!isNaN(v) && v > 0) {
      state.seed = v;
      stop();
      rebuild();
      saveState();
    }
  });

  $("#reseed").addEventListener("click", () => {
    state.seed = Math.floor(Math.random() * 900000) + 100000;
    $("#seedInput").value = String(state.seed);
    stop();
    rebuild();
    saveState();
    showMsg("换了种子：" + state.seed);
  });
}

$("#playBtn").addEventListener("click", () => {
  if (live) stop();
  else play().catch((e) => showMsg("播放失败：" + e.message, true));
});

$("#stopBtn").addEventListener("click", () => stop());

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "BUTTON")) return;
  e.preventDefault();
  if (live) stop();
  else play().catch((err) => showMsg("播放失败：" + err.message, true));
});

$("#exportWav").addEventListener("click", () => exportWav());
$("#vStyle").addEventListener("click", () => {
  VIZ.style = (VIZ.style + 1) % VIZ_NAMES.length;
  const el = $("#vStyle");
  if (el) el.textContent = "画风 · " + VIZ_NAMES[VIZ.style];
  if (live) showMsg("背景画风：" + VIZ_NAMES[VIZ.style]);
});
$("#vRec").addEventListener("click", () => startRec().catch((e) => showMsg("录制失败：" + e.message, true)));
$("#exportMidi").addEventListener("click", () => exportMidi());

loadState();
buildUI();
syncUI();
rebuild();
