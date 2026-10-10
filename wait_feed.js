/**
 * イマココ怪談 — 待ち時間の「この場所の記録」（2026-10）
 *
 * 「怪談を産む」を押してから話が届くまで（20〜40秒）に、生成のために集めた“この土地の本当の事実”を
 * 取材メモのように1つずつ見せる。いまこの場所を調べている感じを出すのが目的。
 *  - 話の驚きを残すため、事実は見出しと冒頭の一部だけ（続きは本編で）
 *  - 記録が無い場所・出し切ったあとは、怪談の小話（trivia.js）に切り替える
 *  - 通信も費用も増えない（すでに集めた錨を見せるだけ）
 *
 * 公開API: window.ImakokoWaitFeed = { start(placeLabel, anchors), stop() }
 */
(function () {
    "use strict";
    const RECORD_MS = 6500;   // 記録1件を見せる時間
    const TRIVIA_MS = 8000;   // 小話1件を見せる時間
    let timer = 0, box = null;

    const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    function shuffle(a) {
        const r = a.slice();
        for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
        return r;
    }

    /** 冒頭の一部だけ（かっこ書き・読み仮名を落として、最初の文の頭を60字まで） */
    function teaser(text) {
        let t = String(text || "").replace(/（[^）]*）|\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
        const first = t.split(/(?<=。)/)[0] || t;
        t = first.length > 60 ? first.slice(0, 58) + "……" : first;
        return t;
    }
    function dist(m) {
        if (m == null || !isFinite(m)) return "";
        return m < 1000 ? `ここから約${Math.max(50, Math.round(m / 50) * 50)}m` : `ここから約${(m / 1000).toFixed(1)}km`;
    }

    function show(headHtml, bodyHtml) {
        if (!box) return;
        const card = box.querySelector(".wf-card");
        card.classList.remove("in");
        setTimeout(() => {
            card.innerHTML = headHtml + bodyHtml;
            void card.offsetWidth;
            card.classList.add("in");
        }, card.innerHTML ? 450 : 0);
    }

    function start(placeLabel, anchors) {
        stop();
        box = document.getElementById("wait-feed");
        if (!box) return;
        const records = (anchors || [])
            .filter(a => a && (a.title || a.text))
            .map(a => ({ title: a.title || "", text: teaser(a.text), source: a.source || "", d: dist(a.distM) }))
            .filter(r => r.title || r.text);
        const trivia = shuffle(window.ImakokoTrivia || []);
        const place = placeLabel ? `この場所　${placeLabel}付近の` : "この場所の";   // textContentで入れるのでエスケープ不要
        box.innerHTML = `<p class="wf-head"></p><div class="wf-card" aria-live="polite"></div>`;
        box.hidden = false;
        const head = box.querySelector(".wf-head");

        let i = 0, j = 0;
        const step = () => {
            if (!box) return;
            if (i < records.length) {
                const r = records[i];
                head.textContent = `……${place}記録を、拾っています`;
                show(`<p class="wf-label">― 記録 ${i + 1} / ${records.length} ―${r.d ? `<span class="wf-dist">${esc(r.d)}</span>` : ""}</p>`,
                     `${r.title ? `<p class="wf-title">${esc(r.title)}</p>` : ""}<p class="wf-text">${esc(r.text)}</p>` +
                     `${r.source ? `<p class="wf-src">出典：${esc(r.source)}</p>` : ""}`);
                i++;
                timer = setTimeout(step, RECORD_MS);
            } else if (trivia.length) {
                const t = trivia[j % trivia.length];
                head.textContent = records.length
                    ? "……語り手が来るまで、もうひとつ"
                    : "……この場所の記録は見つかりませんでした。語り手を待つあいだに、ひとつ";
                show(`<p class="wf-label">― 怪談の小話 ―</p>`, `<p class="wf-title">${esc(t.t)}</p><p class="wf-text">${esc(t.b)}</p>`);
                j++;
                timer = setTimeout(step, TRIVIA_MS);
            }
        };
        step();
    }

    function stop() {
        clearTimeout(timer);
        timer = 0;
        if (box) { box.hidden = true; box.innerHTML = ""; }
        box = null;
    }

    window.ImakokoWaitFeed = { start, stop };
})();
