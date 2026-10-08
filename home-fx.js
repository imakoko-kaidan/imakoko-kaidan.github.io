/**
 * イマココ怪談 - ホーム画面の環境演出
 * 思想: 派手な脅かしではなく「画面がうっすら汚染されている」静かな不穏さ。
 * 軽量(低頻度更新・低不透明度)で、操作UIの邪魔をしない。
 */
document.addEventListener("DOMContentLoaded", () => {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- 1. 薄い砂嵐ノイズ(常時・極薄) ----
    const canvas = document.getElementById("noise-canvas");
    if (canvas) {
        const ctx = canvas.getContext("2d");
        let w = 0, h = 0;
        const SCALE = 2; // 低解像度で生成して拡大(軽量化)
        function resize() {
            w = canvas.width = Math.ceil(window.innerWidth / SCALE);
            h = canvas.height = Math.ceil(window.innerHeight / SCALE);
        }
        resize();
        window.addEventListener("resize", resize);

        function drawNoise() {
            const img = ctx.createImageData(w, h);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
                const v = (Math.random() * 255) | 0;
                d[i] = d[i + 1] = d[i + 2] = v;
                d[i + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
        }
        if (reduce) {
            drawNoise(); // 動かさず一度だけ
        } else {
            setInterval(drawNoise, 90); // ~11fps。CSSのopacityで極薄に
        }
    }

    // ---- 2. 稀に、画面の端を何かがよぎる/沈む ----
    const flash = document.getElementById("dread-flash");
    if (flash && !reduce) {
        function scheduleDread() {
            const wait = 18000 + Math.random() * 32000; // 18〜50秒に一度
            setTimeout(() => {
                const fromLeft = Math.random() < 0.5;
                flash.style.background = fromLeft
                    ? "radial-gradient(ellipse 40% 80% at -10% 50%, rgba(20,0,0,0.55), transparent 60%)"
                    : "radial-gradient(ellipse 40% 80% at 110% 50%, rgba(20,0,0,0.55), transparent 60%)";
                flash.classList.add("show");
                setTimeout(() => flash.classList.remove("show"), 1100);
                scheduleDread();
            }, wait);
        }
        scheduleDread();
    }

    // ---- 3. タイトルに極稀なグリッチ(CSSの常時明滅に加えて) ----
    const title = document.querySelector(".home h1");
    if (title && !reduce) {
        function scheduleGlitch() {
            const wait = 8000 + Math.random() * 14000;
            setTimeout(() => {
                title.classList.add("glitch");
                setTimeout(() => title.classList.remove("glitch"), 320);
                scheduleGlitch();
            }, wait);
        }
        scheduleGlitch();
    }
});
