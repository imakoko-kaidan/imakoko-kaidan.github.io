/**
 * イマココ怪談 — シェア用の画像カード（2026-10）
 *
 * 端末の中（canvas）で 1080×1350（縦長 4:5。X・Instagram・LINEでそのまま見やすい）の画像を作る。
 *  - 背景: 読む画面と同じ街灯の闇
 *  - 右から縦書き: 題 → 前置きの次の一文（本題の始まり）
 *  - 下: 「◯◯のあたりで、この話が生まれた。」・#イマココ怪談・URL
 * 外部にはどこにも送らない（作った画像をどう使うかは本人がシェア画面で決める）。
 *
 * 公開API: window.ImakokoShareCard = { make(story, opts) → Promise<Blob> }
 */
(function () {
    "use strict";
    const W = 1080, H = 1350;
    const SITE = "imakoko-kaidan.github.io";
    const FONT = '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif';
    // 縦書きで90度回す文字（長音・ダッシュ・三点リーダー・括弧など）
    const ROTATE = new Set([..."ー—―‐-…‥〜～（）()「」『』［］【】〔〕＜＞<>＝=：:"]);
    // 縦書きで右上へ寄せる句読点・小書き文字
    const PUNCT = new Set([..."、。，．,."]);
    const SMALL = new Set([..."ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ"]);

    function loadImage(src) {
        return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    }

    /** 縦書き1列ぶんを描く。戻り値: 描いた文字数 */
    function drawColumn(g, chars, x, y, size, maxH) {
        const step = size * 1.08;
        let n = 0;
        for (const ch of chars) {
            if ((n + 1) * step > maxH) break;
            const cy = y + n * step + size / 2;
            g.save();
            if (ROTATE.has(ch)) {
                g.translate(x, cy); g.rotate(Math.PI / 2); g.fillText(ch, 0, 0);
            } else if (PUNCT.has(ch)) {
                g.fillText(ch, x + size * 0.6, cy - size * 0.55);
            } else if (SMALL.has(ch)) {
                g.fillText(ch, x + size * 0.1, cy - size * 0.08);
            } else {
                g.fillText(ch, x, cy);
            }
            g.restore();
            n++;
        }
        return n;
    }

    /** 文字列を、縦の列に流し込む（右から左へ）。戻り値: 使った列数 */
    function drawVertical(g, text, xRight, y, size, maxH, colGap, maxCols) {
        let chars = [...text];
        let col = 0;
        while (chars.length && col < maxCols) {
            const x = xRight - col * (size + colGap);
            const used = drawColumn(g, chars, x, y, size, maxH);
            if (!used) break;
            chars = chars.slice(used);
            col++;
        }
        return col;
    }

    // 語り手の前置き（「この土地の古い時間を拾い集めていると…」「◯◯から聞いた話がある」）らしい文
    const FRAME = /聞き集め|拾い集め|尋ねて|尋ね歩|行き当たる|突き当たる|話がある|聞いた話|から聞いた|聞かせてくれ|話してくれ|伝わって|伝わる話|言い伝え|辿る|辿ると|掘り起こ|この町のこと|この土地の|仮に.{1,4}としておく|という。$|だという。$|といいます。$|だそうです。$|経験した|体験した/;

    /** カードに載せる一文: 前置きを飛ばして、本題に入った最初の一文（2026-10・企画者判断B） */
    function hookSentence(story, timeWord) {
        const lines = (story.lines || []).map(l => String(l || "").trim())
            .filter(l => l && !/^\[(SOUND|VISUAL):[A-Z_]+\]$/.test(l));
        let pick = "";
        for (let i = 1; i < Math.min(lines.length, 5); i++) {
            if (!FRAME.test(lines[i])) { pick = lines[i]; break; }
        }
        if (!pick) pick = lines[2] || lines[1] || lines[0] || "";
        const t = pick.replaceAll("{{TIME}}", timeWord || "宵");
        return t.length > 70 ? t.slice(0, 68) + "……" : t;
    }

    async function make(story, opts) {
        const o = opts || {};
        try { await document.fonts.load(`64px "Shippori Mincho"`); } catch (e) { /* 代替フォントで描く */ }
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const g = c.getContext("2d");

        // 背景: 読む画面と同じ街灯の闇（中央を縦長に切り出す）
        g.fillStyle = "#030408"; g.fillRect(0, 0, W, H);
        const bg = await loadImage("./assets/read_bg.jpg");
        if (bg) {
            const scale = H / bg.height * 1.15;
            const dw = bg.width * scale, dh = bg.height * scale;
            g.globalAlpha = 0.85;
            g.drawImage(bg, (W - dw) / 2, -dh * 0.06, dw, dh);
            g.globalAlpha = 1;
        }
        // 文字を読みやすくする暗幕（下ほど濃く）と周辺減光
        let gr = g.createLinearGradient(0, 0, 0, H);
        gr.addColorStop(0, "rgba(3,4,8,.25)"); gr.addColorStop(0.55, "rgba(3,4,8,.45)"); gr.addColorStop(1, "rgba(3,4,8,.92)");
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
        gr = g.createRadialGradient(W / 2, H * 0.4, H * 0.25, W / 2, H * 0.45, H * 0.85);
        gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,.7)");
        g.fillStyle = gr; g.fillRect(0, 0, W, H);

        g.textAlign = "center";
        g.textBaseline = "middle";

        // 題（右端・大きく）
        const title = (story.title || "無題").slice(0, 14);
        g.font = `64px ${FONT}`;
        g.fillStyle = "#f2f2f6";
        g.shadowColor = "rgba(160,190,255,.45)"; g.shadowBlur = 18;
        drawVertical(g, title, W - 120, 150, 64, 900, 20, 1);

        // 最初の一文（題の左。中くらい）
        g.shadowBlur = 10; g.shadowColor = "rgba(200,215,255,.35)";
        g.font = `44px ${FONT}`;
        g.fillStyle = "#d9dde8";
        drawVertical(g, hookSentence(story, o.timeWord), W - 250, 190, 44, 820, 26, 4);
        g.shadowBlur = 0;

        // 左上: ロゴ（文字は図形化済みなのでフォントの読み込みに左右されない）
        const logo = await loadImage("./assets/logo.svg");
        if (logo) {
            const lh = 340, lw = lh * 264 / 424;
            g.drawImage(logo, 70, 86, lw, lh);
        }

        // 下の帯: どこで生まれた話か・タグ・URL
        const place = [story.prefecture, story.placeName].filter(v => v && v !== "名前のない場所").join(" ");
        g.textAlign = "left";
        g.fillStyle = "#c8102e";
        g.beginPath(); g.arc(92, 1162, 11, 0, Math.PI * 2); g.fill();   // 赤いピンの印
        g.fillStyle = "#e3e6ee";
        g.font = `34px ${FONT}`;
        g.fillText(place ? `${place}のあたりで、` : "いまここで、", 120, 1162);
        g.fillText("この話が生まれた。", 120, 1212);
        g.fillStyle = "#8a93ad";
        g.font = `26px ${FONT}`;
        g.fillText(`#イマココ怪談　${SITE}`, 80, 1280);
        // 右下: サイトへ飛ぶQRコード（固定URLなので画像を同梱。明るい地に暗い点＝どのカメラでも読める）
        const qr = await loadImage("./assets/qr_site.png");
        if (qr) {
            const q = 170, qx = W - 80 - q, qy = 1124;
            g.drawImage(qr, qx, qy, q, q);
        }
        // 細い区切り線
        g.strokeStyle = "rgba(170,180,210,.25)"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(80, 1110); g.lineTo(W - 80, 1110); g.stroke();

        return await new Promise(res => c.toBlob(b => res(b), "image/jpeg", 0.88));
    }

    window.ImakokoShareCard = { make, hookSentence, W, H };
})();
