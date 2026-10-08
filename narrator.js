/**
 * イマココ怪談 — 語り手の読み上げ（Gemini 3.8 Flash TTS・1行ずつ）
 *
 * - 設定「語り手の声で読み上げる」が ON のときだけ動く（OFFなら一切通信しない＝料金ゼロ）。
 * - 1行ずつ音声を作り、読み終えるたびにスポットライト(中央の行)を次の行へ自動で進める。
 * - 先の数行は聞いている間に裏で先に作る（待ち時間を減らす）。
 * - 作った音声は端末(IndexedDB "audio")に保存。2回目以降は通信も料金もなし。
 * - 画面タップ=一時停止/再開。自分でスワイプしたら、指を離して止まった行(照明の下)から読み直す。
 * - 読む画面の右上「声 ON/OFF」ボタンでいつでも切替（ホームの設定と連動）。
 * - 音は HorrorAudio の AudioContext（スタート画面のタップで解除済み）で鳴らす＝iPhoneでも再生できる。
 */
window.ImakokoNarrator = (() => {
    const API = "https://generativelanguage.googleapis.com/v1beta";
    const USD_PER_10S = 0.00225;     // 3.8 Flash TTS 公式単価(2026年末までの導入価格)
    const YEN_PER_USD = 150;
    const PREFETCH = 3;              // 何行先まで先に作るか
    const GAP_SHORT = 350;           // 行と行の間(ms)
    const GAP_LONG = 1100;           // 台本の空行(=間)のあと(ms)
    const GAP_BEFORE_LAST = 1700;    // 最後の一文の前の間(ms)。ここで一拍おいてから締める
    // 最後の一文だけ、語り終える締めのトーンで読ませる(Gemini TTS の speech_metadata.style)
    const LAST_LINE_STYLE = "This is the very last line of the ghost story. Deliver it slowly and quietly, "
        + "with a clearly falling, final intonation that tells the listener the story has ended. "
        + "Lower the pitch toward the end and let the last word fade into silence. Do not sound like more is coming.";

    let st = null;   // 実行中の状態

    // ---------- 小物 ----------
    function log(m, d) {
        try { console.log("[語り]", m, d !== undefined ? d : ""); } catch (e) { /* noop */ }
    }
    function b64ToBytes(b64) {
        const bin = atob(b64); const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
    }
    function findAudio(obj) {   // 応答の中から {type:"audio", data} を探す
        let found = null;
        (function walk(o) {
            if (!o || typeof o !== "object") return;
            if (o.type === "audio" && typeof o.data === "string") found = o;
            for (const k in o) walk(o[k]);
        })(obj);
        return found;
    }
    // 要素を画面の横中央へ送る。縦書き(vertical-rl)では scrollIntoView の inline/block の向きが
    // 横書きと逆になり取り違えやすい(BUGLOG #19)ので、横方向のずれを直接計算して送る
    function centerEl(el) {
        const c = st && st.container;
        if (!c || !el) return;
        const r = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
        const delta = (r.left + r.width / 2) - (cr.left + cr.width / 2);
        if (Math.abs(delta) > 1) c.scrollBy({ left: delta, behavior: "smooth" });
    }

    function chip(text) {
        let el = document.getElementById("narr-chip");
        if (!el) {
            el = document.createElement("div");
            el.id = "narr-chip";
            el.style.cssText =
                "position:fixed;left:50%;bottom:4vh;transform:translateX(-50%);z-index:170;" +
                "font:12px/1.4 'Shippori Mincho',serif;letter-spacing:.12em;color:#9aa3b8;" +
                "background:rgba(5,7,13,.6);border:1px solid rgba(150,160,190,.25);border-radius:999px;" +
                "padding:.35em 1.1em;pointer-events:none;transition:opacity .6s;opacity:0;";
            document.body.appendChild(el);
        }
        if (!text) { el.style.opacity = "0"; return; }
        el.textContent = text;
        el.style.opacity = "1";
    }

    // ---------- 音声を作る（1行） ----------
    async function synth(text, attempt = 0, style) {
        const content = { type: "text", text };
        if (style) content.annotations = [{ type: "speech_metadata", style }];
        const res = await fetch(`${API}/interactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": st.apiKey },
            body: JSON.stringify({
                model: st.model,
                input: [{ type: "user_input", content: [content] }],
                response_format: { type: "audio" },
                generation_config: { speech_config: [{ voice: st.voice }] }
            })
        });
        const txt = await res.text();
        if (!res.ok) {
            // 混雑(429)・一時障害(5xx)は少し待って2回まで再試行
            if ((res.status === 429 || res.status >= 500) && attempt < 2) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                return synth(text, attempt + 1, style);
            }
            const e = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`); e.status = res.status; throw e;
        }
        const a = findAudio(JSON.parse(txt));
        if (!a) throw new Error("応答に音声がありません");
        return new Blob([b64ToBytes(a.data)], { type: a.mime_type || "audio/wav" });
    }

    // 行iの音声(AudioBuffer)を用意する。保存済みならそれを使い、無ければ作って保存
    function getBuffer(i) {
        if (i < 0 || i >= st.lines.length) return Promise.resolve(null);
        if (st.cache.has(i)) return st.cache.get(i);
        const p = (async () => {
            const isLast = i === st.lines.length - 1;
            // 最後の一文は締めのトーンで作り直すため、保存キーを分ける(2026-10。古い話も最後の1行だけ作り直し)
            const key = `${st.storyId}|${st.voice}|${i}${isLast ? "|end" : ""}`;
            let blob = null, generated = false;
            try { blob = await ImakokoDB.getAudio(key); } catch (e) { blob = null; }
            if (!blob) {
                if (st.stopped) throw new Error("stopped");
                blob = await synth(st.lines[i].text, 0, isLast ? LAST_LINE_STYLE : null);
                generated = true;
                ImakokoDB.putAudio(key, blob).catch(() => { /* 保存失敗でも再生は続ける */ });
            }
            const buf = await st.ctx.decodeAudioData(await blob.arrayBuffer());
            if (generated) {
                st.genSec += buf.duration;
                st.genLines++;
            } else {
                st.cachedLines++;
            }
            return buf;
        })();
        p.catch(() => st && st.cache.delete(i));   // 失敗したら次回作り直せるように
        st.cache.set(i, p);
        return p;
    }

    function prefetch(from) {
        for (let j = from; j < Math.min(from + PREFETCH, st.lines.length); j++) {
            getBuffer(j).catch(() => { /* 再生時に改めて扱う */ });
        }
    }

    // ---------- 再生 ----------
    async function playLine(i) {
        if (!st || st.stopped) return;
        if (i >= st.lines.length) { finish(); return; }
        st.idx = i;
        st.stage = "scroll";
        log("行", i);
        centerEl(st.lines[i].el);
        prefetch(i + 1);

        let buf;
        const waitTimer = setTimeout(() => { if (st && st.idx === i && !st.paused) chip("……語り手が、言葉を探しています"); }, 700);
        try {
            st.stage = "buffer";
            buf = await getBuffer(i);
        } catch (e) {
            clearTimeout(waitTimer);
            if (!st || st.stopped) return;
            fail(e);
            return;
        }
        clearTimeout(waitTimer);
        if (!st || st.stopped || st.paused || st.idx !== i) return;
        chip("");

        // 音が鳴らせない状態(ブラウザの自動再生制限など)なら、タップを待ってから語り始める
        if (st.ctx.state !== "running") {
            try { await Promise.race([st.ctx.resume(), new Promise(r => setTimeout(r, 800))]); } catch (e) { /* noop */ }
            if (st.ctx.state !== "running") {
                st.paused = true;
                chip("画面をタップすると、語りが始まります");
                return;
            }
        }
        const src = st.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(st.gain);
        src.onended = () => {
            if (!st || st.source !== src) return;
            st.source = null;
            if (st.paused || st.stopped) return;
            const gap = (i + 1 === st.lines.length - 1) ? Math.max(GAP_BEFORE_LAST, st.lines[i].gapAfter) : st.lines[i].gapAfter;
            setTimeout(() => {
                if (st && !st.paused && !st.stopped && st.idx === i) playLine(i + 1);
            }, gap);
        };
        st.source = src;
        st.stage = "playing";
        st.lineStart = st.ctx.currentTime;
        st.lineDur = buf.duration;
        src.start();
    }

    function stopSource() {
        if (st && st.source) {
            const s = st.source; st.source = null;
            try { s.stop(); } catch (e) { /* noop */ }
        }
    }

    function pause() {
        if (!st || st.stopped || st.paused) return;
        st.paused = true;
        stopSource();
        chip("語りを止めています（画面をタップで再開）");
    }

    function resume() {
        if (!st || st.stopped || !st.paused) return;
        st.paused = false;
        chip("");
        // いま中央(照明の下)にある行から読み直す
        const litIdx = st.lines.findIndex(l => l.el.classList.contains("lit"));
        playLine(litIdx >= 0 ? litIdx : st.idx);
    }

    function report() {
        if (!st) return;
        const yen = (st.genSec / 10 * USD_PER_10S * YEN_PER_USD).toFixed(2);
        log("使用量", { 新規に作った行: st.genLines, 保存済みを使った行: st.cachedLines, 新規音声秒: st.genSec.toFixed(1), 目安: yen + "円" });
    }

    function finish() {
        chip("");
        report();
        // 末尾の闇へ送る → 既存の「最後の行が消えたら誘導ボタン」の仕組みがそのまま動く
        if (st.endSpace) centerEl(st.endSpace);
        st.stopped = true;
    }

    function fail(e) {
        log("失敗", String(e && e.message || e));
        stopSource();
        const msg = (e && (e.status === 400 || e.status === 403 || e.status === 404))
            ? "語りの声を使えませんでした（設定やキーを確認してください）。文字で続けてお読みください。"
            : "語りの声を受け取れませんでした。文字で続けてお読みください。";
        chip(msg);
        setTimeout(() => chip(""), 6000);
        report();
        if (st) st.stopped = true;
        if (base) base.failed = true;   // 失敗後はスワイプで勝手に再開しない(ボタンで再ONは可)
    }

    function stop() {
        if (!st) return;
        stopSource();
        if (!st.stopped) report();
        st.stopped = true;
        chip("");
    }

    // ---------- 準備・開始・ボタン・スワイプ追従 ----------
    let base = null;      // attach時に用意した材料（行・間・画面・保存済み音声）
    let btn = null;       // 読む画面の「声 ON/OFF」ボタン
    let settleTimer = null;
    let touching = false;

    function voiceOn() { return !!(window.ImakokoSettings && ImakokoSettings.voiceEnabled()); }
    function isActive() { return !!(st && !st.stopped); }
    function litIndex() { return base ? base.lines.findIndex(l => l.el.classList.contains("lit")) : -1; }

    // 表示中の行(要素)と、台本上の「間(空行)」の有無を対応づける
    function buildLines(o) {
        const TAG = /^\[(SOUND|VISUAL):[A-Z_]+\]$/;
        const gaps = [];
        const raw = (o.rawLines || []).map(l => (l || "").trim());
        for (let k = 0; k < raw.length; k++) {
            if (raw[k] === "" || TAG.test(raw[k])) continue;
            let gap = GAP_SHORT;
            for (let m = k + 1; m < raw.length; m++) {
                if (raw[m] === "") { gap = GAP_LONG; break; }
                if (!TAG.test(raw[m])) break;
            }
            gaps.push(gap);
        }
        return o.lineEls.map((el, i) => ({
            el, text: el.textContent.trim(), gapAfter: gaps[i] != null ? gaps[i] : GAP_SHORT
        })).filter(l => l.text);
    }

    /** from行目から読み始める。条件が揃わなければ false */
    function begin(from, delay) {
        const cfg = window.IMAKOKO_CONFIG || {};
        const apiKey = (localStorage.getItem("imakoko_api_key") || "").trim();
        if (!cfg.narratorVoice || !cfg.narratorTtsModel) { chip("語り手の声が設定されていません"); setTimeout(() => chip(""), 4000); return false; }
        if (!apiKey) { chip("APIキーが無いため、語りは使えません"); setTimeout(() => chip(""), 5000); return false; }
        if (from < 0 || from >= base.lines.length) return true;   // 末尾の闇など: 読む行が無い(ONだけ反映)
        const ctx = (window.HorrorAudio && HorrorAudio.context) || base.ctx ||
            (base.ctx = new (window.AudioContext || window.webkitAudioContext)());
        if (!base.gain || base.gain.context !== ctx) {
            base.gain = ctx.createGain(); base.gain.gain.value = 1.0; base.gain.connect(ctx.destination);
        }
        if (st) { stopSource(); st.stopped = true; }
        st = {
            apiKey, voice: cfg.narratorVoice, model: cfg.narratorTtsModel,
            storyId: base.storyId, ctx, gain: base.gain, lines: base.lines,
            endSpace: base.endSpace, container: base.container,
            cache: base.cache, idx: from, source: null, paused: false, stopped: false,
            genSec: 0, genLines: 0, cachedLines: 0
        };
        log("開始", { 行: from, 全行数: base.lines.length, 声: st.voice });
        prefetch(from);
        setTimeout(() => { if (st && !st.stopped && st.idx === from) playLine(from); }, delay);
        return true;
    }

    function renderBtn() {
        if (!btn) return;
        const on = voiceOn();
        btn.textContent = on ? "声 ON" : "声 OFF";
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        btn.setAttribute("aria-label", on ? "語り手の声を切る" : "語り手の声で読む");
    }

    function makeBtn() {
        if (btn) { renderBtn(); return; }
        btn = document.createElement("button");
        btn.id = "voice-btn";
        btn.type = "button";
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (voiceOn()) {
                // OFF: すぐ止める。以後この端末では声を作らない(ホームの設定と連動)
                ImakokoSettings.setVoiceEnabled(false);
                stop();
                chip("語りを切りました"); setTimeout(() => chip(""), 1800);
            } else {
                // ON: いま照明の下にある行から読み始める
                ImakokoSettings.setVoiceEnabled(true);
                base.failed = false;
                if (!begin(Math.max(0, litIndex()), 300)) ImakokoSettings.setVoiceEnabled(false);
            }
            renderBtn();
        });
        document.body.appendChild(btn);
        renderBtn();
    }

    // 自分でスワイプ/スクロールしたら、いまの声を止め、指を離して画面が止まった行から読み直す
    function onUserScrollIntent() {
        if (!base) return;
        if (isActive()) {
            if (st.paused) return;           // 一時停止中は止めたまま
            st.idx = -1;                     // 再生中の行と「次の行」の予約を無効化
            stopSource();
            chip("");
        } else if (!voiceOn() || base.failed) {
            return;                          // 声OFF(または失敗後)なら何もしない
        }
        base.userScrolling = true;
        scheduleSettle();
    }
    function scheduleSettle() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            if (touching) { scheduleSettle(); return; }      // まだ指が触れている
            if (!base || !base.userScrolling) return;
            base.userScrolling = false;
            const i = litIndex();
            if (i < 0) return;                               // 末尾の闇: 読む行なし(締めは既存の仕組み)
            if (isActive()) { if (!st.paused) playLine(i); }
            else if (voiceOn() && !base.failed) begin(i, 0); // 読み終えた後に戻って来た場合など
        }, 450);
    }

    /**
     * 読む画面の開始時(スタート画面のタップの中)に必ず呼ぶ。
     * 声ボタンを置き、設定ONならすぐ読み始める。戻り値: 読み始めたら true
     * @param {object} o { container, lineEls, rawLines, storyId, endSpace }
     */
    function attach(o) {
        const lines = buildLines(o);
        if (!lines.length) return false;
        base = {
            lines, container: o.container, endSpace: o.endSpace, storyId: o.storyId || "unknown",
            cache: new Map(), failed: false, userScrolling: false, ctx: null, gain: null
        };
        makeBtn();

        const c = o.container;
        c.addEventListener("click", () => { if (isActive()) { st.paused ? resume() : pause(); } });   // タップ=一時停止/再開
        c.addEventListener("touchstart", () => { touching = true; }, { passive: true });
        const release = () => { touching = false; if (base && base.userScrolling) scheduleSettle(); };
        c.addEventListener("touchend", release, { passive: true });
        c.addEventListener("touchcancel", release, { passive: true });
        c.addEventListener("touchmove", onUserScrollIntent, { passive: true });
        c.addEventListener("wheel", onUserScrollIntent, { passive: true });
        c.addEventListener("scroll", () => { if (base && base.userScrolling) scheduleSettle(); }, { passive: true });
        document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
        window.addEventListener("pagehide", stop);

        if (voiceOn() && window.ImakokoDB && ImakokoDB.touchAudioStory) ImakokoDB.touchAudioStory(base.storyId);   // 古い話の声を整理
        return voiceOn() ? begin(0, 1200) : false;   // 灯りがついて一拍おいてから語り始める
    }

    // 動作確認用: 内部状態を覗く
    function debug() {
        return st && { idx: st.idx, stage: st.stage, paused: st.paused, stopped: st.stopped, playing: !!st.source,
            ctx: st.ctx.state, cache: [...st.cache.keys()], genLines: st.genLines, cachedLines: st.cachedLines, total: st.lines.length };
    }

    /**
     * いま読み上げ中の行が el なら、その行の再生情報を返す（効果音を擬音の位置に合わせるため）。
     * { dur: 行の長さ(秒), elapsed: 読み始めてからの秒 } / 読み上げ中でなければ null
     */
    function timing(el) {
        if (!st || st.stopped || st.paused || !st.lines[st.idx] || st.lines[st.idx].el !== el) return null;
        if (st.stage !== "playing" && st.stage !== "buffer" && st.stage !== "scroll") return null;
        return { dur: st.lineDur || 0, elapsed: st.stage === "playing" ? Math.max(0, st.ctx.currentTime - (st.lineStart || 0)) : 0, stage: st.stage };
    }

    return { attach, stop, pause, resume, debug, timing };
})();
