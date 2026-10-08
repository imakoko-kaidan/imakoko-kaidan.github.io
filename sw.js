/**
 * イマココ怪談 — Service Worker（2026-10）
 * 目的: 2回目以降を速く開く／電波の弱い場所でも、一度開いた画面と、作った話は読めるようにする。
 *
 * 方針
 *  - version.json : 常にネット（更新チェック用。キャッシュしない）
 *  - HTML         : ネット優先（3秒で諦めて保存版）→ 更新がすぐ反映され、圏外でも開ける
 *  - JS / CSS     : ?v=バージョン付きURLごとに保存（同じ版は保存版で即表示・新しい版は取りに行く）
 *  - 画像・音・JSON: 保存版優先（無ければ取りに行って保存）
 *  - 動画の「部分取得(Range)」と、外部サービス(Gemini・地図・天気など)には手を出さない
 * spots.json(約5MB)は初回に一度だけ取得して保存（先読みはしない＝最初の表示を重くしない）。
 * VERSION は tools/bump_version.py / build_release.py が version.json に合わせて書き換える。
 */
const VERSION = "0.154";
const CORE = "imakoko-core-" + VERSION;
const RUNTIME = "imakoko-rt-" + VERSION;

const PRECACHE = [
    "./", "./index.html", "./viewer.html", "./map.html",
    "./home.css", "./style.css", "./manifest.json",
    "./app-version.js", "./config.js", "./settings.js", "./prefs.js", "./db.js", "./home-fx.js",
    "./story_skeletons.js", "./sound_cues.js", "./generate.js", "./stories.js", "./audio.js",
    "./lamp.js", "./scare.js", "./candle.js", "./narrator.js", "./viewer.js", "./map.js",
    "./assets/home_bg.jpg", "./assets/read_bg.jpg", "./assets/icon-192.png", "./assets/apple-touch-icon.png",
    "./assets/scare/cat_sit.jpg", "./assets/scare/cat_lie.jpg", "./assets/scare/woman_front.jpg", "./assets/scare/woman_bowed.jpg",
    "./assets/sound/credits.json"
];

self.addEventListener("install", (e) => {
    e.waitUntil((async () => {
        const c = await caches.open(CORE);
        // 1つ失敗しても全体を止めない（個別に入れる）
        await Promise.all(PRECACHE.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => null)));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (e) => {
    e.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith("imakoko-") && k !== CORE && k !== RUNTIME).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }

async function fromCache(req, ignoreSearch) {
    return (await caches.match(req, { ignoreSearch: !!ignoreSearch })) || null;
}
// 応答はページに渡すと中身が読み終わってしまうので、渡す前に必ず複製してから保存する
function put(req, res) {
    if (!res || !res.ok || res.type === "opaque") return;
    const copy = res.clone();
    caches.open(RUNTIME).then(c => c.put(req, copy)).catch(() => { /* 容量不足など */ });
}

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // 外部サービスは素通し
    if (req.headers.has("range")) return;                      // 動画の部分取得はブラウザに任せる(iPhone対策)
    const path = url.pathname;
    if (/(_lab|debug|kaidan_stats)\.html$/.test(path) || path.includes("/dev/")) return;   // 開発用は触らない

    // 更新チェックは常にネット
    if (path.endsWith("/version.json")) return;

    // HTML: ネット優先 → 保存版
    if (req.mode === "navigate" || path.endsWith(".html") || path.endsWith("/")) {
        e.respondWith((async () => {
            try {
                const res = await Promise.race([fetch(req), timeout(3000)]);
                put(new Request(url.pathname), res);   // ?_v= などのクエリ違いを1つにまとめて保存
                return res;
            } catch (err) {
                return (await fromCache(new Request(url.pathname))) || (await fromCache(req, true))
                    || new Response("<p style='font-family:serif;color:#888;background:#000;padding:2em'>電波が届かないようです。電波のある場所で、もう一度開いてください。</p>",
                        { headers: { "Content-Type": "text/html; charset=utf-8" } });
            }
        })());
        return;
    }

    // JS / CSS: 同じ版(URL)は保存版、無ければネット → 圏外なら旧版でも出す
    if (/\.(js|css)$/.test(path)) {
        e.respondWith((async () => {
            const hit = await fromCache(req, false);
            if (hit) return hit;
            try { const res = await fetch(req); put(req, res); return res; }
            catch (err) { return (await fromCache(req, true)) || Response.error(); }
        })());
        return;
    }

    // 画像・音・動画(全体取得)・JSON: 保存版優先
    if (/\.(png|jpe?g|webp|svg|mp3|m4a|mp4|json|woff2?)$/.test(path)) {
        e.respondWith((async () => {
            const hit = await fromCache(req, true);
            if (hit) return hit;
            try { const res = await fetch(req); put(new Request(url.pathname), res); return res; }
            catch (err) { return Response.error(); }
        })());
    }
});
