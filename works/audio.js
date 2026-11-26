// 音の経路（制作ソフト・参加者のページで共通）
//
// 距離の扱いは、聴覚の距離知覚の手がかり（Kolarik et al. 2016）にそろえつつ、
// 各音の「距離(m)」「こもり(lpf)」「響き送り(reverbSend)」「方向(azimuth)」をユーザーが直接調整できるようにする。
//  ・音量：作品内でいちばん近い音を 0 dB 基準とし、距離が2倍になるごとに約6 dB下がる（逆二乗則）
//  ・高域・低域の距離変化：遠い音ほどローパス（空気吸収）とハイパス（近接低域の減衰）が強くかかる
//  ・直接音と残響の比（DRR）：近い音はドライ中心、遠い音ほど響きへの送り量を増やして奥行きを作る
//  ・全音源をモノラル化してから HRTF(PannerNode) に通す
(function () {
  'use strict';

  const dB = (v) => Math.pow(10, (Number(v) || 0) / 20);

  // 場所の響き（残響の長さと減衰の速さ）
  const SPACES = {
    open: { label: '開けた屋外（浜辺・畑）', seconds: 0.9, decay: 7.0, damp: 0.72 },
    street: { label: '建物に囲まれた屋外（街路・広場）', seconds: 1.5, decay: 4.2, damp: 0.65 },
    room: { label: '室内', seconds: 2.1, decay: 3.0, damp: 0.58 }
  };
  const DEFAULT_EFFECTS = { space: 'street', reverb: 0.5, diff: 15 };
  const EFFECTS = [
    { key: 'reverb', label: '響きの量', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'diff', label: '声と音の差', min: 0, max: 30, step: 1, fmt: (v) => '声が ' + Math.round(v) + ' dB 大きい' }
  ];

  const DIST_MIN = 1, DIST_MAX = 500;
  const OUT_GAIN_DB = -12; // 画面外の基準補正（距離減衰と合わせて背景に馴染む）
  const OUT_AZIMUTHS = [-75, 75, -115, 115, -150, 150, -95, 95, -135, 135];

  // 距離（m）に応じた自然なローパス周波数（Hz）：近い音は明瞭、遠い音は空気で高域が削れる
  const autoLpf = (d) => d <= 3 ? 18000 : Math.round(Math.max(850, 18000 * Math.pow(3 / d, 0.58)));
  // 距離（m）に応じたハイパス周波数（Hz）：遠い音ほど近接低域を削って「耳元の近さ」を消す
  const autoHpf = (d) => d <= 5 ? 30 : Math.min(280, Math.round(30 + (d - 5) * 1.5));
  // 距離（m）に応じた残響送り量（0〜1）：近い音はドライ、遠い音ほど響きに溶ける
  const autoSend = (d) => Math.min(0.65, 0.06 + 0.11 * Math.log(Math.max(1, d)));

  // 作品内でいちばん近い配置音の距離（m）を 0 dB の基準にする
  function refDistOf(work) {
    let min = Infinity;
    (work.sounds || []).forEach((s) => {
      if (s.pos && !s.mute) {
        const d = Math.min(DIST_MAX, Math.max(DIST_MIN, Number(s.dist) || 10));
        if (d < min) min = d;
      }
    });
    return isFinite(min) ? min : 10;
  }
  const distGain = (d, ref) => Math.min(2, (ref || 1) / Math.max(DIST_MIN, d || ref || 1));

  // 低域を残して高域を丸めた残響インパルス（ザーッという白ノイズ感を抑える）
  function impulse(ctx, space) {
    const s = SPACES[space] || SPACES.street;
    const len = Math.floor(ctx.sampleRate * s.seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const a = s.damp || 0.65;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const env = Math.exp(-s.decay * i / ctx.sampleRate);
        const w = (Math.random() * 2 - 1) * env;
        lp = lp * a + w * (1 - a);
        d[i] = lp * 0.45;
      }
    }
    return buf;
  }

  const LAYERS = ['in', 'out', 'off'];
  const layerOf = (s) => LAYERS.includes(s.layer) ? s.layer : (s.pos ? 'in' : 'out');
  const STATES = { walk: '歩く', near: '近づく', stop: '止まる', leave: '離れる' };
  const DEFAULT_STATES = { walk: { in: -12, out: -6, off: -12 }, near: { in: -3, out: -6, off: -6 }, stop: { in: 0, out: 0, off: 0 }, leave: { in: -12, out: -3, off: -6 } };
  function stateGains(work, state) {
    if (!state) return { in: 0, out: 0, off: 0 };
    const t = Object.assign({}, DEFAULT_STATES[state] || {}, ((work.interaction || {}).states || {})[state] || {});
    return { in: Number(t.in) || 0, out: Number(t.out) || 0, off: Number(t.off) || 0 };
  }

  const fx = (work) => Object.assign({}, DEFAULT_EFFECTS, work.effects || {});
  // 絵画上の位置 (x, y) と奥行き距離 (dist m) から 3D 空間座標 (X, Y, Z) を計算する
  // 水平 90°（±45°）・垂直 55° で展開。X: 右が正、Y: 上が正、Z: 奥が負
  function to3D(s, listener) {
    const d = Math.min(DIST_MAX, Math.max(DIST_MIN, Number(s.dist) || 10));
    const lx = listener ? listener.x : 0.5;
    const ly = 0.5;
    const az = ((s.pos.x - lx) * 90) * Math.PI / 180;
    const el = ((ly - s.pos.y) * 55) * Math.PI / 180;
    const P = {
      x: d * Math.cos(el) * Math.sin(az),
      y: d * Math.sin(el),
      z: -d * Math.cos(el) * Math.cos(az),
      dist: d
    };
    const lz = listener ? Number(listener.z) || 0 : 0;
    if (lz) { P.z += lz; P.dist = Math.max(DIST_MIN, Math.hypot(P.x, P.y, P.z)); }
    return P;
  }
  function direction(s, listener) { return to3D(s, listener); }

  function mask(cond, mutes) {
    const c = cond === 'picture' ? { voice: 0, sound: 0 }
      : cond === 'guide' ? { voice: 1, sound: 0 }
      : cond === 'sound' ? { voice: 0, sound: 1 }
      : { voice: 1, sound: 1 };
    return { voice: c.voice * (mutes.voice ? 0 : 1), sound: c.sound * (mutes.sound ? 0 : 1) };
  }

  function makeMonoPanner(ctx) {
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'linear';
    pan.rolloffFactor = 0; // 距離の減衰は自前の GainNode で行う
    pan.channelCount = 1;
    pan.channelCountMode = 'explicit';
    mono.connect(pan);
    return { mono, pan };
  }

  function build(ctx, work, buffers, opt) {
    const e = fx(work);
    const g = { sources: [], nodes: [] };
    g.limiter = ctx.createDynamicsCompressor();
    g.limiter.threshold.value = -3;
    g.limiter.knee.value = 6;
    g.limiter.ratio.value = 12;
    g.limiter.attack.value = 0.003;
    g.limiter.release.value = 0.15;
    g.master = ctx.createGain();
    g.master.connect(g.limiter);
    g.limiter.connect(ctx.destination);

    g.conv = ctx.createConvolver(); g.conv.buffer = impulse(ctx, e.space);
    g.wet = ctx.createGain(); g.conv.connect(g.wet); g.wet.connect(g.master);
    g.sound = ctx.createGain(); g.sound.connect(g.master);
    g.voice = ctx.createGain(); g.voice.connect(g.master);
    g.layers = {};
    LAYERS.forEach((k) => { g.layers[k] = ctx.createGain(); g.layers[k].connect(g.sound); });
    const horizon = opt.horizon || 600;

    const start = (buf, loop, dest, from, to, when) => {
      const s = ctx.createBufferSource();
      const a = Math.max(0, Math.min(Number(from) || 0, buf.duration - 0.01));
      const b = Number(to) > a ? Math.min(Number(to), buf.duration) : buf.duration;
      s.buffer = buf; s.loop = loop; s.connect(dest);
      if (loop) { s.loopStart = a; s.loopEnd = b; }
      g.sources.push({ node: s, offset: a, dur: loop ? undefined : b - a, when: when || 0 });
      return b - a;
    };
    g.loops = g.loops || [];
    const xloop = (buf, dest, from, to) => {
      const a = Math.max(0, Math.min(Number(from) || 0, buf.duration - 0.01));
      const b = Number(to) > a ? Math.min(Number(to), buf.duration) : buf.duration;
      const L = b - a, xf = Math.min(2, Math.max(0.3, L * 0.25));
      if (L < xf * 2 + 0.05) { start(buf, true, dest, from, to); return; }
      g.loops.push({ buf, dest, a, L, xf, step: L - xf, next: 0, first: true });
    };
    const events = (buf, s, dest) => {
      const rate = Math.max(0.1, Number(s.rate) || 2);
      let t = Math.random() * 60 / rate, n = 0;
      while (t < horizon && n < 400) { start(buf, false, dest, s.start, s.end, t); t += -Math.log(1 - Math.random()) * 60 / rate; n++; }
    };

    let outIdx = 0;
    (work.sounds || []).forEach((s) => {
      const buf = buffers.get(s.file);
      if (!buf) return;
      const vol = ctx.createGain();
      const near = ctx.createGain();
      const { mono, pan } = makeMonoPanner(ctx);
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.Q.value = 0.7;
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.Q.value = 0.7;
      const send = ctx.createGain();
      vol.connect(hpf);
      hpf.connect(lpf);
      lpf.connect(near);
      near.connect(mono);
      pan.connect(g.layers[layerOf(s)]);
      // フィルター後の音を距離に応じた量で残響へ送る（遠い音ほど響きに溶ける）
      lpf.connect(send);
      send.connect(g.conv);

      const n = { s, vol, near, pan, hpf, lpf, send, outDefaultAz: null };
      if (!s.pos) {
        n.outDefaultAz = OUT_AZIMUTHS[outIdx % OUT_AZIMUTHS.length];
        outIdx++;
      }
      if (s.mode === 'events') events(buf, s, vol); else xloop(buf, vol, s.start, s.end);
      g.nodes.push(n);
    });

    if (work.guide && work.guide.file && buffers.get(work.guide.file)) {
      const vol = ctx.createGain(); vol.connect(g.voice);
      start(buffers.get(work.guide.file), opt.loopGuide !== false, vol, work.guide.start, work.guide.end);
    }
    update(ctx, g, work, opt, true);
    // 動く音：3D空間上の位置1と位置2のあいだを、周期（秒）で行き来する
    g.nodes.forEach((n) => {
      const s = n.s;
      if (!s.pos || !n.pan || !s.move || !s.pos2 || !n.pan.positionX) return;
      const T = Math.max(1, Number(s.period) || 10) / 2;
      const A = to3D(s, opt.listener), B = to3D({ pos: s.pos2, dist: s.dist }, opt.listener);
      const t0 = ctx.currentTime;
      for (let i = 0, t = 0; t < horizon; i++, t += T) {
        const P = i % 2 ? A : B;
        n.pan.positionX.linearRampToValueAtTime(P.x, t0 + t + T);
        n.pan.positionY.linearRampToValueAtTime(P.y, t0 + t + T);
        n.pan.positionZ.linearRampToValueAtTime(P.z, t0 + t + T);
      }
    });
    return g;
  }

  function update(ctx, g, work, opt, immediate) {
    const e = fx(work);
    const t = ctx.currentTime;
    const set = (p, v) => immediate ? (p.value = v) : p.setTargetAtTime(v, t, 0.05);
    const m = mask(opt.cond, opt.mutes || {});
    const soundBase = m.voice ? dB(-e.diff) : dB(-3);
    set(g.voice.gain, dB(work.guide && work.guide.gain) * m.voice);
    set(g.sound.gain, soundBase * m.sound);
    const st = stateGains(work, opt.state);
    LAYERS.forEach((k) => set(g.layers[k].gain, dB(st[k])));
    set(g.wet.gain, e.reverb * 0.32 * soundBase * m.sound * dB(st.off));

    const L = ctx.listener, h = (Number(opt.heading) || 0) * Math.PI / 180;
    if (L.forwardX) { set(L.forwardX, Math.sin(h)); set(L.forwardY, 0); set(L.forwardZ, -Math.cos(h)); set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0); }
    else if (L.setOrientation) L.setOrientation(Math.sin(h), 0, -Math.cos(h), 0, 1, 0);

    const solo = (work.sounds || []).some((s) => s.solo && !s.mute);
    const ref = refDistOf(work);
    g.nodes.forEach((n) => {
      const s = n.s;
      const on = s.mute ? 0 : (!solo || s.solo ? 1 : 0);
      set(n.vol.gain, dB(s.gain) * on);

      let d, px, py, pz;
      if (s.pos) {
        const P = to3D(s, opt.listener);
        d = Math.min(DIST_MAX, Math.max(DIST_MIN, P.dist));
        px = P.x; py = P.y; pz = P.z;
        set(n.near.gain, distGain(d, ref));
      } else {
        d = Math.min(DIST_MAX, Math.max(DIST_MIN, Number(s.dist) || 35));
        const deg = s.azimuth != null && s.azimuth !== '' ? Number(s.azimuth) : (n.outDefaultAz || 90);
        const rad = deg * Math.PI / 180;
        px = d * Math.sin(rad); py = 0.5; pz = -d * Math.cos(rad);
        set(n.near.gain, distGain(d, ref) * dB(OUT_GAIN_DB));
      }

      if (s.pos && s.move && s.pos2 && !immediate) { /* 動く音の位置は build で決めた動きに任せる */ }
      else if (n.pan.positionX) { set(n.pan.positionX, px); set(n.pan.positionY, py); set(n.pan.positionZ, pz); }
      else n.pan.setPosition(px, py, pz);

      const lpfHz = Number(s.lpf) > 0 ? Number(s.lpf) : autoLpf(d);
      const hpfHz = autoHpf(d);
      const sendVal = s.reverbSend != null && s.reverbSend !== '' ? Number(s.reverbSend) : autoSend(d);
      set(n.lpf.frequency, lpfHz);
      set(n.hpf.frequency, hpfHz);
      set(n.send.gain, sendVal * (s.pos ? 1 : dB(OUT_GAIN_DB)));
    });
  }

  const FADE_IN = new Float32Array(32).map((_, i) => Math.sin((i / 31) * Math.PI / 2));
  const FADE_OUT = new Float32Array(32).map((_, i) => Math.cos((i / 31) * Math.PI / 2));
  function scheduleLoops(ctx, g, until) {
    (g.loops || []).forEach((lp) => {
      while (lp.next < until) {
        const src = ctx.createBufferSource(); src.buffer = lp.buf;
        const env = ctx.createGain(); src.connect(env); env.connect(lp.dest);
        const t = lp.next;
        if (lp.first) env.gain.setValueAtTime(1, t); else { env.gain.setValueAtTime(0, t); env.gain.setValueCurveAtTime(FADE_IN, t, lp.xf); }
        env.gain.setValueCurveAtTime(FADE_OUT, t + lp.L - lp.xf, lp.xf);
        src.start(t, lp.a, lp.L);
        g.live = (g.live || []).filter((x) => x.end > ctx.currentTime); g.live.push({ node: src, end: t + lp.L });
        lp.first = false; lp.next += lp.step;
      }
    });
  }
  class Engine {
    constructor() { this.ctx = null; this.graph = null; this.buffers = new Map(); }
    ensure() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; }
    async decode(name, ab) { const b = await this.ensure().decodeAudioData(ab); this.buffers.set(name, b); return b; }
    async load(name, url) {
      if (this.buffers.has(name)) return this.buffers.get(name);
      const r = await fetch(url);
      if (!r.ok) throw new Error('音を読めませんでした：' + name);
      return this.decode(name, await r.arrayBuffer());
    }
    get playing() { return !!this.graph; }
    play(work, opt) {
      const ctx = this.ensure();
      if (ctx.state === 'suspended') ctx.resume();
      this.stop();
      this.graph = build(ctx, work, this.buffers, opt);
      const t0 = ctx.currentTime + 0.05;
      this.graph.sources.forEach((s) => s.dur === undefined ? s.node.start(t0, s.offset) : s.node.start(t0 + s.when, s.offset, s.dur));
      const g = this.graph;
      (g.loops || []).forEach((lp) => { lp.next = t0; lp.first = true; });
      scheduleLoops(ctx, g, t0 + 4);
      g.timer = setInterval(() => scheduleLoops(ctx, g, ctx.currentTime + 4), 500);
    }
    stop() {
      if (!this.graph) return;
      clearInterval(this.graph.timer);
      (this.graph.live || []).forEach((s) => { try { s.node.stop(); } catch (e) { } });
      this.graph.sources.forEach((s) => { try { s.node.stop(); } catch (e) { } });
      this.graph.master.disconnect();
      this.graph = null;
    }
    update(work, opt) { if (this.graph) update(this.ctx, this.graph, work, opt, false); }
    async render(work, opt, seconds) {
      const sr = 48000, out = {};
      const w = Object.assign({}, work, { sounds: (work.sounds || []).map((s) => Object.assign({}, s, { solo: false })) });
      const runs = { mix: { cond: 'all', mutes: {} }, guide: { cond: 'guide', mutes: {} }, sounds: { cond: 'all', mutes: { voice: true } } };
      for (const [name, r] of Object.entries(runs)) {
        const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);
        const g = build(ctx, w, this.buffers, Object.assign({}, opt, r, { loopGuide: false, horizon: seconds }));
        g.sources.forEach((s) => s.dur === undefined ? s.node.start(0, s.offset) : s.node.start(s.when, s.offset, s.dur));
        scheduleLoops(ctx, g, seconds);
        out[name] = await ctx.startRendering();
      }
      out.measured = rmsDb(out.guide) - rmsDb(out.sounds);
      return out;
    }
  }

  function rmsDb(buf) {
    let sum = 0, n = 0;
    const blk = 4800;
    for (let i = 0; i + blk <= buf.length; i += blk) {
      let s = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let j = i; j < i + blk; j++) s += d[j] * d[j]; }
      s /= blk * buf.numberOfChannels;
      if (s > 1e-7) { sum += s; n++; }
    }
    return n ? 10 * Math.log10(sum / n) : -Infinity;
  }

  function toWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([data], { type: 'audio/wav' });
  }

  window.Engine = Engine;
  window.SENSOR = { tiltX: 0.25, depthMax: 0.5 };
  window.toWav = toWav;
  window.to3D = to3D;
  window.autoLpf = autoLpf;
  window.autoSend = autoSend;
  window.EFFECTS = EFFECTS;
  window.SPACES = SPACES;
  window.DEFAULT_EFFECTS = DEFAULT_EFFECTS;
  window.DIST = { min: DIST_MIN, max: DIST_MAX };
  window.STATES = STATES;
  window.DEFAULT_STATES = DEFAULT_STATES;
})();
