/**
 * Horror Radio - Audio Engine
 * Web Audio API で効果音・環境音を鳴らす。2026-10〜 実録音素材(Freesound CC0, assets/sound/)に刷新
 *
 * 構成:
 *   ctx ── masterGain ─ destination
 *            ├─ sfxBus     (単発効果音)
 *            └─ ambientBus (環境音ループ: RAIN等。SILENCEで遮断される)
 */
const HorrorAudio = (() => {
    let ctx = null;
    let masterGain = null;
    let sfxBus = null;
    let ambientBus = null;
    let ambientNodes = []; // 停止用に保持しているループ音源
    let silenced = false;

    /** ユーザーインタラクション時に呼ぶ。iOS Safariの再生制限を解除する */
    function init() {
        if (ctx) return ctx;
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = ctx.createGain();
        masterGain.gain.value = 1.0;
        masterGain.connect(ctx.destination);

        sfxBus = ctx.createGain();
        sfxBus.connect(masterGain);

        ambientBus = ctx.createGain();
        ambientBus.gain.value = 1.0;
        ambientBus.connect(masterGain);

        if (ctx.state === 'suspended') ctx.resume();

        // 無音バッファを再生してコンテキストをアクティブ化
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(masterGain);
        src.start(0);
        return ctx;
    }

    function ensure() {
        if (!ctx) return false;
        if (ctx.state === 'suspended') ctx.resume();
        return true;
    }

    // ---- ユーティリティ ----------------------------------------------------

    function noiseBuffer(seconds) {
        const size = Math.floor(ctx.sampleRate * seconds);
        const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }

    // ---- 2026-10: 実録音の素材（Freesound CC0）を鳴らすエンジン ----------------
    // 素材は tools/process_sounds.py で種類ごとに音量(LUFS)を揃え済み。
    // ここでは毎回わずかに音の高さ・音量・左右をずらし、「同じ音の使い回し」に聞こえないようにする。
    const SOUND_BASE = "./assets/sound/";
    const buffers = new Map();
    const rnd = (a, b) => a + Math.random() * (b - a);
    const side = () => (Math.random() < 0.5 ? -1 : 1);

    // name: { pan: 左右の位置(関数), rate: 音の高さのゆらぎ幅, gain: 基本音量 }
    const SFX = {
        knock:    { pan: () => rnd(0.15, 0.55) * side(), rate: 0.03 },
        step:     { pan: () => 0,                        rate: 0.03 },   // コツッ（1歩）
        thump:    { pan: () => rnd(-0.3, 0.3),           rate: 0.04 },   // 落下音
        heartbeat:{ pan: () => 0,                        rate: 0.0 },
        static:   { pan: () => rnd(-0.2, 0.2),           rate: 0.05 },
        ringing:  { pan: () => 0,                        rate: 0.0 },
        voice:    { pan: () => rnd(0.4, 0.75) * side(),  rate: 0.03 },
        rain:     { pan: () => 0,                        rate: 0.03 },
        door:     { pan: () => rnd(0.2, 0.6) * side(),   rate: 0.04 },
        phone:    { pan: () => rnd(-0.3, 0.3),           rate: 0.0 },
        child:    { pan: () => rnd(0.3, 0.7) * side(),   rate: 0.02 },
        crossing: { pan: () => rnd(-0.4, 0.4),           rate: 0.0 },
        scratch:  { pan: () => rnd(0.65, 0.9) * side(),  rate: 0.05 },  // 片側から＝すぐ横にいる
        breath:   { pan: () => rnd(0.7, 0.95) * side(),  rate: 0.02 },  // 耳元
        water:    { pan: () => rnd(-0.6, 0.6),           rate: 0.08 },
        chime:    { pan: () => rnd(-0.3, 0.3),           rate: 0.0 }      // 夕方のチャイム（遠くの防災無線）
    };

    function loadBuffer(path) {
        if (!ctx) return Promise.resolve(null);
        if (buffers.has(path)) return buffers.get(path);
        const p = fetch(path)
            .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
            .then(ab => new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej)))
            .catch(() => null);
        buffers.set(path, p);
        return p;
    }

    /** 読み始めに、この話で使う効果音だけ先に読み込んでおく（鳴らす瞬間に遅れないように） */
    function preload(names) {
        (names || []).forEach(n => { if (SFX[n]) loadBuffer(SOUND_BASE + "sfx/" + n + ".mp3"); });
    }

    async function playSample(name, opt) {
        if (!ensure() || !SFX[name]) return;
        const buf = await loadBuffer(SOUND_BASE + "sfx/" + name + ".mp3");
        if (!buf) return;
        const o = SFX[name];
        const t = ctx.currentTime + 0.01 + ((opt && opt.delay) || 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        if (o.rate) src.playbackRate.value = 1 + rnd(-o.rate, o.rate);
        const gain = ctx.createGain();
        gain.gain.value = Math.pow(10, (rnd(-1.5, 1.0) + ((opt && opt.db) || 0)) / 20);   // ±1.5dBほどのゆらぎ
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        src.connect(gain);
        if (panner) { panner.pan.value = (opt && opt.pan != null) ? opt.pan : o.pan(); gain.connect(panner); panner.connect(sfxBus); }
        else gain.connect(sfxBus);
        src.start(t);
    }

    // ---- 公開API: 効果音（旧・合成音は2026-10に全廃） -----------------------
    const thump = () => playSample("thump");
    const staticNoise = () => playSample("static");
    const ringing = () => playSample("ringing");
    const voice = () => playSample("voice");
    const rain = () => playSample("rain");         // 雨が一気に強まる（環境音とは別に重ねる）
    const knock = () => playSample("knock");
    /** 足音：コツッ……コツッ……と約1秒間隔で数歩。少しずつ近づいてくる（だんだん大きく・中央へ） */
    function footstep(steps) {
        // 本文の擬音の数(「コツッ、コツッ、コツッ」→3)があればその歩数。無ければ4〜6歩
        const n = steps >= 2 ? Math.min(6, steps) : 4 + Math.floor(Math.random() * 3);
        const from = rnd(0.35, 0.6) * side();
        for (let i = 0; i < n; i++) {
            const k = i / (n - 1);
            playSample("step", { delay: i * rnd(0.96, 1.04), db: -6 + k * 6, pan: from * (1 - k) });
        }
    }
    const heartbeat = () => playSample("heartbeat");
    const door = () => playSample("door");
    const phone = () => playSample("phone");
    const child = () => playSample("child");
    const crossing = () => playSample("crossing");
    const scratch = () => playSample("scratch");
    const breath = () => playSample("breath");
    const water = () => playSample("water");
    const chime = () => playSample("chime");

    // ---- 公開API: 舞台の環境音（1話に1種類、小さくループ） ----------------
    const AMBIENCES = ["rain", "residential", "water", "forest", "tunnel", "room", "apartment", "hospital", "railway", "alley"];
    async function startAmbience(name, fadeSec = 4) {
        if (!ensure() || !AMBIENCES.includes(name)) return;
        const buf = await loadBuffer(SOUND_BASE + "amb/" + name + ".mp3");
        if (!buf) return;            // 無音中でも鳴らし始めておく(バスの音量で消えている。解けたら聞こえる)
        stopAmbient();
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(1.0, t + fadeSec);   // 気づいたら鳴っている
        src.connect(gain); gain.connect(ambientBus);
        src.start(t, Math.random() * buf.duration);                // 毎回ちがう位置から
        ambientNodes.push({ src, gain });
    }

    /** すべての環境音が突然「無音」になる（最大の違和感） */
    function silence() {
        if (!ensure()) return;
        silenced = true;
        const t = ctx.currentTime;
        ambientBus.gain.cancelScheduledValues(t);
        ambientBus.gain.setValueAtTime(ambientBus.gain.value, t);
        ambientBus.gain.linearRampToValueAtTime(0.0, t + 0.08); // ほぼ瞬断
    }

    /** 無音を解く：環境音をゆっくり戻す（「しん…」のあと、話が動き出したら） */
    function unsilence(seconds = 4) {
        if (!ctx || !silenced) return;
        silenced = false;
        const t = ctx.currentTime;
        ambientBus.gain.cancelScheduledValues(t);
        ambientBus.gain.setValueAtTime(Math.max(0.0001, ambientBus.gain.value), t);
        ambientBus.gain.exponentialRampToValueAtTime(1.0, t + seconds);
    }

    function stopAmbient() {
        ambientNodes.forEach(n => { try { n.src.stop(); } catch (e) { /* noop */ } });
        ambientNodes = [];
    }

    /** すべての音を即座に止める(ページ離脱・タブ非表示時に呼ぶ) */
    function stopAll() {
        try {
            stopAmbient();
            if (masterGain && ctx) {
                masterGain.gain.cancelScheduledValues(ctx.currentTime);
                masterGain.gain.setValueAtTime(0, ctx.currentTime);
            }
            if (ctx && ctx.state !== "closed") ctx.suspend();
        } catch (e) { /* noop */ }
    }

    /** すべての音をゆっくり消す(読了の余韻づくり)。stopAllと違い、滑らかにフェードアウトする。 */
    function fadeOut(seconds = 3) {
        try {
            if (!ctx || !masterGain) return;
            const t = ctx.currentTime;
            const s = Math.max(0.2, seconds);
            masterGain.gain.cancelScheduledValues(t);
            masterGain.gain.setValueAtTime(masterGain.gain.value, t);
            masterGain.gain.linearRampToValueAtTime(0.0001, t + s);
        } catch (e) { /* noop */ }
    }

    /** 復帰(タブが再表示されたとき) */
    function resumeAll() {
        try {
            if (ctx && ctx.state === "suspended") ctx.resume();
            if (masterGain && ctx) masterGain.gain.setValueAtTime(1.0, ctx.currentTime);
        } catch (e) { /* noop */ }
    }

    /** 蛍光灯がショートするような「バチッ」 */
    function spark() {
        if (!ensure()) return;
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, t);
        osc.frequency.exponentialRampToValueAtTime(800, t + 0.1);
        gain.gain.setValueAtTime(0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.01, t + 0.2);
        osc.connect(gain); gain.connect(sfxBus);
        osc.start(t); osc.stop(t + 0.2);
    }

    /** 街灯が点き直るときの小さな「チッ／ジッ」（ゆらぎと同期。ごく控えめ） */
    function lampTick(strength = 1) {
        if (!ensure()) return;
        const t = ctx.currentTime;
        const dur = 0.05 + Math.random() * 0.07;
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer(dur + 0.02);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2200 + Math.random() * 1800;
        bp.Q.value = 1.2;
        // 50/60Hzの電源うなりを少しだけ混ぜる
        const hum = ctx.createOscillator();
        hum.type = 'square';
        hum.frequency.value = Math.random() < 0.5 ? 100 : 120;
        const humGain = ctx.createGain();
        humGain.gain.setValueAtTime(0.012 * strength, t);
        humGain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.06 * strength, t + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(bp); bp.connect(gain); gain.connect(sfxBus);
        hum.connect(humGain); humGain.connect(sfxBus);
        src.start(t); src.stop(t + dur + 0.02);
        hum.start(t); hum.stop(t + dur + 0.08);
    }

    return {
        init, thump, staticNoise, ringing, voice, rain, lampTick,
        silence, knock, footstep, spark, stopAll, fadeOut, resumeAll,
        door, phone, child, crossing, scratch, breath, water, heartbeat, chime,
        preload, startAmbience, AMBIENCES, unsilence,
        get isSilenced() { return silenced; },
        get context() { return ctx; }
    };
})();
