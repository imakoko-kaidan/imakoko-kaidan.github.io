/**
 * Horror Radio - Story Viewer Engine
 * 縦書き・右→左スクロール / スポットライト / スクロール同期ギミック発動
 *
 * データ読込の優先順位:
 *   1. ?preview=1     → localStorage("horror_radio_preview") ②エディタからのプレビュー
 *   2. ?id=xxx        → stories.js (window.HORROR_STORIES)
 *   3. フォールバック  → HORROR_STORIES の先頭作品
 */
document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById("story-container");
    const startScreen = document.getElementById("start-screen");

    // ---- 1. 作品データの解決 -------------------------------------------------
    // 優先順位: ?pin=(IndexedDB・自分のコレクション) → ?preview=1 → ?id=(同梱デモ) → デモ先頭
    const params = new URLSearchParams(location.search);
    let story = null;
    const pinId = params.get("pin");

    if (pinId && typeof ImakokoDB !== "undefined") {
        try {
            story = await ImakokoDB.getPin(pinId);
        } catch (e) { story = null; }
        if (!story) {
            startScreen.innerHTML = "<p>この記録は、この端末には残っていないようです。<br><a href='./map.html' style='color:#666;'>地図へ戻る</a></p>";
            return;
        }
    }
    if (!story && params.get("preview") === "1") {
        try {
            story = JSON.parse(localStorage.getItem("horror_radio_preview"));
        } catch (e) { story = null; }
    }
    if (!story && params.get("id") && window.HORROR_STORIES) {
        story = window.HORROR_STORIES.find(s => s.id === params.get("id")) || null;
    }
    if (!story && !pinId && window.HORROR_STORIES && window.HORROR_STORIES.length) {
        story = window.HORROR_STORIES[0];
    }
    if (!story || !Array.isArray(story.lines)) {
        startScreen.innerHTML = "<p>作品が見つかりませんでした。<br><a href='./index.html' style='color:#666;'>戻る</a></p>";
        return;
    }

    // ---- 1.2 演出の強さ（2026-10: 設定ではなくお話ごと）。生成時のAI判定 → 無ければ本文から推定 ----
    try {
        const lv = ImakokoSettings.LEVELS.includes(story.fear) ? story.fear : ImakokoSettings.estimateFear(story.lines);
        ImakokoSettings.setStoryLevel(lv);
        const el = document.getElementById("ss-level");
        if (el) el.textContent = "この話の演出：" + (ImakokoSettings.SCARE_LABEL[ImakokoSettings.scareLevel()] || "標準");
    } catch (e) { /* noop */ }

    // ---- 1.5 背景画像レイヤー（ハイブリッド演出: 指定時のみ） -------------------
    if (story.bgImage) {
        const bgLayer = document.getElementById("bg-layer");
        const img = new Image();
        img.onload = () => {
            bgLayer.style.backgroundImage = `url("${story.bgImage}")`;
            bgLayer.classList.add("visible"); // 2.5秒かけて闇から滲み出す
        };
        img.src = story.bgImage;
    }

    // ---- 2. デバイス連動: プレースホルダ置換 ----------------------------------
    // {{TIME}} は「分刻みの時刻」だと“そんな丁度今なわけ”の嘘くささが出るので、
    // 読者の今と大体同じ『時間帯』の言葉に置換する(例: 昼下がり/夕暮れどき/真夜中)。
    function timeBand(h) {
        if (h >= 5 && h < 8)  return "朝";
        if (h >= 8 && h < 11) return "昼前";
        if (h >= 11 && h < 14) return "昼下がり";
        if (h >= 14 && h < 17) return "午後";
        if (h >= 17 && h < 19) return "夕暮れどき";
        if (h >= 19 && h < 23) return "宵";
        if (h >= 23 || h < 3)  return "真夜中";
        return "丑三つ時"; // 3〜5時
    }
    function deviceText(text) {
        if (text.includes("{{TIME}}")) {
            text = text.replaceAll("{{TIME}}", timeBand(new Date().getHours()));
        }
        return text;
    }

    // ---- 3. DOM構築: 行とギミックの紐付け ------------------------------------
    // ギミックタグ行は直前のテキスト行に data-gimmicks として付与する
    const TAG_RE = /^\[(SOUND|VISUAL):[A-Z_]+\]$/;
    let lastLineEl = null;

    story.lines.forEach(raw => {
        const text = (raw || "").trim();
        if (text === "") return; // 空行は「間」として台本上の目印。表示はしない

        if (TAG_RE.test(text)) {
            if (lastLineEl) {
                const existing = lastLineEl.getAttribute("data-gimmicks") || "";
                lastLineEl.setAttribute("data-gimmicks", existing ? existing + "," + text : text);
            }
            return;
        }
        const p = document.createElement("p");
        p.className = "story-line";
        p.textContent = deviceText(text);
        container.appendChild(p);
        lastLineEl = p;
    });

    // 最終行の後に「読了の闇」を置く（唐突に終わる絶望感）
    // 音タグが「音を書いた行」より一行早く付いている古い話の救済: 次の行に音が書かれていれば、そちらへ移す(2026-10)
    if (window.ImakokoCues) {
        const els = [...container.querySelectorAll(".story-line")];
        els.forEach((el, i) => {
            const g = el.getAttribute("data-gimmicks"); if (!g) return;
            const keep = [], move = [];
            g.split(",").forEach(tag => {
                if (!tag.startsWith("[SOUND:")) { keep.push(tag); return; }
                const prev = i > 0 ? els[i - 1].textContent : "";
                if (ImakokoCues.match(tag, el.textContent, prev).ok) keep.push(tag);
                else if (els[i + 1] && ImakokoCues.match(tag, els[i + 1].textContent).ok) move.push(tag);
                else keep.push(tag);   // どこにも無い → scheduleSound が鳴らさない
            });
            if (move.length) {
                keep.length ? el.setAttribute("data-gimmicks", keep.join(",")) : el.removeAttribute("data-gimmicks");
                const n = els[i + 1], ex = n.getAttribute("data-gimmicks");
                n.setAttribute("data-gimmicks", ex ? ex + "," + move.join(",") : move.join(","));
            }
        });
    }

    const endSpace = document.createElement("p");
    endSpace.className = "story-line story-end";
    endSpace.textContent = "";
    container.appendChild(endSpace);

    // 最終テキスト行が一度でも中央に来た(=読まれた)かのフラグ。エンドロールの早出し防止に使う
    const lastRealLine = lastLineEl;
    let lastLineRead = false;

    // ---- 3.5 出典エンドロール（種明かし）の構築 -------------------------------
    // 「現実を巻き込む」の製品化: 怪談の錨が事実だったことを出典付きで開示し、
    // 検証行動とシェアへ誘導する。creditsを持つ作品でのみ表示される。
    const endroll = document.getElementById("endroll");
    if (story.credits && story.credits.length) {
        const factsEl = document.getElementById("er-facts");
        story.credits.forEach((c, i) => {
            const div = document.createElement("div");
            div.className = "er-fact";
            div.innerHTML =
                `<span class="er-num">${"壱弐参肆伍陸漆捌玖拾"[i] || (i + 1)}</span>` +
                `<p>${escapeHtml(c.fact)}</p>` +
                (c.url
                    ? `<a href="${encodeURI(c.url)}" target="_blank" rel="noopener">出典: ${escapeHtml(c.source || "資料")}</a>`
                    : `<span class="er-src">出典: ${escapeHtml(c.source || "資料")}</span>`);
            factsEl.appendChild(div);
        });
        document.getElementById("er-note").textContent = story.creditsNote || "この怪談はフィクションです。ただし、土地の事実は本物です。";
        renderSoundCredits();

        // シェア（予告編型: 怪談の冒頭80字 + 生まれた座標のGoogleマップリンク + ハッシュタグ）
        const shareBtn = document.getElementById("er-share");
        // 2026-10: 画像カード（題・土地・最初の一文）を前もって作っておく。
        // ボタンを押してから作ると、iPhoneでは「タップ直後」の扱いが切れてシェア画面が開かないことがあるため
        let cardFile = null;
        const prepCard = async () => {
            if (cardFile || !window.ImakokoShareCard) return cardFile;
            try {
                const blob = await ImakokoShareCard.make(story, { timeWord: timeBand(new Date().getHours()) });
                if (blob) cardFile = new File([blob], "imakoko-kaidan.jpg", { type: "image/jpeg" });
            } catch (e) { cardFile = null; }
            return cardFile;
        };
        setTimeout(prepCard, 4000);   // 読み始めて少ししてから裏で作る(読書の邪魔をしない)
        shareBtn.addEventListener("click", async () => {
            const { text, url } = buildShare(story);
            const file = cardFile || await prepCard();
            try {
                if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], text: text + "\n" + url });
                } else if (file) {
                    showCardPreview(file, text, url);      // 画像を渡せない端末(主にPC): 見せて保存・コピー
                } else if (navigator.share) {
                    await navigator.share({ text, url });
                } else {
                    await navigator.clipboard.writeText(text + "\n" + url);
                    shareBtn.textContent = "コピーしました。あとは、囁くだけ。";
                    setTimeout(() => shareBtn.textContent = "この場所の秘密を、誰かに教える", 2500);
                }
            } catch (e) { /* キャンセルは無視 */ }
        });

        /** 画像を直接シェアできない端末向け: カードを表示し、保存とコピーを用意する */
        function showCardPreview(file, text, url) {
            const old = document.getElementById("card-preview"); if (old) old.remove();
            const wrap = document.createElement("div");
            wrap.id = "card-preview";
            const src = URL.createObjectURL(file);
            wrap.innerHTML = `<div class="cp-inner">
                <img src="${src}" alt="シェア用の画像カード">
                <div class="cp-actions">
                    <a class="er-btn" href="${src}" download="imakoko-kaidan.jpg">画像を保存</a>
                    <button type="button" class="er-btn" id="cp-copy">文章とリンクをコピー</button>
                    <button type="button" class="er-btn er-link" id="cp-close">閉じる</button>
                </div></div>`;
            document.body.appendChild(wrap);
            wrap.querySelector("#cp-close").onclick = () => { wrap.remove(); URL.revokeObjectURL(src); };
            wrap.querySelector("#cp-copy").onclick = async (ev) => {
                try { await navigator.clipboard.writeText(text + "\n" + url); ev.target.textContent = "コピーしました"; } catch (e) { /* noop */ }
            };
        }

        // ── 星5つの評価（自分のコレクション=IndexedDBのピンの時だけ）。骨格の良し悪し集計に使う。
        if (pinId && story.id && typeof ImakokoDB !== "undefined") {
            const rateBox = document.getElementById("er-rate");
            const starsBox = document.getElementById("er-stars");
            const thanks = document.getElementById("er-rate-thanks");
            if (rateBox && starsBox) {
                rateBox.hidden = false;
                const stars = Array.from(starsBox.querySelectorAll(".er-star"));
                const paint = (n) => stars.forEach(s => s.classList.toggle("on", Number(s.dataset.v) <= n));
                paint(story.rating || 0);
                stars.forEach(star => {
                    star.addEventListener("mouseenter", () => paint(Number(star.dataset.v)));
                    star.addEventListener("click", async () => {
                        const v = Number(star.dataset.v);
                        paint(v);
                        try {
                            await ImakokoDB.setRating(story.id, v);
                            story.rating = v;
                            if (thanks) thanks.hidden = false;
                        } catch (e) { /* 保存失敗は黙って続行 */ }
                        // 公開集約: 受け口URLが設定されていれば、骨格・星・時刻だけ送る(座標なし・撃ちっぱなし)
                        try {
                            const ep = (window.IMAKOKO_CONFIG && window.IMAKOKO_CONFIG.ratingEndpoint) || "";
                            if (ep) {
                                fetch(ep, {
                                    method: "POST", mode: "no-cors",
                                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                                    body: JSON.stringify({
                                        skeleton: story.skeleton || "", rating: v, ts: new Date().toISOString(),
                                        spot: story.spotName || "", area: story.area || ""   // 改善用(生GPSは送らない)
                                    })
                                }).catch(() => {});
                            }
                        } catch (e) { /* 送信失敗も無視 */ }
                    });
                });
                starsBox.addEventListener("mouseleave", () => paint(story.rating || 0));
            }
        }

        // 最終行を読み終えて(lastLineRead)から末尾の闇に達したとき、
        // 「灯りを落とす」誘導を出し、タップで初めてエンドロールを表示する。
        // 自動で先出ししない＝最後の1行が読まれる前にクレジットが出る問題を防ぐ。
        // 最後の本文行が画面から「完全に」消えた(=スクロールし切って文章が無くなった)瞬間に、
        // すぐ誘導ボタンを出す。逆スクロールで文章が画面に戻ってきたらボタンは隠す(また送り切れば再表示)。
        // rootMarginは0=ビューポート全体で判定。lastLineRead(=一度読まれた)を条件に初回は無視する。
        let endingStarted = false;   // 音のフェードは一度だけ
        let cueDismissed = false;    // ボタンを押してエンドロールへ進んだら、もう出さない
        const exitObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!lastLineRead || cueDismissed) return;
                if (!entry.isIntersecting) {
                    // 文章が画面から消えた → 初回だけ音を静かに消し、ボタンをすぐ出す
                    if (!endingStarted) {
                        endingStarted = true;
                        stopEnvironmentEffects();
                        if (typeof HorrorAudio !== "undefined" && HorrorAudio.fadeOut) HorrorAudio.fadeOut(3.0);
                    }
                    showEndCue();
                } else {
                    // 逆スクロールで文章が戻ってきた → ボタンを隠す
                    hideEndCue();
                }
            });
        }, { root: container, threshold: 0 });
        exitObserver.observe(lastRealLine);

        let cueEl = null;
        function showEndCue() {
            if (cueDismissed) return;
            // 2026-10: 読了の儀式＝ろうそく。タップか息で消すと、闇のあとエンドロールへ
            if (window.ImakokoCandle) {
                ImakokoCandle.show({ onOut: () => {
                    cueDismissed = true;
                    exitObserver.disconnect();
                    endroll.classList.add("show");
                } });
                return;
            }
            if (cueEl) { cueEl.style.opacity = "1"; cueEl.style.pointerEvents = "auto"; return; }
            const cue = document.createElement("button");
            cue.id = "end-cue";
            cue.type = "button";
            cue.textContent = "……そっと、灯りを落とす";
            cue.style.cssText =
                "position:fixed;left:50%;bottom:9vh;transform:translateX(-50%);z-index:160;" +
                "background:rgba(8,10,16,.72);color:#cfd3e0;border:1px solid rgba(170,180,210,.35);" +
                "border-radius:999px;padding:.7em 1.6em;font:14px/1.4 'Shippori Mincho',serif;" +
                "letter-spacing:.08em;cursor:pointer;opacity:0;transition:opacity 0.6s ease;" +
                "-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);";
            cue.addEventListener("click", () => {
                cueDismissed = true;
                exitObserver.disconnect();
                cue.style.opacity = "0";
                setTimeout(() => cue.remove(), 600);
                endroll.classList.add("show");
            });
            document.body.appendChild(cue);
            cueEl = cue;
            requestAnimationFrame(() => { cue.style.opacity = "1"; });
        }
        function hideEndCue() {
            if (window.ImakokoCandle) ImakokoCandle.hide();
            if (cueEl) { cueEl.style.opacity = "0"; cueEl.style.pointerEvents = "none"; }
        }
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    /** シェア文面を組む: 冒頭80字(予告編) + Googleマップリンク + ハッシュタグ */
    function buildShare(s) {
        // 本文行(ギミックタグ・空行を除く)を連結し、冒頭を切り出す
        const body = (s.lines || [])
            .map(l => (l || "").trim())
            .filter(l => l && !/^\[(SOUND|VISUAL):[A-Z_]+\]$/.test(l))
            .join("");
        let head = body.slice(0, 80);
        if (body.length > 80) head += "…";

        // 座標があればGoogleマップ、無ければこのページURL
        const url = (typeof s.lat === "number" && typeof s.lon === "number")
            ? `https://www.google.com/maps?q=${s.lat},${s.lon}`
            : location.href;

        // 2026-10: 文面には町名まで（例:「東京都 南千住四丁目のあたりで」）。地図リンクの座標はそのまま
        const place = [s.prefecture, s.placeName].filter(v => v && v !== "名前のない場所").join(" ");
        const where = place ? `${place}のあたりで` : "いまここで";
        const text = `${head}\n\n― ${where}、この話が生まれた。\n#イマココ怪談`;
        return { text, url };
    }

    /** エンドロールに、この話で鳴った音の出典を載せる（Freesound CC0。クレジット不要だが敬意として明記） */
    async function renderSoundCredits() {
        const box = document.getElementById("er-sound");
        if (!box) return;
        try {
            const all = await (await fetch("./assets/sound/credits.json", { cache: "no-cache" })).json();
            const amb = ambienceOf(story);
            const used = new Set(["amb_" + amb, ...usedSfxNames().map(n => "sfx_" + n)]);
            const KIND = { amb_rain: "環境音（雨の夜）", amb_residential: "環境音（夜の住宅街）", amb_water: "環境音（水辺）",
                amb_forest: "環境音（山・林）", amb_tunnel: "環境音（地下道）", amb_room: "環境音（深夜の部屋）",
                amb_apartment: "環境音（団地の廊下）", amb_hospital: "環境音（古い建物の中）", amb_railway: "環境音（線路沿い）", amb_alley: "環境音（夜の裏路地）", sfx_chime: "夕方のチャイム",
                sfx_thump: "落下音", sfx_heartbeat: "鼓動", sfx_step: "足音", sfx_static: "砂嵐", sfx_ringing: "耳鳴り", sfx_voice: "ささやき", sfx_rain: "強まる雨",
                sfx_knock: "ノック", sfx_footstep: "足音", sfx_door: "ドア", sfx_phone: "電話", sfx_child: "笑い声",
                sfx_crossing: "踏切", sfx_scratch: "ひっかく音", sfx_breath: "息づかい", sfx_water: "水滴" };
            const rows = all.filter(c => used.has(c.key));
            if (!rows.length) return;
            box.innerHTML = `<p class="er-sound-title">この話で鳴った音</p>` + rows.map(c =>
                `<p class="er-sound-row"><span>${escapeHtml(KIND[c.key] || c.key)}</span>` +
                `<a href="${encodeURI(c.url)}" target="_blank" rel="noopener">「${escapeHtml(c.title.replace(/\.(wav|aif|aiff|flac|m4a|mp3)$/i, ""))}」 ${escapeHtml(c.author)} / ${escapeHtml(c.source)}（${escapeHtml(c.license)}）</a></p>`
            ).join("");
            box.hidden = false;
        } catch (e) { /* 出典ファイルが読めなくても本編には影響させない */ }
    }

    /** 怖さ「控えめ」または端末の視差効果を減らす設定のとき true（強い点滅・揺れを出さない） */
    function softFx() {
        if (window.ImakokoLamp) return !!ImakokoLamp.soft;
        try { return ImakokoSettings.scareLevel() === "mild"; } catch (e) { return false; }
    }

    // ---- 3.8 音（2026-10）: 舞台の環境音の決定と、使う効果音の一覧 ----------------
    const TAG_TO_SFX = {
        "[SOUND:THUMP]": "thump", "[SOUND:HEARTBEAT]": "heartbeat", "[SOUND:STATIC]": "static", "[SOUND:NOISE]": "static",
        "[SOUND:RINGING]": "ringing", "[SOUND:VOICE]": "voice", "[SOUND:RAIN]": "rain", "[SOUND:KNOCK]": "knock",
        "[SOUND:FOOTSTEP]": "step", "[SOUND:DOOR]": "door", "[SOUND:PHONE]": "phone", "[SOUND:CHILD]": "child",
        "[SOUND:CROSSING]": "crossing", "[SOUND:SCRATCH]": "scratch", "[SOUND:BREATH]": "breath", "[SOUND:WATER]": "water", "[SOUND:CHIME]": "chime"
    };
    function usedSfxNames() {
        const set = new Set();
        (story.lines || []).forEach(l => { const k = TAG_TO_SFX[String(l).trim()]; if (k) set.add(k); });
        return [...set];
    }
    /** 生成時にAIが選んだ舞台(story.ambience)。古い話は本文の言葉から推定する */
    function ambienceOf(st) {
        const list = (HorrorAudio.AMBIENCES || []);
        if (st.ambience && list.includes(st.ambience)) return st.ambience;
        const text = (st.lines || []).join("");
        const rules = [
            ["railway", /線路|踏切|電車|列車|終電|ホーム|鉄橋|貨物/],
            ["hospital", /病院|病棟|診察|医院|廃病院|廃校|校舎|廃墟/],
            ["tunnel", /地下道|地下通路|トンネル|地下駐車場|構内|改札|高架下/],
            ["water", /川|河原|河川|池|沼|海|浜|港|堤防|橋の下|水辺|用水路/],
            ["forest", /山道|山中|森|林|神社|鳥居|祠|寺|墓地|墓|参道|石段/],
            ["rain", /雨|傘|濡れ/],
            ["apartment", /団地|アパート|マンション|共用廊下|外廊下|階段の踊り場|エレベーター/],
            ["alley", /路地|裏通り|飲み屋|繁華街|歓楽街|スナック|ネオン|駅前/],
            ["room", /部屋|自室|寝室|布団|押し入れ|天井|廊下/]
        ];
        for (const [k, re] of rules) if (re.test(text)) return k;
        return "residential";
    }

    // ---- 4. Audio初期化（iOS制限解除）とスタート ------------------------------
    let started = false;
    const initAndStart = () => {
        if (started) return;
        started = true;
        HorrorAudio.init();
        // 舞台の環境音（1話1種類）と、この話で鳴る効果音の先読み
        try {
            HorrorAudio.preload(usedSfxNames());
            setTimeout(() => HorrorAudio.startAmbience(ambienceOf(story)), 600);
        } catch (e) { /* 音が無くても読書は続ける */ }
        startScreen.style.opacity = "0";
        setTimeout(() => {
            startScreen.style.display = "none";
            startRandomEnvironmentEffects();
        }, 1000);
        // 離脱ボタンを表示
        const exitBtn = document.getElementById("exit-btn");
        if (exitBtn) exitBtn.classList.add("visible");
        // 灯りが点いた直後に中央の行を明るくする
        scheduleSpotlight();
        // 語り手の読み上げ（声ON/OFFボタンを置き、設定ONのときだけ読み始める。OFFなら通信も料金もなし）
        let narrating = false;
        if (window.ImakokoNarrator) {
            const lineEls = [...container.querySelectorAll(".story-line")].filter(el => el !== endSpace);
            narrating = ImakokoNarrator.attach({
                container, lineEls, rawLines: story.lines,
                storyId: pinId || story.id, endSpace
            });
        }
        // 一瞬の恐怖演出（回数・位置は毎回くじ引き。0回の話もある）
        if (window.ImakokoScare) {
            const scareLines = [...container.querySelectorAll(".story-line")].filter(el => el !== endSpace);
            ImakokoScare.arm({ lineEls: scareLines });
        }
        // 初回のみスワイプ案内を表示（語りで自動的に進むときは出さない）
        if (!narrating) maybeShowSwipeHint();
    };

    // ---- 初回スワイプ案内（縦書き右→左。一度操作したら消え、以後出さない） ----
    function maybeShowSwipeHint() {
        const hint = document.getElementById("swipe-hint");
        if (!hint) return;
        if (localStorage.getItem("imakoko_swipe_hint_seen")) return;

        setTimeout(() => hint.classList.add("show"), 1400); // 灯りが点いて少し経ってから

        let dismissed = false;
        const dismiss = () => {
            if (dismissed) return;
            dismissed = true;
            localStorage.setItem("imakoko_swipe_hint_seen", "1");
            hint.classList.remove("show");
            hint.classList.add("fade");
            setTimeout(() => { hint.style.display = "none"; }, 600);
            container.removeEventListener("scroll", dismiss);
            container.removeEventListener("touchmove", dismiss);
        };
        // 実際にスクロール/スワイプしたら消す。保険で8秒後にも自動で消す
        container.addEventListener("scroll", dismiss, { passive: true });
        container.addEventListener("touchmove", dismiss, { passive: true });
        setTimeout(dismiss, 8000);
    }
    startScreen.addEventListener("click", initAndStart);
    startScreen.addEventListener("touchstart", initAndStart, { passive: true });

    // 離脱ボタン（2026-10）: いきなり戻さず、記録は消えないことを伝えてから確認する
    const exitBtn = document.getElementById("exit-btn");
    function leaveNow() {
        if (window.ImakokoNarrator) ImakokoNarrator.stop();
        if (window.ImakokoCandle) ImakokoCandle.stop();
        if (typeof HorrorAudio !== "undefined") HorrorAudio.stopAll();
        stopEnvironmentEffects();
        location.href = "./index.html";
    }
    function askLeave() {
        if (document.getElementById("leave-dialog")) return;
        // 確認のあいだは、声・音・灯りの乱れを止めておく
        if (window.ImakokoNarrator) ImakokoNarrator.pause();
        if (typeof HorrorAudio !== "undefined") HorrorAudio.stopAll();
        if (window.ImakokoLamp) ImakokoLamp.pause();
        const saved = !!pinId;
        const wrap = document.createElement("div");
        wrap.id = "leave-dialog";
        wrap.setAttribute("role", "dialog");
        wrap.setAttribute("aria-modal", "true");
        wrap.setAttribute("aria-labelledby", "ld-title");
        wrap.innerHTML = `<div class="ld-inner">
            <p id="ld-title" class="ld-title">ここで、読むのをやめますか？</p>
            <p class="ld-body">${saved
                ? "この話は消えません。<br>「集めた怪談の地図」に記録されているので、<br>いつでも最初から読み返せます。"
                : "この話は、あとからいつでも読み返せます。"}</p>
            <div class="ld-btns">
                <button type="button" class="ld-btn ld-stay">続きを読む</button>
                <button type="button" class="ld-btn ld-leave">やめてタイトルへ</button>
            </div></div>`;
        document.body.appendChild(wrap);
        const close = () => {
            wrap.remove();
            document.removeEventListener("keydown", onKey);
            if (typeof HorrorAudio !== "undefined") HorrorAudio.resumeAll();
            if (window.ImakokoLamp) ImakokoLamp.resume();
            if (window.ImakokoNarrator) ImakokoNarrator.resume();
            exitBtn && exitBtn.focus();
        };
        const onKey = (e) => { if (e.key === "Escape") close(); };
        document.addEventListener("keydown", onKey);
        wrap.querySelector(".ld-stay").onclick = close;
        wrap.querySelector(".ld-leave").onclick = leaveNow;
        wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
        wrap.querySelector(".ld-stay").focus();
    }
    if (exitBtn) {
        exitBtn.addEventListener("click", (e) => { e.preventDefault(); askLeave(); });
    }

    // ---- 4.5 音の後始末: ページを離れる/タブを隠すと鳴り続けないように ----------
    function silenceEverything() {
        if (typeof HorrorAudio !== "undefined") HorrorAudio.stopAll();
        stopEnvironmentEffects(); // 街灯点滅ループ(spark音)も止める
    }
    // タブ非表示・別アプリ切替・スリープ
    // 2026-10: タブを隠しただけなら街灯・恐怖演出は「一時停止」にとどめ、戻ったら再開する
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            if (typeof HorrorAudio !== "undefined") HorrorAudio.stopAll();
            if (window.ImakokoLamp) ImakokoLamp.pause();
        } else {
            if (typeof HorrorAudio !== "undefined") HorrorAudio.resumeAll();
            if (window.ImakokoLamp) ImakokoLamp.resume();
        }
    });
    // ページ離脱・戻る・閉じる(pagehageはbfcache対応)。マイクも必ず解放する
    window.addEventListener("pagehide", () => {
        silenceEverything();
        if (window.ImakokoCandle) ImakokoCandle.stop();
    });
    window.addEventListener("beforeunload", silenceEverything);

    // ---- 5a. スポットライトの段階的な明るさ（スクロール連動）--------------------
    // 各行の中心が画面中央からどれだけ離れているかで、明るさを4段階に振り分ける。
    //   中央(lit) → 隣(near1=やや暗) → 2つ隣(near2=もっと暗) → 3つ以遠(クラス無し=消える)
    let spotRAF = null;
    function scheduleSpotlight() {
        if (spotRAF) return;
        spotRAF = requestAnimationFrame(updateSpotlight);
    }
    function updateSpotlight() {
        spotRAF = null;
        const cx = window.innerWidth / 2;
        const lines = container.querySelectorAll(".story-line");
        if (!lines.length) return;
        const arr = [];
        lines.forEach(el => {
            const r = el.getBoundingClientRect();
            arr.push({ el, c: r.left + r.width / 2 });
        });
        arr.forEach(o => { o.d = Math.abs(o.c - cx); });
        arr.sort((a, b) => a.d - b.d);
        // 行の間隔Uを推定（行ごとに幅が違うので、最近接2行の中心距離から都度求める）
        let U = arr.length > 1 ? Math.abs(arr[1].c - arr[0].c) : window.innerWidth * 0.12;
        if (!U || U < 8) U = window.innerWidth * 0.12;
        arr.forEach(o => {
            const t = o.d / U; // 0=中央, 1=±1, 2=±2, …
            o.el.classList.remove("lit", "near1", "near2");
            if (t <= 0.5) o.el.classList.add("lit");
            else if (t <= 1.5) o.el.classList.add("near1");
            else if (t <= 2.5) o.el.classList.add("near2");
            // それ以遠はクラス無し＝.story-lineのopacity:0で消える
        });
        // 照明の真下(lit)に来て、そこで止まった行だけで演出を起こす(2026-10)。
        // 以前は「中央付近に入った瞬間」で判定しており、隣の行の余白が先に触れて一行早く鳴っていた
        const litEl = arr[0] && arr[0].el.classList.contains("lit") ? arr[0].el : null;
        if (litEl !== litCandidate) {
            litCandidate = litEl;
            clearTimeout(litDwell);
            if (litEl) litDwell = setTimeout(() => { if (litEl.classList.contains("lit")) fireLineEvents(litEl); }, 300);
        }
    }
    let litCandidate = null, litDwell = 0;

    /** 行が読まれ始めたときの演出(音・視覚・無音) */
    function fireLineEvents(el) {
        if (startScreen && startScreen.style.display !== "none") return;   // 灯りをつける前は何も起こさない
        if (el.hasAttribute("data-gimmicks") && !el.hasAttribute("data-triggered")) {
            el.setAttribute("data-triggered", "true");
            el.getAttribute("data-gimmicks").split(",")
                .forEach(tag => tag.startsWith("[SOUND:") ? scheduleSound(tag, el) : triggerGimmick(tag, el));
        }
        // 「しん、と静まり返った」行は、タグが無くても(古い話でも)環境音を止める
        const tx = el.textContent || "";
        if (!el.hasAttribute("data-hushed") && window.ImakokoCues && ImakokoCues.isHush(tx)
            && !(el.getAttribute("data-gimmicks") || "").includes("[SOUND:SILENCE]")) {
            el.setAttribute("data-hushed", "1");
            scheduleSound("[SOUND:SILENCE]", el);
        }
    }

    // ---- 5b. Intersection Observer: 中央の行でギミック発動・既読判定 -------------
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            if (entry.target === lastRealLine) lastLineRead = true; // 最終行が読まれた
            // 演出の発動は updateSpotlight → fireLineEvents（照明の真下で止まった行）へ移した(2026-10)
        });
    }, { root: container, rootMargin: "0px -40% 0px -40%", threshold: 0 });

    document.querySelectorAll(".story-line").forEach(line => observer.observe(line));

    // スクロール・リサイズで明るさを更新（初回も一度走らせて中央の行を点ける）
    container.addEventListener("scroll", scheduleSpotlight, { passive: true });
    window.addEventListener("resize", scheduleSpotlight);
    requestAnimationFrame(updateSpotlight);

    // ---- 6. ギミック発動ディスパッチャ ----------------------------------------
    // ---- 5c. 音は「本文がその音を書いている場所」で鳴らす(2026-10) ---------------
    //  - 本文に手がかり(擬音・音の言葉)が無いタグは鳴らさない(古い話にも適用)
    //  - 鳴らす瞬間: 語り(声)が読んでいる行なら、擬音が読まれるタイミング。黙読なら行の中の位置から推定
    //  - 足音は擬音の数だけ歩く(「コツッ、コツッ、コツッ」→3歩)
    const allLines = () => [...container.querySelectorAll(".story-line")];
    function scheduleSound(tag, el) {
        const cues = window.ImakokoCues;
        const lines = allLines();
        const idx = lines.indexOf(el);
        const prev = idx > 0 ? lines[idx - 1].textContent : "";
        const m = cues ? cues.match(tag, el.textContent, prev) : { ok: true, pos: 0 };
        if (!m.ok) { console.info("[音] 本文に手がかりが無いので鳴らさない:", tag); return; }
        const fire = () => {
            if (tag !== "[SOUND:SILENCE]") endSilence();   // 何か音がしたら、無音は解ける
            if (tag === "[SOUND:FOOTSTEP]") { HorrorAudio.footstep(cues ? cues.count(tag, el.textContent) : 0); return; }
            triggerGimmick(tag, el);
        };
        const narr = window.ImakokoNarrator;
        const narrating = narr && narr.timing && window.ImakokoSettings && ImakokoSettings.voiceEnabled()
            && narr.debug && narr.debug() && !narr.debug().stopped;
        if (narrating) {
            // 声がこの行を読み始めるのを待ち(最大6秒)、擬音の位置で鳴らす
            const t0 = performance.now();
            (function wait() {
                const t = narr.timing(el);
                if (t && t.stage === "playing" && t.dur > 0) {
                    const delay = Math.max(0, m.pos * t.dur - t.elapsed - 0.05) * 1000;
                    setTimeout(fire, delay);
                } else if (performance.now() - t0 < 6000) setTimeout(wait, 60);
                else fire();
            })();
            return;
        }
        const len = (el.textContent || "").length;
        setTimeout(fire, Math.min(2500, 250 + m.pos * len * 110));   // 黙読: 1文字約0.11秒で目が届く位置
    }

    let silenceAt = -1, silenceWatch = 0;
    function doSilence(el) {
        HorrorAudio.silence();
        if (window.ImakokoLamp) ImakokoLamp.pause();      // 灯りの揺らぎも息をひそめる
        silenceAt = Math.max(0, allLines().indexOf(el));
        clearInterval(silenceWatch);
        silenceWatch = setInterval(() => {               // 3行進んだら、ゆっくり戻す
            const lit = allLines().findIndex(l => l.classList.contains("lit"));
            if (lit >= silenceAt + 3) endSilence();
        }, 500);
    }
    function endSilence() {
        if (silenceAt < 0) return;
        silenceAt = -1;
        clearInterval(silenceWatch);
        if (HorrorAudio.unsilence) HorrorAudio.unsilence(4);
        if (window.ImakokoLamp) ImakokoLamp.resume();
    }

    function triggerGimmick(tag, targetElement) {
        switch (tag) {
            // ===== 聴覚 =====
            case "[SOUND:THUMP]":
                HorrorAudio.thump(); break;          // 落下音
            case "[SOUND:HEARTBEAT]":
                HorrorAudio.heartbeat(); break;      // 心音
            case "[SOUND:STATIC]":
            case "[SOUND:NOISE]":
                HorrorAudio.staticNoise(); break;
            case "[SOUND:RINGING]":
                HorrorAudio.ringing(); break;
            case "[SOUND:VOICE]":
                HorrorAudio.voice(); break;
            case "[SOUND:RAIN]":
                HorrorAudio.rain(); break;
            case "[SOUND:SILENCE]":
                doSilence(targetElement);            // 環境音をピタッと止める(数行進んだら戻す)
                break;
            case "[SOUND:KNOCK]":
                HorrorAudio.knock(); break;
            case "[SOUND:FOOTSTEP]":
                HorrorAudio.footstep(); break;
            case "[SOUND:DOOR]":     HorrorAudio.door(); break;
            case "[SOUND:PHONE]":    HorrorAudio.phone(); break;
            case "[SOUND:CHILD]":    HorrorAudio.child(); break;
            case "[SOUND:CROSSING]": HorrorAudio.crossing(); break;
            case "[SOUND:SCRATCH]":  HorrorAudio.scratch(); break;
            case "[SOUND:BREATH]":   HorrorAudio.breath(); break;
            case "[SOUND:WATER]":    HorrorAudio.water(); break;
            case "[SOUND:CHIME]":    HorrorAudio.chime(); break;

            // ===== 視覚 =====
            case "[VISUAL:SHAKE]":
                if (softFx()) break;                 // 怖さ「控えめ」: 揺らさない
                document.body.classList.add("fx-shake");
                setTimeout(() => document.body.classList.remove("fx-shake"), 700);
                break;
            case "[VISUAL:FLASH]": {
                if (softFx()) break;                 // 怖さ「控えめ」: 赤い閃光を出さない
                const el = document.getElementById("fx-overlay");
                el.classList.add("fx-flash");
                setTimeout(() => el.classList.remove("fx-flash"), 400);
                break;
            }
            case "[VISUAL:BLACKOUT]": {
                const el = document.getElementById("fx-overlay");
                el.classList.add("fx-blackout");
                setTimeout(() => el.classList.remove("fx-blackout"), 2600);
                break;
            }
            case "[VISUAL:BLINK]": {
                // 街灯がふっと消えて、迷いながら戻る（lamp.js）。無い環境では従来の黒点滅
                if (window.ImakokoLamp && !envStopped) { ImakokoLamp.event("dropout"); break; }
                const el = document.getElementById("fx-overlay");
                el.classList.remove("fx-blink");
                void el.offsetWidth;
                el.classList.add("fx-blink");
                setTimeout(() => el.classList.remove("fx-blink"), 1000);
                break;
            }
            case "[VISUAL:GHOST]": {
                // ひとつ前（右側=既読側）の行を、赤黒いシルエットとして浮かび上がらせる
                const prev = targetElement.previousElementSibling;
                if (prev && prev.classList.contains("story-line")) {
                    prev.classList.add("ghost-silhouette");
                    setTimeout(() => prev.classList.remove("ghost-silhouette"), 1200);
                }
                break;
            }
            case "[VISUAL:STREETLIGHT_FLICKER]":
                flickerSpotlight();
                break;
            // [VISUAL:MOTH](蛾) と [VISUAL:BATTERY](偽バッテリー警告)は廃止(2026-06-26)。
            // 古いピンにタグが残っていても、何もしない。
            case "[VISUAL:MOTH]":
            case "[VISUAL:BATTERY]":
                break;
            default:
                console.warn("Unknown gimmick:", tag);
        }
    }

    // ---- 8. ランダム環境演出（街灯の点滅） -------------------------------------
    let envTimer = null;
    let envStopped = false;

    // 2026-10: 街灯のゆらぎは lamp.js（ImakokoLamp）に一本化。ランダム間隔・何も起きない時間あり。
    function startRandomEnvironmentEffects() {
        if (envStopped) return;
        if (window.ImakokoLamp) ImakokoLamp.start();
    }
    function stopEnvironmentEffects() {
        envStopped = true;
        if (envTimer) clearTimeout(envTimer);
        if (window.ImakokoLamp) ImakokoLamp.stop();
        if (window.ImakokoScare) ImakokoScare.disarm();
    }
    function flickerSpotlight() {
        if (window.ImakokoLamp) ImakokoLamp.event("stutter");
    }

    // [VISUAL:MOTH](蛾のパーティクル)は廃止(2026-06-26)。Canvas演出ごと削除。
});
