/**
 * イマココ怪談 - 起動時の更新チェック
 * スマホのホーム画面ショートカット等で古いキャッシュが残る問題への対策。
 *
 * 仕組み: ページを開くたびに version.json を no-store(キャッシュ無視)で取得し、
 * 前回見たバージョンと違えば、キャッシュ(Service Worker/Cache API)を消して
 * キャッシュバスター付きで再読み込みする。
 *
 * ※ file:// では fetch が失敗するため何もしない(localhost/本番でのみ機能)。
 * ※ 反映を確実にするため、サーバ側で version.json と HTML を no-cache 配信するのが理想。
 */
(function () {
    var KEY = "imakoko_app_version";
    var RELOADED_FLAG = "imakoko_reloaded_once";

    // バージョンを画面に表示する([data-app-version]を持つ要素に "v1.001" のように入れる)。
    // fetch解決時とDOMContentLoadedの両方で適用(読み込み順に依存しないように)。
    var shownVersion = null;
    function applyVersion(v) {
        shownVersion = v;
        var els = document.querySelectorAll("[data-app-version]");
        for (var i = 0; i < els.length; i++) els[i].textContent = "v" + v;
    }
    document.addEventListener("DOMContentLoaded", function () {
        if (shownVersion) applyVersion(shownVersion);
    });

    // 2026-10: オフライン・高速化のための Service Worker（https か localhost のときだけ）
    try {
        var okOrigin = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
        if ("serviceWorker" in navigator && okOrigin && !/_lab\.html$|debug\.html$|kaidan_stats\.html$/.test(location.pathname)) {
            window.addEventListener("load", function () {
                navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(function () { /* 無くても動く */ });
            });
        }
    } catch (e) { /* noop */ }

    fetch("./version.json?ts=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
            var server = data && data.version;
            if (!server) return;
            applyVersion(server);   // 表示を更新
            var local = localStorage.getItem(KEY);

            if (local && local !== server) {
                // 無限リロード防止: 1回だけ実行
                if (sessionStorage.getItem(RELOADED_FLAG)) {
                    localStorage.setItem(KEY, server);
                    return;
                }
                sessionStorage.setItem(RELOADED_FLAG, "1");
                localStorage.setItem(KEY, server);

                var done = function () {
                    var u = new URL(location.href);
                    u.searchParams.set("_v", server); // キャッシュバスター
                    location.replace(u.toString());
                };
                if (window.caches && caches.keys) {
                    caches.keys()
                        .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
                        .then(done, done);
                } else {
                    done();
                }
            } else {
                localStorage.setItem(KEY, server);
                sessionStorage.removeItem(RELOADED_FLAG);
            }
        })
        .catch(function () { /* file://やオフラインでは黙ってスキップ */ });
})();
