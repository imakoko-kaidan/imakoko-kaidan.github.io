/**
 * イマココ怪談 — アプリ自体を人に教えるシェアボタン（タイトル画面・2026-10）
 * スマホ: 端末のシェア画面（LINE・X・メッセージなど）を開く
 * PCなど未対応: X / LINE / リンクのコピー を選べる小さな窓を出す
 * 位置情報や作った話は一切含めない（アプリの紹介文とURLだけ）。
 */
(function () {
    "use strict";
    const SITE = "https://imakoko-kaidan.github.io/";
    const TITLE = "イマココ怪談";
    const TEXT = "いま、あなたがいる場所の怪談を、ひとつ。\nその土地の本当の記録から、いまここだけの怪談が生まれるアプリ。";
    const TAG = "#イマココ怪談";

    function closePanel() { const p = document.getElementById("app-share-panel"); if (p) p.remove(); }

    function showPanel(btn) {
        closePanel();
        const x = `https://x.com/intent/post?text=${encodeURIComponent(TEXT + "\n" + TAG)}&url=${encodeURIComponent(SITE)}`;
        const line = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(SITE)}`;
        const p = document.createElement("div");
        p.id = "app-share-panel";
        p.setAttribute("role", "dialog");
        p.setAttribute("aria-label", "このアプリを教える");
        p.innerHTML = `
            <a class="as-btn" href="${x}" target="_blank" rel="noopener">Xでポスト</a>
            <a class="as-btn" href="${line}" target="_blank" rel="noopener">LINEで送る</a>
            <button type="button" class="as-btn as-copy">リンクをコピー</button>
            <button type="button" class="as-close" aria-label="閉じる">閉じる</button>`;
        btn.insertAdjacentElement("afterend", p);
        p.querySelector(".as-close").onclick = closePanel;
        p.querySelector(".as-copy").onclick = async (e) => {
            const b = e.currentTarget;
            try { await navigator.clipboard.writeText(SITE); b.textContent = "コピーしました"; }
            catch (err) {
                const ta = document.createElement("textarea"); ta.value = SITE; document.body.appendChild(ta);
                ta.select(); try { document.execCommand("copy"); b.textContent = "コピーしました"; } catch (e2) { b.textContent = SITE; }
                ta.remove();
            }
        };
    }

    function init() {
        const btn = document.getElementById("app-share-btn");
        if (!btn) return;
        btn.addEventListener("click", async () => {
            if (navigator.share) {
                try { await navigator.share({ title: TITLE, text: TEXT + "\n" + TAG, url: SITE }); return; }
                catch (e) { if (e && e.name === "AbortError") return; /* それ以外は下の窓へ */ }
            }
            showPanel(btn);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
