/**
 * イマココ怪談 - 街灯のゆらぎ（読書画面）
 *
 * 背景（ループ動画 or 画像）の上に薄い「暗幕」を1枚重ね、その濃さを毎フレーム変えて
 * 天井の灯りが生きているように見せる。本文も同じ暗幕の下にあるので、灯りが落ちると文字も沈む。
 *
 *  - 常時：ごく小さな電圧のゆらぎ（±数%）
 *  - ときどき：一瞬の瞬き / ジジッと数回またたく / ふっと消えて戻る
 *    発生間隔はランダム（指数分布）。決まった周期・回数は持たない。何も起きない時間もある。
 *  - 外部（怖い演出）から sequence() で任意の明滅を流し、暗転・点灯の瞬間にフックできる。
 *
 * 公開API: window.ImakokoLamp = { start, stop, pause, resume, event, sequence, level }
 */
(function () {
    "use strict";

    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // 怖さ設定ごとの「平均の待ち時間（秒）」と出来事の比率。平均のまわりで毎回ランダムに揺れる
    const LEVEL = (() => { try { return (window.ImakokoSettings && ImakokoSettings.scareLevel()) || "standard"; } catch (e) { return "standard"; } })();
    const TUNE = {
        mild:     { gap: 16, dip: 1.0,  stutter: 0,    soft: true },    // 一瞬暗くなるだけ（明滅しない）
        standard: { gap: 11, dip: 0.55, stutter: 0.88, soft: false },
        intense:  { gap: 7,  dip: 0.35, stutter: 0.8,  soft: false }
    }[LEVEL] || { gap: 11, dip: 0.55, stutter: 0.88, soft: false };
    const MEAN_GAP = TUNE.gap;
    const MIN_GAP = 2.5;

    let dim = null;           // 暗幕
    let raf = 0;
    let running = false;
    let paused = false;
    let timer = 0;
    let noise = 0;            // 常時ゆらぎ（ランダムウォーク）
    let override = null;      // sequence 再生中の明るさ（null=通常）
    let busy = false;         // sequence 再生中
    let current = 1;

    const rand = (a, b) => a + Math.random() * (b - a);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    function ensureDim() {
        if (dim) return dim;
        dim = document.getElementById("lamp-dim");
        if (!dim) {
            dim = document.createElement("div");
            dim.id = "lamp-dim";
            dim.setAttribute("aria-hidden", "true");
            document.body.appendChild(dim);
        }
        return dim;
    }

    function frame(t) {
        if (!running) return;
        raf = requestAnimationFrame(frame);
        // 常時のゆらぎ：小さなランダムウォーク＋ごく遅い呼吸
        noise += (Math.random() - 0.5) * 0.03;
        noise *= 0.95;
        const breath = Math.sin(t / 1000 * 0.9) * 0.018 + Math.sin(t / 1000 * 2.3) * 0.01;
        const base = 1 + noise + breath;
        const lv = override == null ? base : override * (0.97 + noise);
        current = Math.max(0, Math.min(1.05, lv));
        // 明るさ1で暗幕0、明るさ0でほぼ真っ暗（文字がかすかに残る程度）
        // 普段から薄く(7%)暗幕をかけておき、その上下でゆらす（明るい側に振れても揺れが見えるように）
        dim.style.opacity = String(Math.max(0, Math.min(0.95, 0.07 + (1 - current) * 0.88)));
    }

    /**
     * 明滅の台本を流す。steps = [[明るさ0〜1, 保持ms], ...]
     * hooks.onDark(i) / hooks.onLight(i) は、暗転・点灯へ切り替わった瞬間に呼ばれる。
     */
    async function sequence(steps, hooks) {
        if (!running) return;
        busy = true;
        let prevDark = false;
        for (let i = 0; i < steps.length; i++) {
            const [lv, ms] = steps[i];
            override = lv;
            const dark = lv < 0.35;
            if (dark !== prevDark) {
                try { (dark ? hooks?.onDark : hooks?.onLight)?.(i); } catch (e) { /* noop */ }
                if (!dark && window.HorrorAudio?.lampTick) HorrorAudio.lampTick(0.5 + Math.random() * 0.5);
                prevDark = dark;
            }
            await sleep(ms);
        }
        override = null;
        busy = false;
    }

    // ---- 自然に起きる出来事（台本はその場でランダムに組み立てる） ----
    function dip() {          // 一瞬だけ電圧が落ちる
        const d = rand(0.55, 0.85);
        return [[d, rand(50, 110)], [rand(0.9, 1), rand(60, 140)]];
    }
    function stutter() {      // ジジッと数回またたく
        const n = 2 + Math.floor(Math.random() * 4);
        const s = [];
        for (let i = 0; i < n; i++) {
            s.push([rand(0.08, 0.4), rand(70, 140)]);
            s.push([rand(0.75, 1), rand(70, 200)]);
        }
        return s;
    }
    function dropout() {      // ふっと消えて、迷いながら戻る
        const s = [[0.02, rand(250, 650)]];
        if (Math.random() < 0.7) s.push([rand(0.6, 0.9), rand(70, 120)], [0.05, rand(90, 220)]);
        s.push([1, 100]);
        return s;
    }

    function softDrop() {     // 控えめ用：明滅せず、ゆっくり暗くなって戻る
        return [[0.6, 160], [0.35, 260], [0.25, 500], [0.5, 200], [0.8, 200], [1, 120]];
    }

    function pick() {
        if (reduceMotion || TUNE.soft) return dip();
        const r = Math.random();
        if (r < TUNE.dip) return dip();
        if (r < TUNE.stutter) return stutter();
        return dropout();
    }

    function schedule() {
        clearTimeout(timer);
        if (!running) return;
        // 指数分布で次の出来事までの時間を決める（たまに長い沈黙、たまに立て続け）
        const gap = Math.max(MIN_GAP, -Math.log(1 - Math.random()) * MEAN_GAP);
        timer = setTimeout(async () => {
            if (running && !paused && !busy && !document.hidden) await sequence(pick());
            schedule();
        }, gap * 1000);
    }

    function start() {
        if (running) return;
        ensureDim();
        running = true;
        raf = requestAnimationFrame(frame);
        schedule();
    }
    function stop() {
        running = false;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        override = null;
        if (dim) dim.style.opacity = "0";
    }

    /** 外部から名前で出来事を起こす（"dip" | "stutter" | "dropout"） */
    function event(name, hooks) {
        let f = { dip, stutter, dropout }[name] || stutter;
        if (reduceMotion || TUNE.soft) f = name === "dropout" ? softDrop : dip;   // 控えめ: 明滅させない
        if (busy) return Promise.resolve(false);
        return sequence(f(), hooks).then(() => true);
    }

    // ---- 背景ループ動画（無い・再生できない端末では画像のまま） ----
    const BG_VIDEO = "./assets/read_bg_loop.mp4";
    function initBgVideo() {
        const v = document.getElementById("read-bg-video");
        if (!v) return;
        const ver = (window.APP_VERSION || "");
        v.addEventListener("playing", () => v.classList.add("ready"), { once: true });
        v.addEventListener("error", () => v.remove(), { once: true });
        v.src = BG_VIDEO + (ver ? "?v=" + ver : "");
        const p = v.play();
        if (p && p.catch) p.catch(() => { /* 自動再生不可（省電力モード等）→ タップ後に再試行 */ });
        // スタート画面のタップ後にもう一度試す（iOSの省電力モード対策）
        document.addEventListener("click", () => { if (v.paused) v.play().catch(() => {}); }, { once: true, capture: true });
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) v.pause(); else v.play().catch(() => {});
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initBgVideo);
    else initBgVideo();

    window.ImakokoLamp = {
        start, stop, sequence, event, scareLevel: LEVEL, soft: TUNE.soft || reduceMotion,
        pause() { paused = true; },
        resume() { paused = false; },
        get level() { return current; },
        get busy() { return busy; }
    };
})();
