/**
 * イマココ怪談 - 怪談地図
 * 聞いた怪談(ピン)を日本地図に表示。
 * 一覧タップ → 地図でそのピンを選択(中心移動+色変+吹き出し)。
 * 吹き出し/一覧内の「読み返す」 → ビューアへ。
 * タイル: 地理院タイル(淡色) — 出典明示のみで利用可
 */
document.addEventListener("DOMContentLoaded", async () => {
    const map = L.map("map", { zoomControl: true, attributionControl: true })
        .setView([36.5, 137.8], 5); // 日本全体

    L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
        maxZoom: 18,
        minZoom: 4
    }).addTo(map);

    // スポット網羅レイヤー(自前DB spots.json)。ピンの有無に関わらず使える
    setupCoverage(map);

    // 注意: Leafletはマーカーのルート要素をtransformで位置決めする。
    // 拡大/アニメーションは必ず内側の .pin-glyph に当てること(ルートに当てると位置がズレる)。
    const makeIcon = (active) => L.divIcon({
        className: "pin-marker" + (active ? " pin-active" : ""),
        html: '<span class="pin-glyph">📍</span>',
        iconSize: [24, 24],
        iconAnchor: [12, 22],
        popupAnchor: [0, -20]
    });

    // 古いピンのメタ補完(空のareaを町名で補う。一度だけ・非破壊)。失敗してもアプリは止めない。
    try {
        const n = await ImakokoDB.backfillPinMeta("area_from_place_1");
        if (n) console.info(`メタ補完: ${n}話のエリアを補いました`);
    } catch (e) { /* noop */ }

    let pins = [];
    try {
        pins = await ImakokoDB.getAllPins();
    } catch (e) {
        console.error(e);
    }

    const itemsEl = document.getElementById("pin-items");
    const emptyEl = document.getElementById("empty-pins");
    document.getElementById("pin-total").textContent = pins.length ? `── ${pins.length}話` : "";

    if (!pins.length) {
        emptyEl.classList.remove("hidden");
        wireBackup();
        await showPersistState();
        return;
    }

    // マーカーとリスト項目を相互参照できるよう保持
    const markers = {};       // id -> L.marker
    const listItems = {};     // id -> DOM要素
    let selectedId = null;
    const bounds = [];

    pins.forEach(pin => {
        if (typeof pin.lat !== "number" || typeof pin.lon !== "number") return;
        bounds.push([pin.lat, pin.lon]);
        const marker = L.marker([pin.lat, pin.lon], { icon: makeIcon(false) }).addTo(map);
        marker.bindPopup(popupHtml(pin), { autoPan: false }); // 位置はselectPin側で調整
        marker.on("click", () => selectPin(pin.id, { fromMap: true }));
        markers[pin.id] = marker;
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });

    // 一覧（2026-10: 都道府県で絞り込み・並び替え）
    const prefSel = document.getElementById("pin-pref");
    const sortSel = document.getElementById("pin-sort");
    const SORT_KEY = "imakoko_pin_sort", PREF_KEY = "imakoko_pin_pref";
    const P = window.ImakokoPrefs;
    const stars = (r) => r >= 1 ? "★".repeat(r) + "☆".repeat(5 - r) : "未評価";

    function buildPrefOptions() {
        const counts = {};
        pins.forEach(p => { const k = p.prefecture || "（不明）"; counts[k] = (counts[k] || 0) + 1; });
        const names = Object.keys(counts).sort((a, b) => (P ? P.order(a) - P.order(b) : a.localeCompare(b)));
        const cur = prefSel.value || localStorage.getItem(PREF_KEY) || "";
        prefSel.innerHTML = `<option value="">すべての都道府県（${pins.length}話）</option>` +
            names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}（${counts[n]}話）</option>`).join("");
        prefSel.value = names.includes(cur) ? cur : "";
    }

    function renderList() {
        const pref = prefSel.value, sort = sortSel.value;
        localStorage.setItem(SORT_KEY, sort); localStorage.setItem(PREF_KEY, pref);
        const t = (p) => String(p.createdAt || "");
        let list = pins.filter(p => !pref || (p.prefecture || "（不明）") === pref);
        list.sort((a, b) => {
            if (sort === "scary") return (b.rating || 0) - (a.rating || 0) || t(b).localeCompare(t(a));
            if (sort === "pref") return (P ? P.order(a.prefecture) - P.order(b.prefecture) : 0) || t(b).localeCompare(t(a));
            if (sort === "old") return t(a).localeCompare(t(b));
            return t(b).localeCompare(t(a));
        });
        itemsEl.innerHTML = "";
        Object.keys(listItems).forEach(k => delete listItems[k]);
        let lastPref = null;
        list.forEach(pin => {
            if (sort === "pref" && !pref && (pin.prefecture || "（不明）") !== lastPref) {
                lastPref = pin.prefecture || "（不明）";
                const h = document.createElement("p");
                h.className = "pi-group";
                h.textContent = lastPref;
                itemsEl.appendChild(h);
            }
            const item = document.createElement("button");
            item.className = "pin-item" + (pin.id === selectedId ? " selected" : "");
            item.type = "button";
            item.innerHTML =
                `<p class="pi-title">📍 ${escapeHtml(pin.title || "無題")} <span class="pi-stars">${stars(pin.rating || 0)}</span></p>` +
                `<p class="pi-meta">${escapeHtml(pin.prefecture ? pin.prefecture + " " : "")}${escapeHtml(pin.placeName || "")} / ${formatDate(pin.createdAt)} ` +
                `<span class="pi-tags">${(pin.tags || []).map(t => "#" + escapeHtml(t)).join(" ")}</span></p>`;
            item.addEventListener("click", () => selectPin(pin.id, { scrollIntoView: false }));
            itemsEl.appendChild(item);
            listItems[pin.id] = item;
        });
        // 地図のピンも、選んだ都道府県だけにする
        pins.forEach(p => {
            const m = markers[p.id]; if (!m) return;
            const show = !pref || (p.prefecture || "（不明）") === pref;
            if (show && !map.hasLayer(m)) m.addTo(map);
            if (!show && map.hasLayer(m)) map.removeLayer(m);
        });
    }

    sortSel.value = localStorage.getItem(SORT_KEY) || "new";
    buildPrefOptions();
    document.getElementById("pin-controls").hidden = false;
    prefSel.addEventListener("change", renderList);
    sortSel.addEventListener("change", renderList);
    renderList();

    // 都道府県が未記録の古い話を、座標から補う（地理院・1件ずつ・一度だけ保存）
    (async () => {
        if (!P) return;
        let changed = 0;
        for (const pin of pins) {
            if (pin.prefecture || typeof pin.lat !== "number") continue;
            const pref = await P.lookup(pin.lat, pin.lon);
            if (!pref) continue;
            pin.prefecture = pref;
            try { await ImakokoDB.savePin(pin); } catch (e) { /* noop */ }
            changed++;
        }
        if (changed) { buildPrefOptions(); renderList(); }
    })();

    /** ピンを選択状態にする: 地図中心移動・色変え・吹き出し・一覧ハイライト */
    function selectPin(id, opts = {}) {
        const pin = pins.find(p => p.id === id);
        if (!pin) return;

        // 直前の選択を解除
        if (selectedId && markers[selectedId]) markers[selectedId].setIcon(makeIcon(false));
        if (selectedId && listItems[selectedId]) listItems[selectedId].classList.remove("selected");

        selectedId = id;
        if (markers[id]) {
            markers[id].setIcon(makeIcon(true));
            // ピンを画面中央より下に置き、上に吹き出しのスペースを確保する。
            // 中心をピンより上(北)へずらす = 中心ピクセルをピンより上に取る。
            const z = Math.max(map.getZoom(), 14);
            const pt = map.project([pin.lat, pin.lon], z);
            const offsetY = map.getSize().y * 0.30; // 画面高の30%ぶん下げる
            const center = map.unproject(pt.subtract([0, offsetY]), z);
            map.flyTo(center, z, { duration: 0.6 });
            markers[id].openPopup(); // 吹き出しはマーカーに追従して一緒に動く
        }
        if (listItems[id]) {
            listItems[id].classList.add("selected");
            if (opts.fromMap) listItems[id].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }

    function popupHtml(pin) {
        return `<p class="popup-title">${escapeHtml(pin.title || "無題")}</p>` +
            `<p class="popup-meta">${escapeHtml(pin.placeName || "")} / ${formatDate(pin.createdAt)}</p>` +
            `<a class="popup-read" href="./viewer.html?pin=${encodeURIComponent(pin.id)}">読み返す</a>`;
    }

    wireBackup();
    await showPersistState();

    // ---- バックアップ ----
    function wireBackup() {
        document.getElementById("export-btn").addEventListener("click", async () => {
            const n = await ImakokoDB.exportAll();
            if (!n) alert("まだ記録がありません。");
        });
        // すべて削除: 必ず先にバックアップを書き出し → 確認 → 全消去 → 再読込
        const clearBtn = document.getElementById("clear-btn");
        if (clearBtn) {
            clearBtn.addEventListener("click", async () => {
                const n = await ImakokoDB.exportAll();   // 先にバックアップ(JSONダウンロード)
                if (!n) { alert("まだ記録がありません。"); return; }
                const ok = confirm(
                    `バックアップ(${n}話)を書き出しました。\n\n` +
                    `このあと、保存済みの怪談 ${n}話を「すべて削除」します。\n` +
                    `この操作は元に戻せません。よろしいですか？`
                );
                if (!ok) return;
                try {
                    await ImakokoDB.clearAll();
                    alert(`${n}話を削除しました。`);
                    location.reload();
                } catch (e) {
                    alert("削除に失敗しました: " + (e && e.message || e));
                }
            });
        }

        const fileInput = document.getElementById("import-file");
        document.getElementById("import-btn").addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
            if (!fileInput.files.length) return;
            try {
                const n = await ImakokoDB.importFile(fileInput.files[0]);
                alert(`${n}話の記録を取り込みました。`);
                location.reload();
            } catch (e) {
                alert("読み込みに失敗しました: " + e.message);
            }
        });
    }

    async function showPersistState() {
        try {
            if (navigator.storage && navigator.storage.persisted) {
                const persisted = await navigator.storage.persisted();
                document.getElementById("persist-note").textContent = persisted
                    ? "この端末の記録は保護されています。念のため、たまに書き出しを。"
                    : "ブラウザのデータ消去で記録が消えることがあります。「書き出す」で控えを残してください。";
            }
        } catch (e) { /* noop */ }
    }

    /**
     * スポット網羅レイヤー: 自前DB(spots.json)の錨の位置・カバー半径・対象エリア枠を表示。
     * 「エリアをチェックしながら」濃く埋めるための可視化。トグルで表示/非表示。
     * file:// では spots.json を読めないためトグルを無効化する(他機能と同様にスキップ)。
     */
    function setupCoverage(map) {
        const KATA_COLOR = {
            "災害碑型": "#4aa3ff", "記録型": "#b06cff", "伝承型": "#46c98b",
            "都市伝説型": "#ff7a59", "パワースポット": "#ffd24a"
        };
        // 対象エリア枠(regions.json と一致させた矩形。bbox=[minLat,minLng,maxLat,maxLng])
        const REGIONS = {
            "関東": [34.90, 138.90, 37.20, 140.90],
            "東京23区": [35.50, 139.56, 35.82, 139.92]
        };
        const spotLayer = L.layerGroup();
        const regionLayer = L.layerGroup();
        let loaded = false, count = 0;

        async function loadSpots() {
            if (loaded) return true;
            try {
                const res = await fetch("./spots.json", { cache: "no-cache" });
                if (!res.ok) throw new Error("HTTP " + res.status);
                const data = await res.json();
                const list = Array.isArray(data) ? data : (data.spots || []);
                list.forEach(s => {
                    if (typeof s.lat !== "number" || typeof s.lng !== "number") return;
                    const color = KATA_COLOR[s.kata] || "#9aa0b5";
                    L.circle([s.lat, s.lng], {
                        radius: s.radius_m || 600, color, weight: 1,
                        opacity: 0.5, fillColor: color, fillOpacity: 0.08
                    }).addTo(spotLayer);
                    L.circleMarker([s.lat, s.lng], {
                        radius: 4, color, weight: 1, fillColor: color, fillOpacity: 0.9
                    }).bindTooltip(
                        `${escapeHtml(s.name || "スポット")}<br>${escapeHtml(s.kata || "")}` +
                        `${s.area_label ? " / " + escapeHtml(s.area_label) : ""}`,
                        { direction: "top" }
                    ).addTo(spotLayer);
                    count++;
                });
                loaded = true;
                return true;
            } catch (e) {
                console.warn("spots.json 読込不可(file://等では正常)", e);
                return false;
            }
        }

        function drawRegions() {
            Object.entries(REGIONS).forEach(([name, b]) => {
                L.rectangle([[b[0], b[1]], [b[2], b[3]]], {
                    color: "#ff5a7a", weight: 1.2, dashArray: "5,5",
                    fill: false, opacity: 0.8
                }).bindTooltip(name, { permanent: false, sticky: true }).addTo(regionLayer);
            });
        }

        const ctrl = L.control({ position: "topright" });
        ctrl.onAdd = () => {
            const div = L.DomUtil.create("div", "coverage-ctrl");
            div.style.cssText =
                "background:rgba(18,18,24,.86);color:#e8e8ef;padding:8px 10px;border-radius:8px;" +
                "font:12px/1.5 sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.4);user-select:none;";
            div.innerHTML =
                '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;">' +
                '<input type="checkbox" id="cov-spots"> スポット網羅<span id="cov-count" style="opacity:.7"></span></label>' +
                '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;margin-top:4px;">' +
                '<input type="checkbox" id="cov-region"> 対象エリア枠</label>';
            L.DomEvent.disableClickPropagation(div);
            return div;
        };
        ctrl.addTo(map);

        // コントロールはonAdd後にDOM存在。次フレームで配線
        setTimeout(() => {
            const spotsCb = document.getElementById("cov-spots");
            const regionCb = document.getElementById("cov-region");
            const countEl = document.getElementById("cov-count");
            if (spotsCb) spotsCb.addEventListener("change", async () => {
                if (spotsCb.checked) {
                    const ok = await loadSpots();
                    if (!ok) {
                        spotsCb.checked = false;
                        countEl.textContent = " (読込不可)";
                        return;
                    }
                    spotLayer.addTo(map);
                    countEl.textContent = count ? ` ${count}件` : " 0件";
                } else {
                    map.removeLayer(spotLayer);
                }
            });
            if (regionCb) regionCb.addEventListener("change", () => {
                if (regionCb.checked) { if (!regionLayer.getLayers().length) drawRegions(); regionLayer.addTo(map); }
                else map.removeLayer(regionLayer);
            });
        }, 0);
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function formatDate(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
    }
});
