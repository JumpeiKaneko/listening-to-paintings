// 音の経路（制作ソフト・参加者のページで共通）
//
// 距離の扱いは、聴覚の距離知覚の手がかり（Kolarik et al. 2016）にそろえる。
//  ・音量：直接音は距離が2倍になるごとに約6 dB下がる（逆二乗則）
//  ・直接音と残響の比（DRR）：残響は距離によらずほぼ一定、直接音だけが距離で下がる。そのため遠い音ほど響きの割合が増える
//  ・スペクトル：15 mより遠い音だけ、空気で高域が削れる（1〜15 mでは手がかりにならない）
// 声と音の差は、テレビの解説と背景音の研究（Torcoli et al. 2019）の推奨（環境音に対して少なくとも15 LU）を初期値にする。
//
// 絵に置いた音：音源 → 音量 → 距離の減衰(1/d) → 方向(HRTF) → 空気の高域減衰 → 音の母線
//                      └→ 響きへ（距離で減衰しない）
// 絵に置かない音（その場全体の音）：音源 → 音量 → 音の母線 ／ 響きへ
// 声：音源 → 音量 → 声の母線
(function () {
  'use strict';

  const dB = (v) => Math.pow(10, (Number(v) || 0) / 20);

  // 場所の響き（残響の長さと減衰の速さ）。値は仮。測ったインパルス応答に替えられる
  const SPACES = {
    open: { label: '開けた屋外（浜辺・畑）', seconds: 1.2, decay: 5.5 },
    street: { label: '建物に囲まれた屋外（街路・広場）', seconds: 2.0, decay: 3.2 },
    room: { label: '室内', seconds: 2.6, decay: 2.4 }
  };
  const DEFAULT_EFFECTS = { space: 'street', reverb: 0.5, diff: 15 };
  // 参加者が動かせる項目
  const EFFECTS = [
    { key: 'reverb', label: '響きの量', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + '%' },
    { key: 'diff', label: '声と音の差', min: 0, max: 30, step: 1, fmt: (v) => '声が ' + Math.round(v) + ' dB 大きい' }
  ];

  // 距離（m）→ 空気による高域の減衰（dB、4 kHz より上）。15 m までは0。係数は仮の値
  const airLoss = (d) => d > 15 ? -Math.min(24, 0.05 * (d - 15)) : 0;
  const distGain = (d) => 1 / Math.max(1, d || 1);   // 1 m を基準に、2倍ごとに -6 dB
  const DIST_MIN = 1, DIST_MAX = 500;

  function impulse(ctx, space) {
    const s = SPACES[space] || SPACES.street;
    const len = Math.floor(ctx.sampleRate * s.seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-s.decay * i / ctx.sampleRate) * 0.5;
    }
    return buf;
  }

  // 音の4つの層のうち、音を持つ3つ（インタラクションは層の鳴り方を決める）
  const LAYERS = ['in', 'out', 'off'];
  const layerOf = (s) => LAYERS.includes(s.layer) ? s.layer : (s.pos ? 'in' : 'out');
  // ビーコンの4状態。値は層ごとの音量（dB）
  const STATES = { walk: '歩く', near: '近づく', stop: '止まる', leave: '離れる' };
  const DEFAULT_STATES = { walk: { in: -12, out: -6, off: -12 }, near: { in: -3, out: -6, off: -6 }, stop: { in: 0, out: 0, off: 0 }, leave: { in: -12, out: -3, off: -6 } };
  function stateGains(work, state) {
    if (!state) return { in: 0, out: 0, off: 0 };
    const t = Object.assign({}, DEFAULT_STATES[state] || {}, ((work.interaction || {}).states || {})[state] || {});
    return { in: Number(t.in) || 0, out: Number(t.out) || 0, off: Number(t.off) || 0 };
  }

  const fx = (work) => Object.assign({}, DEFAULT_EFFECTS, work.effects || {});
  // 絵画上の位置 (x, y) と奥行き距離 (dist m) から、画家の視点 (0, 0, 0) を原点とする 3D 空間座標 (X, Y, Z) を計算する
  // 水平視野角 60°・垂直視野角 45°。X: 右が正、Y: 上が正、Z: 奥が負（Web Audio API / Unity 準拠）
  function to3D(s, listener) {
    const d = Math.min(DIST_MAX, Math.max(DIST_MIN, Number(s.dist) || 10));
    const lx = listener ? listener.x : 0.5;
    const ly = 0.5;
    const az = ((s.pos.x - lx) * 60) * Math.PI / 180;
    const el = ((ly - s.pos.y) * 45) * Math.PI / 180;
    const P = {
      x: d * Math.cos(el) * Math.sin(az),
      y: d * Math.sin(el),
      z: -d * Math.cos(el) * Math.cos(az),
      dist: d
    };
    // 聴く点を絵の奥へ進める（listener.z：画家の視点から奥へ何 m 進んだか）。進んだぶん、音までの距離が変わる
    const lz = listener ? Number(listener.z) || 0 : 0;
    if (lz) { P.z += lz; P.dist = Math.max(DIST_MIN, Math.hypot(P.x, P.y, P.z)); }
    return P;
  }
  function direction(s, listener) { return to3D(s, listener); }

  function mask(cond, mutes) {
    const c = cond === 'picture' ? { voice: 0, sound: 0 } : cond === 'guide' ? { voice: 1, sound: 0 } : { voice: 1, sound: 1 };
    return { voice: c.voice * (mutes.voice ? 0 : 1), sound: c.sound * (mutes.sound ? 0 : 1) };
  }

  function build(ctx, work, buffers, opt) {
    const e = fx(work);
    const g = { sources: [], nodes: [] };
    g.master = ctx.createGain(); g.master.connect(ctx.destination);
    g.conv = ctx.createConvolver(); g.conv.buffer = impulse(ctx, e.space);
    g.wet = ctx.createGain(); g.conv.connect(g.wet); g.wet.connect(g.master);
    g.sound = ctx.createGain(); g.sound.connect(g.master);
    g.voice = ctx.createGain(); g.voice.connect(g.master);
    // 層ごとの音量（インタラクションの状態で変える）
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
    // ときどき鳴る音：1分あたりの回数を平均に、間隔をばらつかせて（指数分布）鳴らす
    const events = (buf, s, dest) => {
      const rate = Math.max(0.1, Number(s.rate) || 2);
      let t = Math.random() * 60 / rate, n = 0;
      while (t < horizon && n < 400) { start(buf, false, dest, s.start, s.end, t); t += -Math.log(1 - Math.random()) * 60 / rate; n++; }
    };

    (work.sounds || []).forEach((s) => {
      const buf = buffers.get(s.file);
      if (!buf || s.mute) return;
      const vol = ctx.createGain();
      const send = ctx.createGain(); vol.connect(send); send.connect(g.conv);
      const n = { s, vol, send };
      if (s.pos) {
        const near = ctx.createGain();
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.rolloffFactor = 0; // 距離の減衰は near で行う
        const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 4000;
        vol.connect(near); near.connect(pan); pan.connect(air); air.connect(g.layers[layerOf(s)]);
        Object.assign(n, { near, pan, air });
      } else vol.connect(g.layers[layerOf(s)]);
      if (s.mode === 'events') events(buf, s, vol); else start(buf, true, vol, s.start, s.end);
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
      if (!n.pan || !s.move || !s.pos2 || !n.pan.positionX) return;
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
    set(g.voice.gain, dB(work.guide && work.guide.gain) * m.voice);
    set(g.sound.gain, dB(-e.diff) * m.sound);
    const st = stateGains(work, opt.state);
    LAYERS.forEach((k) => set(g.layers[k].gain, dB(st[k])));
    set(g.wet.gain, e.reverb * 0.6 * dB(-e.diff) * m.sound * dB(st.off));
    // スマホを向けた方向（度）。聴く人の向きを回すので、音は絵の構図の位置に残る
    const L = ctx.listener, h = (Number(opt.heading) || 0) * Math.PI / 180;
    if (L.forwardX) { set(L.forwardX, Math.sin(h)); set(L.forwardY, 0); set(L.forwardZ, -Math.cos(h)); set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0); }
    else if (L.setOrientation) L.setOrientation(Math.sin(h), 0, -Math.cos(h), 0, 1, 0);
    const solo = (work.sounds || []).some((s) => s.solo);
    g.nodes.forEach((n) => {
      const on = !solo || n.s.solo ? 1 : 0;
      set(n.vol.gain, dB(n.s.gain) * on);
      if (n.pan) {
        const P = to3D(n.s, opt.listener);
        const d = Math.min(DIST_MAX, Math.max(DIST_MIN, P.dist));
        set(n.near.gain, distGain(d));
        if (n.s.move && n.s.pos2 && !immediate) { /* 動く音の位置は build で決めた動きに任せる */ }
        else if (n.pan.positionX) { set(n.pan.positionX, P.x); set(n.pan.positionY, P.y); set(n.pan.positionZ, P.z); } else n.pan.setPosition(P.x, P.y, P.z);
        set(n.air.gain, airLoss(d));
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
    }
    stop() {
      if (!this.graph) return;
      this.graph.sources.forEach((s) => { try { s.node.stop(); } catch (e) { } });
      this.graph.master.disconnect();
      this.graph = null;
    }
    update(work, opt) { if (this.graph) update(this.ctx, this.graph, work, opt, false); }
    // 全体・声だけ・音だけを書き出す。声と音の実際の差（RMS）も返す
    async render(work, opt, seconds) {
      const sr = 48000, out = {};
      const w = Object.assign({}, work, { sounds: (work.sounds || []).map((s) => Object.assign({}, s, { solo: false })) });
      const runs = { mix: { cond: 'all', mutes: {} }, guide: { cond: 'guide', mutes: {} }, sounds: { cond: 'all', mutes: { voice: true } } };
      for (const [name, r] of Object.entries(runs)) {
        const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);
        const g = build(ctx, w, this.buffers, Object.assign({}, opt, r, { loopGuide: false, horizon: seconds }));
        g.sources.forEach((s) => s.dur === undefined ? s.node.start(0, s.offset) : s.node.start(s.when, s.offset, s.dur));
        out[name] = await ctx.startRendering();
      }
      out.measured = rmsDb(out.guide) - rmsDb(out.sounds);
      return out;
    }
  }

  // 無音の部分を除いたRMS（dB）。声と音の差の実測の目安
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
  window.SENSOR = { tiltX: 0.25, depthMax: 0.5 }; // 傾きで動く幅：左右は絵の幅の±25%、奥へは置いた音のうちいちばん遠いもの（150 m まで）の半分。前に30°傾けると、画家の目の位置から絵の中へそこまで進む
  window.toWav = toWav;
  window.to3D = to3D;
  window.EFFECTS = EFFECTS;
  window.SPACES = SPACES;
  window.DEFAULT_EFFECTS = DEFAULT_EFFECTS;
  window.DIST = { min: DIST_MIN, max: DIST_MAX };
  window.STATES = STATES;
  window.DEFAULT_STATES = DEFAULT_STATES;
})();
