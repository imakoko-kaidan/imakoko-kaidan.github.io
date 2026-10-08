/**
 * イマココ怪談 - 一瞬の恐怖演出（読書画面）
 *
 * 街灯がまたたいて「一瞬だけ点き直った」その一コマにだけ、背景に何かが居る。
 * 次に点いたときには、もう居ない。
 *
 * 画像は背景そのものに描き足した「差分」なので、#read-bg の中に重ねれば位置も光もぴったり合う。
 *
 * ルールを持たないことがルール：
 *  - 1話で何回出るかは毎回くじ引き（0回もある）
 *  - どの行で出るかもランダム。冒頭3行と最後の3行では出さない。近すぎる連発もしない
 *  - 同じ画像は1話で1回まで。前回見た画像は次の話で出にくくする
 *
 * 公開API: window.ImakokoScare = { arm(opts), disarm(), test(kind) }
 */
(function () {
    "use strict";

    const IMAGES = [
        { kind: "cat",   src: "./assets/scare/cat_sit.jpg" },
        { kind: "cat",   src: "./assets/scare/cat_lie.jpg" },
        { kind: "woman", src: "./assets/scare/woman_front.jpg" },
        { kind: "woman", src: "./assets/scare/woman_bowed.jpg" }
    ];

    // 1話あたりの出現回数のくじ（怖さ設定ごと）。[回数, 重み]
    const COUNT_TABLE = {
        mild:     [[0, 55], [1, 40], [2, 5]],
        standard: [[0, 25], [1, 45], [2, 25], [3, 5]],
        intense:  [[0, 8],  [1, 32], [2, 38], [3, 22]]
    };
    const EDGE = 3;        // 冒頭・末尾の除外行数
    const MIN_APART = 5;   // 出現どうしの最小行間隔
    const RECENT_KEY = "imakoko_scare_recent";

    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rand = (a, b) => a + Math.random() * (b - a);

    let layer = null;
    let plan = [];         // [{line, img, done}]
    let lineEls = [];
    let poll = 0;
    let armed = false;
    const preloaded = new Map();

    function weighted(table) {
        const total = table.reduce((s, [, w]) => s + w, 0);
        let r = Math.random() * total;
        for (const [v, w] of table) { if ((r -= w) < 0) return v; }
        return table[0][0];
    }

    function level() {
        try { return (window.ImakokoSettings && ImakokoSettings.scareLevel && ImakokoSettings.scareLevel()) || "standard"; }
        catch (e) { return "standard"; }
    }

    function ensureLayer() {
        if (layer) return layer;
        const host = document.getElementById("read-bg");
        if (!host) return null;
        layer = document.createElement("img");
        layer.id = "scare-layer";
        layer.alt = "";
        layer.setAttribute("aria-hidden", "true");
        layer.decoding = "async";
        host.appendChild(layer);
        return layer;
    }

    function preload(src) {
        if (preloaded.has(src)) return preloaded.get(src);
        const im = new Image();
        im.decoding = "async";
        im.src = src;
        const p = (im.decode ? im.decode() : Promise.resolve()).then(() => true, () => false);
        preloaded.set(src, p);
        return p;
    }

    function pickImages(n) {
        let recent = [];
        try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { /* noop */ }
        // 前回見た画像は重みを下げる（ゼロにはしない＝絶対ではない）
        const pool = IMAGES.map(im => ({ im, w: recent.includes(im.src) ? 0.25 : 1 }));
        const out = [];
        while (out.length < n && pool.length) {
            const total = pool.reduce((s, p) => s + p.w, 0);
            let r = Math.random() * total, idx = 0;
            for (; idx < pool.length; idx++) { if ((r -= pool[idx].w) < 0) break; }
            out.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0].im);
        }
        return out;
    }

    function pickLines(n, total) {
        const lo = EDGE, hi = total - 1 - EDGE;
        if (hi - lo < 1) return [];
        const out = [];
        for (let tries = 0; out.length < n && tries < 200; tries++) {
            const l = Math.floor(rand(lo, hi + 1));
            if (out.every(x => Math.abs(x - l) >= MIN_APART)) out.push(l);
        }
        return out.sort((a, b) => a - b);
    }

    /** 実際に見せる。灯りの明滅の「点き直った一瞬」にだけ差分画像を出す */
    async function reveal(img) {
        if (!window.ImakokoLamp || ImakokoLamp.busy) return false;
        const el = ensureLayer();
        if (!el) return false;
        const ok = await preload(img.src);
        if (!ok) return false;
        el.src = img.src;
        const show = Math.round(rand(150, 260));       // 見える時間
        // 控えめ: 明滅は1秒に2回以内・暗転も浅く（光過敏への配慮）。そのぶん少し長く見える
        const steps = ImakokoLamp.soft ? [
            [0.3, 450], [1.0, 420], [0.3, 600], [1.0, 200]
        ] : [
            [0.03, rand(140, 320)],                     // 消える
            [1.0,  show],                               // 点く…居る
            [0.02, rand(260, 480)],                     // 消える（ここで消す）
            [rand(0.7, 0.95), rand(60, 110)],           // 迷いながら
            [0.05, rand(80, 160)],
            [1.0, 120]                                  // 戻る…もう居ない
        ];
        let lightCount = 0;
        await ImakokoLamp.sequence(steps, {
            onLight: () => {
                lightCount++;
                el.classList.toggle("on", lightCount === 1);
            },
            onDark: () => { el.classList.remove("on"); }
        });
        el.classList.remove("on");
        try {
            const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").filter(s => s !== img.src);
            recent.unshift(img.src);
            localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, 2)));
        } catch (e) { /* noop */ }
        return true;
    }

    function currentLine() {
        for (let i = 0; i < lineEls.length; i++) if (lineEls[i].classList.contains("lit")) return i;
        return -1;
    }

    function tick() {
        if (!armed || document.hidden) return;
        const cur = currentLine();
        if (cur < 0) return;
        for (const p of plan) {
            if (p.done || p.waiting) continue;
            if (cur >= p.line) {
                p.waiting = true;
                // その行に来てから少し間を置く（読み始めた瞬間ではなく、読んでいる最中に）
                setTimeout(async () => {
                    if (!armed) return;
                    let ok = await reveal(p.img);
                    if (!ok) { // 灯りが別の明滅中だった等 → 少し後にもう一度だけ
                        await new Promise(r => setTimeout(r, rand(1500, 3000)));
                        if (armed) ok = await reveal(p.img);
                    }
                    p.done = true;
                }, rand(1200, 5500));
                break;
            }
        }
    }

    /**
     * 読書開始時に呼ぶ。opts.lineEls = 本文の行要素（終端スペーサーは除く）
     */
    function arm(opts) {
        disarm();
        if (reduceMotion) return { count: 0 };
        lineEls = (opts && opts.lineEls) || [];
        const n = weighted(COUNT_TABLE[level()] || COUNT_TABLE.standard);
        const lines = pickLines(n, lineEls.length);
        const imgs = pickImages(lines.length);
        plan = lines.map((line, i) => ({ line, img: imgs[i], done: false }));
        plan.forEach(p => preload(p.img.src));
        armed = true;
        poll = setInterval(tick, 400);
        return { count: plan.length };
    }

    function disarm() {
        armed = false;
        clearInterval(poll);
        plan = [];
        if (layer) layer.classList.remove("on");
    }

    /** 開発用：今すぐ出す（kind = "cat" | "woman" | 省略） */
    function test(kind) {
        const pool = IMAGES.filter(im => !kind || im.kind === kind);
        return reveal(pool[Math.floor(Math.random() * pool.length)]);
    }

    window.ImakokoScare = { arm, disarm, test, get plan() { return plan.map(p => ({ line: p.line, src: p.img.src, done: p.done })); } };
})();
