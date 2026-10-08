/**
 * イマココ怪談 - 読了の儀式「ろうそくを消す」
 *
 * 本文を読み終えて文字が画面から消えたとき、街灯が落ち、闇の中に一本のろうそくが灯る。
 * 炎をタップするか、マイクに息を吹きかけると、炎が揺れ、ふっと消え、煙が立ちのぼる。
 * 真っ暗になってしばらくしてから、エンドロールへ。
 *
 *  - 炎は canvas で毎フレーム描く（揺らぎ・息で傾く・縮む）
 *  - マイクは「息で消す」を押したときだけ使う。音は端末の中で強さを測るだけで、録音も送信もしない
 *  - 息と声の区別：息は「ザーッ」という雑音（周波数が平ら）、声は倍音の山がある。平らさ（スペクトル平坦度）で判定
 *    ※ しきい値はPC・iPhoneの実機で要調整（VERIFY）
 *
 * 公開API: window.ImakokoCandle = { show({onOut}), hide(), stop(), debug }
 */
(function () {
    "use strict";

    const MIC_PREF = "imakoko_candle_mic";
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let root = null, canvas = null, ctx2d = null, dark = null, glow = null, label = null, micBtn = null, hint = null;
    let raf = 0, visible = false, lit = true, outStarted = false;
    let onOut = null;
    let dpr = 1, CW = 140, CH = 300;

    // 炎の状態
    let lean = 0, leanV = 0, hNoise = 0, blow = 0, blowTarget = 0, life = 1; // life: 1=点灯 → 0=消灯
    let smoke = [];
    let ember = 0;   // 消えた直後の芯の赤い残り火

    // マイク
    let stream = null, actx = null, analyser = null, timeBuf = null, freqBuf = null;
    let floor = 0.01, strongMs = 0, lastT = 0;

    // ---------- DOM ----------
    function build() {
        if (root) return;
        dark = document.createElement("div");
        dark.id = "candle-dark";
        dark.setAttribute("aria-hidden", "true");
        document.body.appendChild(dark);

        root = document.createElement("div");
        root.id = "candle";
        root.innerHTML = `
            <p class="cd-label">……ろうそくに、そっと息を吹きかけて</p>
            <div class="cd-stage">
                <div id="candle-glow" aria-hidden="true"></div>
                <canvas id="candle-canvas" aria-label="ろうそく。炎をタップすると消えます" role="button" tabindex="0"></canvas>
            </div>
            <div class="cd-actions">
                <button type="button" class="cd-mic">息で消す（マイク）</button>
                <p class="cd-hint">炎をタップしても、消せます</p>
            </div>`;
        document.body.appendChild(root);
        canvas = root.querySelector("#candle-canvas");
        glow = root.querySelector("#candle-glow");
        label = root.querySelector(".cd-label");
        micBtn = root.querySelector(".cd-mic");
        hint = root.querySelector(".cd-hint");
        ctx2d = canvas.getContext("2d");
        resize();
        window.addEventListener("resize", resize);

        const tapOut = (e) => { e.preventDefault(); e.stopPropagation(); puff(1); };
        canvas.addEventListener("click", tapOut);
        canvas.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") tapOut(e); });
        micBtn.addEventListener("click", (e) => { e.stopPropagation(); startMic(true); });

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) micBtn.style.display = "none";
    }

    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = CW * dpr; canvas.height = CH * dpr;
        canvas.style.width = CW + "px"; canvas.style.height = CH + "px";
    }

    // ---------- 描画 ----------
    function smoothNoise(prev, amt, pull) { return prev + (Math.random() - 0.5) * amt - prev * pull; }

    function draw(t) {
        raf = requestAnimationFrame(draw);
        const dt = lastT ? Math.min(50, t - lastT) : 16; lastT = t;
        if (analyser && lit) readMic(dt);

        // 息の強さをなめらかに追従
        blow += (blowTarget - blow) * (blowTarget > blow ? 0.35 : 0.08);
        // 揺らぎ：ばね＋ランダム。息が強いほど右奥へ倒れ、細かく震える
        const targetLean = blow * 26 + Math.sin(t / 900) * 1.2;
        leanV += (targetLean - lean) * 0.08 + (Math.random() - 0.5) * (0.9 + blow * 6);
        leanV *= 0.78;
        lean += leanV;
        hNoise = smoothNoise(hNoise, 0.12, 0.08);

        const g = ctx2d;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, CW, CH);

        const cx = CW / 2, wickTop = 170, bodyTop = 178;

        // ろうそく本体（ろう）
        const bw = 30, bh = CH - bodyTop - 6;
        const body = g.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
        body.addColorStop(0, "#1f1a13"); body.addColorStop(0.3, "#7d725e"); body.addColorStop(0.55, "#a89a7e"); body.addColorStop(1, "#231e16");
        g.fillStyle = body;
        g.beginPath();
        g.moveTo(cx - bw / 2, bodyTop + 4);
        g.lineTo(cx - bw / 2, bodyTop + bh);
        g.lineTo(cx + bw / 2, bodyTop + bh);
        g.lineTo(cx + bw / 2, bodyTop + 4);
        g.ellipse(cx, bodyTop + 4, bw / 2, 4, 0, 0, Math.PI, true);
        g.fill();
        // 垂れたろう
        g.fillStyle = "rgba(150,138,112,.85)";
        g.beginPath(); g.ellipse(cx - 9, bodyTop + 20, 3, 12, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(cx + 8, bodyTop + 12, 2.2, 7, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(cx - 1, bodyTop + 30, 1.6, 9, 0, 0, Math.PI * 2); g.fill();
        // 煤けた汚れ（下ほど暗く）
        const soot = g.createLinearGradient(0, bodyTop, 0, bodyTop + bh);
        soot.addColorStop(0, "rgba(0,0,0,0)"); soot.addColorStop(1, "rgba(0,0,0,.55)");
        g.fillStyle = soot; g.fillRect(cx - bw / 2, bodyTop + 4, bw, bh - 4);
        // 上面のろうだまり（炎で温かく光る）
        const pool = g.createRadialGradient(cx, bodyTop + 4, 1, cx, bodyTop + 4, bw / 2);
        pool.addColorStop(0, `rgba(255,190,110,${0.55 * life})`); pool.addColorStop(1, "rgba(200,180,150,.25)");
        g.fillStyle = pool;
        g.beginPath(); g.ellipse(cx, bodyTop + 4, bw / 2 - 1, 3.5, 0, 0, Math.PI * 2); g.fill();

        // 炎が消えると、ろうそく自体も闇に沈む
        if (life < 1) {
            g.fillStyle = `rgba(0,0,0,${0.78 * (1 - life)})`;
            g.fillRect(cx - bw / 2 - 2, bodyTop - 4, bw + 4, bh + 10);
        }

        // 芯
        g.strokeStyle = "#1a1612"; g.lineWidth = 2; g.lineCap = "round";
        g.beginPath(); g.moveTo(cx, bodyTop + 3); g.quadraticCurveTo(cx + 1, wickTop + 6, cx + 1.5 + lean * 0.03, wickTop); g.stroke();
        if (ember > 0) {
            g.fillStyle = `rgba(255,${80 + ember * 60},30,${ember})`;
            g.beginPath(); g.arc(cx + 1.5, wickTop + 1, 1.8, 0, Math.PI * 2); g.fill();
            ember = Math.max(0, ember - dt / 2600);
        }

        // 炎
        if (life > 0.01) {
            const h = (46 + hNoise * 18 - blow * 14) * life;
            const w = (8.5 + hNoise * 1.5 + blow * 1.5) * Math.max(0.35, life);
            const bx = cx + 1, by = wickTop + 4;
            const tipX = bx + lean * life, tipY = by - h;
            g.globalCompositeOperation = "lighter";
            // 外側の光の層
            flamePath(g, bx, by, tipX, tipY, w * 1.35, h * 1.08);
            let gr = g.createRadialGradient(bx, by - h * 0.3, 1, bx, by - h * 0.35, h * 0.9);
            gr.addColorStop(0, `rgba(255,170,60,${0.55 * life})`); gr.addColorStop(1, "rgba(180,40,0,0)");
            g.fillStyle = gr; g.fill();
            // 本体
            flamePath(g, bx, by, tipX, tipY, w, h);
            gr = g.createRadialGradient(bx, by - h * 0.22, 0.5, bx + lean * 0.3, by - h * 0.4, h * 0.75);
            gr.addColorStop(0, `rgba(255,252,235,${0.98 * life})`);
            gr.addColorStop(0.35, `rgba(255,215,120,${0.92 * life})`);
            gr.addColorStop(0.75, `rgba(255,120,30,${0.55 * life})`);
            gr.addColorStop(1, "rgba(160,30,0,0)");
            g.fillStyle = gr; g.fill();
            // 根元の青
            const blue = g.createRadialGradient(bx, by - 2, 0.5, bx, by - 2, w * 0.9);
            blue.addColorStop(0, `rgba(80,120,255,${0.55 * life})`); blue.addColorStop(1, "rgba(40,60,200,0)");
            g.fillStyle = blue;
            g.beginPath(); g.ellipse(bx, by - 3, w * 0.75, w * 0.6, 0, 0, Math.PI * 2); g.fill();
            g.globalCompositeOperation = "source-over";
        }

        // 煙
        if (smoke.length) {
            g.globalCompositeOperation = "source-over";
            for (let i = smoke.length - 1; i >= 0; i--) {
                const p = smoke[i];
                p.age += dt;
                const k = p.age / p.ttl;
                if (k >= 1) { smoke.splice(i, 1); continue; }
                p.x += p.vx * dt / 16 + Math.sin((p.age + p.seed) / 300) * 0.35 * (p.age / p.ttl);
                p.y += p.vy * dt / 16;
                p.r += 0.025 * dt / 16;
                g.fillStyle = `rgba(185,185,190,${0.09 * (1 - k) * Math.min(1, p.age / 200)})`;
                g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
            }
        }

        // 周りを照らす光（炎の明るさに合わせて揺れる）
        const glowLv = life * (0.85 + hNoise * 0.25 - blow * 0.25);
        glow.style.opacity = String(Math.max(0, glowLv));
        if (dark) dark.style.setProperty("--candle", String(Math.max(0, glowLv)));

        if (!visible && !smoke.length && life <= 0.01 && ember <= 0) { cancelAnimationFrame(raf); raf = 0; }
    }

    function flamePath(g, bx, by, tx, ty, w, h) {
        g.beginPath();
        g.moveTo(bx, by + 2);
        g.bezierCurveTo(bx - w * 1.25, by - h * 0.12, bx - w * 0.7 + (tx - bx) * 0.35, by - h * 0.62, tx, ty);
        g.bezierCurveTo(bx + w * 0.7 + (tx - bx) * 0.35, by - h * 0.62, bx + w * 1.25, by - h * 0.12, bx, by + 2);
        g.closePath();
    }

    // ---------- 消える ----------
    function puff(strength) {
        if (!lit || outStarted) return;
        outStarted = true;
        lit = false;
        stopMic();
        blowTarget = Math.max(0.8, strength);
        playPuff();
        if (navigator.vibrate) { try { navigator.vibrate(18); } catch (e) { /* noop */ } }
        // 炎が倒れて、縮んで、消える
        const t0 = performance.now();
        const dur = reduceMotion ? 250 : 520;
        (function fade() {
            const k = Math.min(1, (performance.now() - t0) / dur);
            life = Math.max(0, 1 - k * k * (k < 0.6 ? 0.6 : 1));
            if (k < 0.55 && Math.random() < 0.25) life *= 0.7;   // 消える前のまたたき
            if (k < 1) requestAnimationFrame(fade);
            else { life = 0; blowTarget = 0; ember = 1; startSmoke(); afterOut(); }
        })();
    }

    function startSmoke() {
        if (reduceMotion) return;
        const cx = CW / 2 + 1.5, y = 170;
        const spawn = (n) => {
            for (let i = 0; i < n; i++) {
                smoke.push({ x: cx + (Math.random() - 0.5) * 2, y, vx: (Math.random() - 0.5) * 0.25 + 0.05,
                    vy: -(0.6 + Math.random() * 0.35), r: 0.7 + Math.random() * 0.8, age: 0,
                    ttl: 2200 + Math.random() * 1600, seed: Math.random() * 1000 });
            }
        };
        let count = 0;
        const iv = setInterval(() => { spawn(3); if (++count > 70) clearInterval(iv); }, 30);
    }

    function afterOut() {
        root.classList.add("out");
        dark.classList.add("full");      // 完全な闇へ
        setTimeout(() => {
            const cb = onOut; onOut = null;
            if (cb) cb();
            setTimeout(() => { hide(true); }, 2600);
        }, 2400);
    }

    // ---------- 音（エンディングで全体音量は絞られているので、出力へ直接つなぐ） ----------
    function playPuff() {
        try {
            const ac = (window.HorrorAudio && HorrorAudio.context) || null;
            if (!ac) return;
            if (ac.state === "suspended") ac.resume();
            const t = ac.currentTime;
            const len = Math.floor(ac.sampleRate * 0.6);
            const buf = ac.createBuffer(1, len, ac.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
            const src = ac.createBufferSource(); src.buffer = buf;
            const lp = ac.createBiquadFilter(); lp.type = "lowpass";
            lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.5);
            const gn = ac.createGain();
            gn.gain.setValueAtTime(0.0001, t);
            gn.gain.exponentialRampToValueAtTime(0.22, t + 0.04);
            gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
            src.connect(lp); lp.connect(gn); gn.connect(ac.destination);
            src.start(t); src.stop(t + 0.6);
        } catch (e) { /* noop */ }
    }

    // ---------- マイク（息の検出） ----------
    async function startMic(fromUser) {
        if (stream || !lit) return;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });
        } catch (e) {
            if (fromUser) { micBtn.textContent = "マイクが使えません（タップで消せます）"; micBtn.disabled = true; }
            try { localStorage.removeItem(MIC_PREF); } catch (er) { /* noop */ }
            return;
        }
        try { localStorage.setItem(MIC_PREF, "1"); } catch (e) { /* noop */ }
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const srcNode = actx.createMediaStreamSource(stream);
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.2;
        srcNode.connect(analyser);   // 出力にはつながない（スピーカーから鳴らない）
        timeBuf = new Float32Array(analyser.fftSize);
        freqBuf = new Float32Array(analyser.frequencyBinCount);
        floor = 0.01; strongMs = 0;
        micBtn.textContent = "……どうぞ、息を";
        micBtn.classList.add("on");
        micBtn.disabled = true;
        hint.textContent = "声や物音では消えません。炎をタップしても消せます";
    }

    function readMic(dt) {
        analyser.getFloatTimeDomainData(timeBuf);
        let s = 0;
        for (let i = 0; i < timeBuf.length; i++) s += timeBuf[i] * timeBuf[i];
        const rms = Math.sqrt(s / timeBuf.length);

        // 100Hz〜3kHz の平坦度（息＝平ら、声＝山がある）
        analyser.getFloatFrequencyData(freqBuf);
        const binHz = actx.sampleRate / analyser.fftSize;
        const lo = Math.max(1, Math.floor(100 / binHz)), hi = Math.min(freqBuf.length - 1, Math.floor(3000 / binHz));
        let logSum = 0, linSum = 0, n = 0;
        for (let i = lo; i <= hi; i++) {
            const p = Math.pow(10, freqBuf[i] / 10) + 1e-12;
            logSum += Math.log(p); linSum += p; n++;
        }
        const flat = Math.exp(logSum / n) / (linSum / n);

        const loud = rms > Math.max(0.035, floor * 4);
        const breathy = flat > 0.18;
        if (!loud) floor = floor * 0.97 + rms * 0.03;    // 静かなときだけ環境音を学習

        const strength = loud && breathy ? Math.min(1, (rms - floor * 3) / 0.18) : 0;
        blowTarget = strength * 0.85;
        debugState.rms = rms; debugState.flat = flat; debugState.floor = floor; debugState.strength = strength;

        if (strength > 0.45) strongMs += dt; else strongMs = Math.max(0, strongMs - dt * 1.5);
        if (strongMs > 260 || strength > 0.95) puff(strength);
    }

    function stopMic() {
        try { if (stream) stream.getTracks().forEach(tr => tr.stop()); } catch (e) { /* noop */ }
        try { if (actx) actx.close(); } catch (e) { /* noop */ }
        stream = null; actx = null; analyser = null;
    }

    // ---------- 公開 ----------
    async function show(opts) {
        build();
        onOut = (opts && opts.onOut) || null;
        if (outStarted) return;
        visible = true;
        root.classList.add("show");
        dark.classList.add("show");
        if (!raf) { lastT = 0; raf = requestAnimationFrame(draw); }
        // 一度マイクを許可した人は、許可が残っていれば自動でマイク待ち受け（ダイアログは出ない場合のみ）
        try {
            if (localStorage.getItem(MIC_PREF) && navigator.permissions) {
                const st = await navigator.permissions.query({ name: "microphone" });
                if (st.state === "granted") startMic(false);
            }
        } catch (e) { /* Safari等は permissions 未対応 → ボタンで */ }
    }

    function hide(force) {
        if (outStarted && !force) return;     // 消し始めたら最後まで
        visible = false;
        stopMic();
        if (root) root.classList.remove("show");
        if (dark && !outStarted) dark.classList.remove("show");
    }

    function stop() { onOut = null; hide(true); stopMic(); }

    const debugState = {};
    window.ImakokoCandle = { show, hide, stop, puff, get debug() { return Object.assign({ lit, life, blow }, debugState); } };
})();
