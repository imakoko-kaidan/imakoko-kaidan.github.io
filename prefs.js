/**
 * イマココ怪談 — 都道府県（2026-10）
 * 国土地理院の逆ジオコーダが返す市区町村コード(muniCd)の先頭2桁 = 都道府県コード(JIS X 0401)。
 */
(function (root) {
    "use strict";
    const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
        "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
        "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
        "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
        "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];
    /** "13118" → "東京都" */
    function fromMuniCd(cd) {
        const n = parseInt(String(cd || "").slice(0, 2), 10);
        return n >= 1 && n <= 47 ? PREFS[n - 1] : "";
    }
    /** 住所文字列（Nominatimの display_name 等）から都道府県名を拾う */
    function fromText(text) {
        const t = String(text || "");
        return PREFS.find(p => t.includes(p)) || "";
    }
    /** 北から南の順番（並び替え用） */
    function order(name) { const i = PREFS.indexOf(name); return i < 0 ? 99 : i; }
    /** 座標から都道府県を調べる（地理院・無料）。失敗時は "" */
    async function lookup(lat, lon) {
        try {
            const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
            const j = await r.json();
            return fromMuniCd(j && j.results && j.results.muniCd);
        } catch (e) { return ""; }
    }
    root.ImakokoPrefs = { PREFS, fromMuniCd, fromText, order, lookup };
})(typeof window !== "undefined" ? window : globalThis);
