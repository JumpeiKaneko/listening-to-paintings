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
  const DEFAULT_EFFECTS = { space: 'street', reverb: 0.5, diff: 15, out: -18 };
  // out：絵に置かない音（画面外）の音量（dB）。絵に置いた音のうちいちばん近い音を 0 dB とした値。仮の値
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

  // 画面外の音を置く方向（度）。画角（±30°）の外に、左右交互に散らす
  const OUT_AZ = [-70, 70, -120, 120, -160, 160, -95, 95];
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
    const c = cond === 'picture' ? { voice: 0, sound: 0 } : cond === 'guide' ? { voice: 1, sound: 0 } : cond === 'sound' ? { voice: 0, sound: 1 } : { voice: 1, sound: 1 };
    return { voice: c.voice * (mutes.voice ? 0 : 1), sound: c.sound * (mutes.sound ? 0 : 1) };
  }

  function build(ctx, work, buffers, opt) {
    const e = fx(work);
    const g = { sources: [], nodes: [] };
    g.master = ctx.createGain();
    // 音が重なって割れないように、最後に軽くリミッターをかける
    g.limit = ctx.createDynamicsCompressor(); g.limit.threshold.value = -6; g.limit.knee.value = 6; g.limit.ratio.value = 8; g.limit.attack.value = 0.003; g.limit.release.value = 0.25;
    g.master.connect(g.limit); g.limit.connect(ctx.destination);
    // 距離の基準：絵に置いた音のうちいちばん近い音を 0 dB にする（そこから距離が2倍ごとに -6 dB）
    g.dref = Math.max(DIST_MIN, Math.min.apply(null, (work.sounds || []).filter((s) => s.pos && !s.mute).map((s) => Number(s.dist) || 10).concat([DIST_MAX])));
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
    // 続けて鳴る音：同じ音を2つ重ね、つなぎ目をクロスフェード（等パワー）でつないでループする。
    // 重ねる長さは音の長さの1/4（0.3〜2秒）。3秒の音なら0.75秒、20秒の音なら2秒
    g.loops = g.loops || [];
    const xloop = (buf, dest, from, to) => {
      const a = Math.max(0, Math.min(Number(from) || 0, buf.duration - 0.01));
      const b = Number(to) > a ? Math.min(Number(to), buf.duration) : buf.duration;
      const L = b - a, xf = Math.min(2, Math.max(0.3, L * 0.25));
      if (L < xf * 2 + 0.05) { start(buf, true, dest, from, to); return; } // 短すぎる音はそのままループ
      g.loops.push({ buf, dest, a, L, xf, step: L - xf, next: 0, first: true });
    };
    // ときどき鳴る音：1分あたりの回数を平均に、間隔をばらつかせて（指数分布）鳴らす
    const events = (buf, s, dest) => {
      const rate = Math.max(0.1, Number(s.rate) || 2);
      let t = Math.random() * 60 / rate, n = 0;
      while (t < horizon && n < 400) { start(buf, false, dest, s.start, s.end, t); t += -Math.log(1 - Math.random()) * 60 / rate; n++; }
    };

    let outIndex = 0;
    (work.sounds || []).forEach((s) => {
      const buf = buffers.get(s.file);
      if (!buf || s.mute) return;
      const vol = ctx.createGain();
      const send = ctx.createGain(); vol.connect(send); send.connect(g.conv);
      const n = { s, vol, send };
      if (!s.pos) send.gain.value = dB(e.out);
      if (s.pos) {
        const near = ctx.createGain();
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.rolloffFactor = 0; // 距離の減衰は near で行う
        // 立体に置く音はモノラルにしてから方向をつける（ステレオのままだと元の左右の広がりが残り、方向がにじむ）
        near.channelCount = 1; near.channelCountMode = 'explicit'; near.channelInterpretation = 'speakers';
        pan.channelCount = 1; pan.channelCountMode = 'explicit';
        const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 4000;
        vol.connect(near); near.connect(pan); pan.connect(air); air.connect(g.layers[layerOf(s)]);
        Object.assign(n, { near, pan, air });
      } else {
        // 画面外の音：方向の記録がないものが多いので、方向はつけずに遠くの音として扱う（高域を少し落とし、音量を out に）
        // 画面外の音：絵の外側（画角の外：左右・後ろ）に方向をつけて置く。s.az（度。右が正、180 が真後ろ）があればその方向、なければ順に散らす
        const far = ctx.createGain();
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.rolloffFactor = 0;
        far.channelCount = 1; far.channelCountMode = 'explicit'; far.channelInterpretation = 'speakers';
        pan.channelCount = 1; pan.channelCountMode = 'explicit';
        const az = (Number.isFinite(Number(s.az)) && s.az !== '' && s.az !== null ? Number(s.az) : OUT_AZ[outIndex++ % OUT_AZ.length]) * Math.PI / 180;
        const X = 10 * Math.sin(az), Z = -10 * Math.cos(az);
        if (pan.positionX) { pan.positionX.value = X; pan.positionY.value = 0; pan.positionZ.value = Z; } else pan.setPosition(X, 0, Z);
        const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 3000; air.gain.value = -6;
        vol.connect(far); far.connect(pan); pan.connect(air); air.connect(g.layers[layerOf(s)]);
        Object.assign(n, { far });
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
    set(g.wet.gain, e.reverb * 0.25 * dB(-e.diff) * m.sound * dB(st.off));
    // スマホを向けた方向（度）。聴く人の向きを回すので、音は絵の構図の位置に残る
    const L = ctx.listener, h = (Number(opt.heading) || 0) * Math.PI / 180;
    if (L.forwardX) { set(L.forwardX, Math.sin(h)); set(L.forwardY, 0); set(L.forwardZ, -Math.cos(h)); set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0); }
    else if (L.setOrientation) L.setOrientation(Math.sin(h), 0, -Math.cos(h), 0, 1, 0);
    const solo = (work.sounds || []).some((s) => s.solo);
    g.nodes.forEach((n) => {
      const on = !solo || n.s.solo ? 1 : 0;
      set(n.vol.gain, dB(n.s.gain) * on);
      if (n.far) set(n.far.gain, dB(e.out));
      if (n.pan) {
        const P = to3D(n.s, opt.listener);
        const d = Math.min(DIST_MAX, Math.max(DIST_MIN, P.dist));
        set(n.near.gain, distGain(d) / distGain(g.dref || 1));
        if (n.s.move && n.s.pos2 && !immediate) { /* 動く音の位置は build で決めた動きに任せる */ }
        else if (n.pan.positionX) { set(n.pan.positionX, P.x); set(n.pan.positionY, P.y); set(n.pan.positionZ, P.z); } else n.pan.setPosition(P.x, P.y, P.z);
        set(n.air.gain, airLoss(d));
      }
    });
  }


  // クロスフェードのループを、時刻 until まで並べる（再生中は少しずつ先へ、書き出しでは最後まで）
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
      this.graph.master.disconnect(); this.graph.limit.disconnect();
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
        scheduleLoops(ctx, g, seconds);
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
