/**
 * イマココ怪談 - 生成パイプライン(ブラウザ完結MVP)
 * 位置情報 → 錨収集(逆ジオ/Wikipedia/災害伝承碑) → Gemini生成 → IndexedDB保存 → ビューアへ
 *
 * 注意: MVPはAPIキーをブラウザ保存して直接呼ぶ(検証用)。公開時はserverlessプロキシ化。
 */

// ---------- 診断ログ(画面のログパネル+console に出力) ----------
const Logger = (() => {
    const lines = [];
    let el = null;
    function ts() {
        const d = new Date();
        return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
    }
    function log(level, msg, data) {
        let line = `[${ts()}] [${level}] ${msg}`;
        if (data !== undefined) {
            try {
                line += " | " + (typeof data === "string" ? data : JSON.stringify(data));
            } catch (e) { line += " | " + String(data); }
        }
        lines.push(line);
        (level === "ERROR" ? console.error : console.log)(line);
        if (!el) el = document.getElementById("log-output");
        if (el) {
            el.textContent = lines.join("\n");
            el.scrollTop = el.scrollHeight;
        }
    }
    return {
        info: (m, d) => log("INFO", m, d),
        warn: (m, d) => log("WARN", m, d),
        error: (m, d) => log("ERROR", m, d),
        text: () => lines.join("\n"),
        clear: () => { lines.length = 0; if (el) el.textContent = ""; }
    };
})();

// ---------- Gemini クライアント(リトライ+フォールバック) ----------
// モデル一覧は公式ドキュメント(Release notes / Pricing)で2026-10-07時点を確認:
//   gemini-3.8-flash    … 最新・最も賢いFlash(2026-09 GA)。本命
//   gemini-3.6-flash    … 1世代前のFlash(2026-07 GA)。同価格のフォールバック
//   gemini-flash-latest … 最新Flashへのエイリアス(将来の自動追従。最終保険)
// ※ 2.5系は2026-09-18から「過去に使ったユーザーのみ」に制限 → 新規ユーザーのキーでは使えないため除外
// ※ モデルは更新が速い。BUGLOG #9/#17 のとおり半年ごとに公式ドキュメントで要再確認
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-flash-latest"];

// 実費の目安表示用(USD / 100万トークン。公式Pricing 2026-10-07時点。3.6/3.8は2026年末までの導入価格)
const GEMINI_PRICES = {
    "gemini-3.8-flash":       { in: 0.75, out: 3.75 },
    "gemini-3.6-flash":       { in: 0.75, out: 3.75 },
    "gemini-3.5-flash-lite":  { in: 0.30, out: 2.50 },
    "gemini-3.1-pro-preview": { in: 2.00, out: 12.00 }
};
const YEN_PER_USD = 150;

async function callGemini(apiKey, prompt, preferredModel) {
    // 選択モデルを先頭に、残りを重複排除でフォールボールとして続ける
    const models = preferredModel
        ? [preferredModel, ...GEMINI_MODELS.filter(m => m !== preferredModel)]
        : GEMINI_MODELS;
    let lastErr = null;
    for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                Logger.info(`Gemini呼び出し: ${model} (試行${attempt + 1})`);
                const t0 = performance.now();
                const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });
                if (!res.ok) {
                    const body = await res.text();
                    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
                    err.status = res.status;
                    throw err;
                }
                const data = await res.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
                Logger.info(`Gemini応答: ${model}, ${Math.round(performance.now() - t0)}ms, ${text.length}文字`);
                // 実際のトークン数と実費の目安(思考トークンも出力側として課金される)
                const u = data.usageMetadata || {};
                const outTok = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
                const price = GEMINI_PRICES[model];
                const yen = price
                    ? (((u.promptTokenCount || 0) * price.in + outTok * price.out) / 1e6 * YEN_PER_USD).toFixed(2) + "円"
                    : "(単価未登録)";
                Logger.info("使用量", { in: u.promptTokenCount, out: u.candidatesTokenCount, thinking: u.thoughtsTokenCount, 目安: yen });
                if (text.trim()) return text;
                throw new Error("空の応答");
            } catch (e) {
                lastErr = e;
                Logger.warn(`Gemini失敗: ${model}`, { status: e.status, message: String(e.message).slice(0, 200) });
                if (e.status === 404) break; // モデルが無い → 次のモデルへ
                if (e.status === 400 || e.status === 403) {
                    // キーそのものが不正なら、どのモデルでも無理 → 即時中断
                    if (/API_KEY_INVALID|API key not valid|API key expired/i.test(e.message)) {
                        throw new Error("APIキーが無効です。設定欄のキーを確認してください。");
                    }
                    // それ以外(そのキーでは使えないモデル等)は次のモデルへ
                    break;
                }
                await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            }
        }
    }
    throw new Error("全モデルで生成に失敗: " + (lastErr ? lastErr.message : "不明なエラー"));
}

// ---------- 錨収集(すべて失敗しても②フォールバックで生成は成立する) ----------

async function fetchJson(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** 逆ジオコーディング: 町名・住所(GSI + Nominatim 併用) */
async function reverseGeocode(lat, lon) {
    const result = { town: null, address: null, placeType: null, prefecture: "" };
    try {
        const gsi = await fetchJson(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
        result.town = gsi.results?.lv01Nm || null;
        if (typeof ImakokoPrefs !== "undefined") result.prefecture = ImakokoPrefs.fromMuniCd(gsi.results?.muniCd);
        Logger.info("逆ジオ(GSI)", { town: result.town });
    } catch (e) {
        Logger.warn("逆ジオ(GSI)失敗(非公式APIのため許容)", String(e.message || e.name));
    }
    try {
        const nomi = await fetchJson(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&accept-language=ja&zoom=16`);
        result.address = nomi.display_name || null;
        if (!result.prefecture && typeof ImakokoPrefs !== "undefined") result.prefecture = ImakokoPrefs.fromText(result.address);
        result.placeType = nomi.category && nomi.type ? `${nomi.category}/${nomi.type}` : null;
        if (!result.town) {
            const a = nomi.address || {};
            result.town = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.town || a.village || null;
        }
        Logger.info("逆ジオ(Nominatim)", { address: result.address, type: result.placeType });
    } catch (e) {
        Logger.warn("逆ジオ(Nominatim)失敗", String(e.message || e.name));
    }
    return result;
}

/** Wikipedia: 周辺記事の冒頭を取得(近い順。CC BY-SA、出典リンクをcreditsに残す) */
async function fetchWikipediaAnchors(lat, lon) {
    const anchors = [];
    try {
        // 広め(3km)に取得し、現在地からの距離(dist)で近い順に採用する。
        // geosearchは各ヒットにgscoordからの距離(m)= dist を返す。
        const geo = await fetchJson(
            `https://ja.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}%7C${lon}&gsradius=3000&gslimit=12&format=json&origin=*`);
        const hits = (geo.query?.geosearch || []).slice().sort((a, b) => (a.dist || 0) - (b.dist || 0));
        Logger.info(`Wikipedia geosearch: ${hits.length}件(近い順)`,
            hits.slice(0, 5).map(h => `${h.title}(${Math.round(h.dist)}m)`).join(" / "));
        if (!hits.length) return anchors;

        const top = hits.slice(0, 4);
        const distByTitle = {};
        top.forEach(h => { distByTitle[h.title] = Math.round(h.dist || 0); });

        const ext = await fetchJson(
            `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(top.map(h => h.title).join("|"))}`);
        const pages = ext.query?.pages || {};
        Object.values(pages).forEach(p => {
            if (p.extract && p.extract.length > 40) {
                anchors.push({
                    kind: "wikipedia",
                    title: p.title,
                    distM: distByTitle[p.title] ?? null,
                    text: p.extract.slice(0, 600),
                    source: `Wikipedia: ${p.title}`,
                    url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(" ", "_"))}`
                });
            }
        });
        // 近い順を保つ
        anchors.sort((a, b) => (a.distM ?? 9e9) - (b.distM ?? 9e9));
    } catch (e) {
        Logger.warn("Wikipedia取得失敗", String(e.message || e.name));
    }
    return anchors;
}

/**
 * 【DISABLED / BUGLOG #11】国土地理院・自然災害伝承碑: 近傍の碑を探す(GeoJSONタイル)。
 * z12 が全座標で404＝取得不能のため本流から切り離し済み(上の Promise.all 参照、lore=[])。
 * 正しい配信ズーム/形式を実データで確定したら、ここを直して再投入する。それまで呼び出さない。
 */
async function fetchDisasterLore(lat, lon) {
    const anchors = [];
    try {
        const z = 12;
        const latR = lat * Math.PI / 180;
        const n = Math.pow(2, z);
        const x = Math.floor((lon + 180) / 360 * n);
        const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
        const gj = await fetchJson(`https://cyberjapandata.gsi.go.jp/xyz/disaster_lore_all/${z}/${x}/${y}.geojson`);
        const feats = (gj.features || [])
            .map(f => {
                const [flon, flat] = f.geometry.coordinates;
                return { f, d: haversine(lat, lon, flat, flon) };
            })
            .filter(o => o.d < 4000)
            .sort((a, b) => a.d - b.d)
            .slice(0, 2);
        Logger.info(`災害伝承碑: タイル内${(gj.features || []).length}基, 4km圏内${feats.length}基`);
        feats.forEach(({ f, d }) => {
            const p = f.properties || {};
            anchors.push({
                kind: "disaster_lore",
                title: p["碑名"] || "自然災害伝承碑",
                distM: Math.round(d),
                text: `自然災害伝承碑「${p["碑名"] || "(名称不明)"}」。災害種別: ${p["災害種別"] || "不明"}。伝承内容: ${(p["伝承内容"] || "").slice(0, 300)}`,
                source: "国土地理院 自然災害伝承碑",
                url: "https://www.gsi.go.jp/bousaichiri/denshouhi.html"
            });
        });
    } catch (e) {
        Logger.warn("災害伝承碑の取得失敗(碑が無い地域は404で正常)", String(e.message || e.name));
    }
    return anchors;
}

/**
 * 自前スポットDB(パワースポット/心霊スポット): 近傍・採用可のみを錨にする。
 * app/spots.json (spot_db/spots.csv から変換) を読み、enabled かつ半径内のものを返す。
 * スキーマ§3の採用ゲート(historicized等)は変換時に適用済みだが、ここでも enabled を二重確認する。
 * ※ file:// では fetch できず例外になるが、他ソースと同様 try/catch でスキップされ生成は成立する。
 */
async function fetchLocalSpotAnchors(lat, lon) {
    const anchors = [];
    try {
        const data = await fetchJson("./spots.json", 5000);
        const list = Array.isArray(data) ? data : (data.spots || []);
        const hits = list
            .filter(s => s && s.enabled !== false && typeof s.lat === "number" && typeof s.lng === "number")
            .map(s => ({ s, d: haversine(lat, lon, s.lat, s.lng) }))
            .filter(o => o.d <= (o.s.radius_m || 800))
            .sort((a, b) => kataRank(a.s.kata) - kataRank(b.s.kata) || a.d - b.d)
            .slice(0, 3);
        Logger.info(`自前スポットDB: 候補${list.length}件, 採用${hits.length}件`,
            hits.map(o => `${o.s.name}(${Math.round(o.d)}m/${o.s.kata})`).join(" / ") || "(圏内なし)");
        hits.forEach(({ s, d }) => {
            anchors.push({
                kind: "local_spot",
                title: s.name || "土地の言い伝え",
                distM: Math.round(d),
                areaLabel: s.area_label || null,   // 建物単位を避けたエリア表記。語りはこの解像度で
                hint: s.narrative_hint || null,
                kata: s.kata || null,
                priority: kataRank(s.kata),
                text: s.anchor || "",              // 入力時点でぼかし済みの錨(§4)
                source: s.attribution || s.source || "土地の伝承(自前調査)",
                url: (s.source && /^https?:/.test(s.source)) ? s.source : null
            });
        });
    } catch (e) {
        Logger.warn("自前スポットDB取得失敗(file://や未配置では正常にスキップ)", String(e.message || e.name));
    }
    return anchors;
}

/** 怪談ソースの優先順位(思想⑥/スキーマ§5): その場所固有の事実 > 都市伝説ロア。小さいほど優先 */
function kataRank(kata) {
    return { "災害碑型": 0, "記録型": 0, "伝承型": 0, "パワースポット": 0, "都市伝説型": 1 }[kata] ?? 1;
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 位置情報(高精度→低精度の二段構え) ----------

function geoErrorMessage(e) {
    if (!e || typeof e.code !== "number") return null;
    return {
        1: "位置情報が許可されませんでした。ブラウザのサイト設定で位置情報を「許可」にしてください。",
        2: "位置を特定できませんでした。電波状況やOSの位置情報サービスを確認してください。",
        3: "位置情報の取得がタイムアウトしました。屋内や電波の弱い場所では時間がかかります。もう一度お試しください。"
    }[e.code] || null;
}

async function getPosition() {
    // 手動座標が指定されていれば最優先(デスクトップ検証・測位不可環境のフォールバック)
    const manual = getManualCoords();
    if (manual) {
        Logger.info("手動座標を使用", manual);
        return { coords: { latitude: manual.lat, longitude: manual.lon, accuracy: 0 } };
    }

    if (!navigator.geolocation) throw new Error("このブラウザは位置情報に対応していません。");
    if (!window.isSecureContext) {
        Logger.warn("非セキュアコンテキストです。位置情報はhttpsまたはlocalhostでのみ動作します", location.origin);
    }
    const tryGet = (opts) => new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, opts));
    try {
        Logger.info("測位開始(高精度・最大10秒)");
        return await tryGet({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } catch (e1) {
        Logger.warn("高精度測位に失敗 → 低精度で再試行(最大20秒)", { code: e1.code, message: e1.message });
        if (e1.code === 1) throw e1; // 許可拒否は再試行しても無駄
        return await tryGet({ enableHighAccuracy: false, timeout: 20000, maximumAge: 600000 });
    }
}

/** 設定欄の手動座標(「緯度,経度」)を読む。空なら null */
function getManualCoords() {
    const raw = (document.getElementById("manual-coords")?.value || "").trim();
    if (!raw) return null;
    const m = raw.match(/(-?\d+\.?\d*)\s*[,、\s]\s*(-?\d+\.?\d*)/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
}

// ---------- プロンプト構築 ----------

/** 時刻を「時間帯」の言葉に変換(分刻みの時刻は嘘くささを生むので使わない。viewer側と同じ区分) */
function timeBand(h) {
    if (h >= 5 && h < 8) return "朝";
    if (h >= 8 && h < 11) return "昼前";
    if (h >= 11 && h < 14) return "昼下がり";
    if (h >= 14 && h < 17) return "午後";
    if (h >= 17 && h < 19) return "夕暮れどき";
    if (h >= 19 && h < 23) return "宵";
    if (h >= 23 || h < 3) return "真夜中";
    return "丑三つ時";
}

function distanceLabel(m) {
    if (m == null) return "この一帯";
    if (m < 100) return "ごく近い(歩いてすぐの土地)";
    if (m < 500) return "近い(徒歩数分の土地)";
    if (m < 1500) return "この町内";
    return "この一帯(やや離れている)";
}

/** 多様性インジェクター: 毎回ランダムに「語りの設定」を振り、マンネリを機械的に防ぐ。
 *  鉄則1の型(体験談/言い伝え)の範囲内で、語り手・怪異の入口・結末・文体・禁じ手を変える。 */
/**
 * 星評価から骨格ごとの重みを作る(2026-10)。
 *   評価なし=1.0（新しい骨格も試す）/ 平均★1=0.35 … ★3=1.0 … ★5=2.2。
 *   評価が1件だけのときは影響を半分に（たまたまの1回で決めつけない）。
 *   pins: この端末の記録（ImakokoDB.getAllPins()）。生GPSは使わない。
 */
function skeletonWeights(pins) {
    const agg = {};
    (pins || []).forEach(p => {
        if (!p || !p.skeleton || !(p.rating >= 1)) return;
        const a = agg[p.skeleton] || (agg[p.skeleton] = { sum: 0, n: 0 });
        a.sum += p.rating; a.n++;
    });
    const w = {};
    for (const [k, a] of Object.entries(agg)) {
        const avg = a.sum / a.n;
        const full = avg >= 3 ? 1 + (avg - 3) * 0.6 : 1 - (3 - avg) * 0.325;   // ★1→0.35, ★3→1, ★5→2.2
        const conf = Math.min(1, a.n / 2);                                       // 1件=半分、2件以上=全部
        w[k] = 1 + (full - 1) * conf;
    }
    return w;
}

function pickVariety(weights) {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    const pickWeighted = (a) => {
        if (!weights) return pick(a);
        const ws = a.map(x => (weights[x] != null ? weights[x] : 1));
        let r = Math.random() * ws.reduce((s, v) => s + v, 0);
        for (let i = 0; i < a.length; i++) { if ((r -= ws[i]) < 0) return a[i]; }
        return a[a.length - 1];
    };
    // 話の骨格(プロット構造)ライブラリ。約100種から毎回1つ。ブラウザはグローバル、Nodeはrequire。
    let skeletons = (typeof STORY_SKELETONS !== "undefined") ? STORY_SKELETONS : null;
    if (!skeletons && typeof require !== "undefined") {
        try { skeletons = require("./story_skeletons.js"); } catch (e) { skeletons = null; }
    }
    const structure = (skeletons && skeletons.length)
        ? pickWeighted(skeletons)
        : "接近・追尾｜何かが少しずつ近づく";
    const teller = pick([
        "勤め先の後輩", "古い友人", "年上の知人", "祖父母から聞いた", "土地の古老が語った",
        "元この町の住人", "取材で会った人", "一度だけ自分が体験した", "親戚が昔ここに住んでいた"
    ]);
    // 怪異の「入口」=最初の違和感。音系に偏らないよう視覚・触覚・空間・時間系を厚めに。
    const entry = pick([
        "背後の視線・見られている感じ", "におい(土・水・線香・潮・雨)", "濡れ・急な冷たさ・温度の急変",
        "数の狂い(ひとつ多い/ひとり多い)", "影の過不足・濃さの違い", "ものの位置がいつの間にか変わる",
        "見慣れた場所がどこか作り変わっている", "時間の感覚がずれる(進まない/飛ぶ)",
        "人や物の姿がほんの少しだけ間違っている", "あるはずのものが無い・いるはずの人がいない",
        "手触り・質感の異常(濡れ/ぬくもり/べたつき)", "写真や窓ガラスに映る像のズレ",
        "足音・歩数のわずかなズレ", "名を呼ばれる声"
    ]);
    const ending = pick([
        "読者の『今いる場所・今の時間帯』へ矛先を向けて断ち切る",
        "怪異が語り手から読者の側へ移ったと、そっと示唆して終える",
        "答えも正体も出さず、宙吊りのまま唐突に断つ",
        "ひとつだけ静かに警告して、それ以上踏み込まず引く",
        "「視えるかどうかは波長とタイミング」——読者が今そこにいる偶然を怪異にそっと結びつけ、言い切らず断つ(ファンキー中村の捉え方)"
    ]);
    const tone = pick([
        "短文を多めに、息を詰めるリズムで",
        "説明をそぎ、体言止めと余白(空行)で間を作る",
        "淡々とした記録口調で進め、最後の数行だけ崩す",
        "湿度のある情景をひとつだけ強く立てる",
        "穏やかで丁寧な、聞き手に語りかける口調のまま、間(ま)でじわじわ締める(怪談家ぁみの口承)"
    ]);
    // 「定番の怪異（赤い服の女など）」は禁じ手にしない(2026-10)。鉄則8で“必然があるときだけ使う”に統一。
    const forbid = pick([
        "「振り返ると誰もいなかった」だけで落とすこと", "「〜だったのです」式の説明オチ",
        "幽霊の姿を全身で描写すること", "「ゾッとした/恐怖した」等の感情語"
    ]);
    const block = `【今回だけの語りの指定（必ず守る・毎回変わる。鉄則1の型と両立させる）】
- **話の骨格（最重要・これに沿って組む）: ${structure}**
  └ 鉄則6の「日常→違和感→接近→手遅れ」は一例。この骨格が別の形を示すなら、骨格を優先して構成を組み替える。
- 語りの出どころ: ${teller}（実名や特定情報は出さない。型の選択は鉄則1に従う）
- 怪異の入口は「${entry}」を軸にする（正体は明かさず、この感覚の“わずかなズレ”から立ち上げる）
- 結末は: ${ending}
- 文体の色: ${tone}
- 今回の禁じ手（使わない）: ${forbid}`;
    // skeleton は評価集計のためにピンへ記録する(家族別に弱い骨格を炙り出す)
    return { block, skeleton: structure };
}

function buildPrompt(geo, anchors, now, extra) {
    const ex = extra || {};
    const variety = pickVariety(ex.weights);   // { block, skeleton } を一度だけ確定し、骨格をピンへ記録する
    const anchorBlock = anchors.length
        ? anchors.map((a, i) => {
            // 自前スポットは座標を建物単位で指さず、エリア表記の解像度で語らせる(§4)
            const where = a.kind === "local_spot"
                ? (a.areaLabel || "この一帯")
                : `${distanceLabel(a.distM)}${a.distM != null ? `／約${a.distM}m` : ""}`;
            const kataTag = a.kata ? `${a.kata}｜` : "";   // 型→語りの出どころ選択の手がかり
            const hint = a.hint ? `\n(語りの方向: ${a.hint})` : "";
            const src = a.url ? `${a.source} / ${a.url}` : a.source;
            return `【錨${i + 1}｜${kataTag}${where}】${a.text}${hint}\n(出典: ${src})`;
          }).join("\n\n")
        : "(利用できる土地の事実情報はありません。場所の属性と時間帯から生成してください)";

    const prompt = `# あなたの人格＝語り手「聞き集める者（蒐集者）」
あなたは、土地に積もった古い時間を聞き集め、いま現地にいる相手にそっと語りかける、実話怪談の名手。手本とする語り口は二人:
- 怪談家ぁみ（令和最恐の口承の名手）: 穏やかで丁寧な口調のまま、聞き手に語りかけるように運び、間(ま)で締める。声を荒げず、じわじわと抜けられない状況へ追い込む。決定的瞬間の直前で一拍置く。
- ファンキー中村（自ら体験した実話を語る先駆者）: 「自分が／ごく親しい誰かが、確かにこの目で体験した」という一人称の生々しさと親密さ。“霊感”でなく「波長とタイミング」——いまその場所にいて波長が合ってしまったから視えて(聞こえて)しまう、という捉え方。
補助として、新耳袋・川奈まり子のように感情語を使わず事実を淡々と積み、平山夢明のように最後だけ一行の刃を差し込み、残穢のように日常の下に積層した土地の来歴を怪異の理由に据える。
怖がらせようと力まない。理由も正体も結末も説明しない。読者が怖いと感じるなら、それは読者の足元が本当にそうだから。
読者は「いま、まさにその場所」でこの怪談を読みます。

あなたは毎回「同じ一人の語り手」です。名乗らず、自分の姿・素性・正体は一切描きません（無名のまま・気配だけ）。けれど“誰が語っているのか”は必ず読者に伝わるようにします——あなたは「この土地に積もった古い時間を聞き集めた者」であり、それをいま現地に立つ読者へ静かに手渡している、という立ち位置を、毎回はっきりと感じさせる。地の文だけが宙に浮く＝作り話に見える状態は禁止。

【読者の現在地】
- 町名: ${geo.town || "不明"}
- 住所の手がかり: ${geo.address || "不明"}
- 場所の種類: ${geo.placeType || "不明"}
- 今の時間帯: ${timeBand(now.getHours())}（※分刻みの時刻は与えない。物語でも数字の時刻は書かず、この時間帯か {{TIME}} を使う）
- 季節: ${seasonOf(now)}
${ex.weather ? `- いまの空模様: ${ex.weather}（鉄則9）` : ""}

【この土地の事実の錨(裏取り済み情報。事実として使ってよいのはこれだけ)】
${anchorBlock}

【執筆の鉄則】
0. **【語り手の枠｜毎回必ず・最重要｜これが無いと"作り話"に見える】**
   - **冒頭1〜3行で必ず「枠」を立てる**: ①これは“聞き集める者”であるあなたが、いま読者が立つ「この土地」について聞き集めた／掘り起こした話だと示す（例:「この町のことを尋ねて回ると、決まってこの話に行き当たる。」「ここの古い時間を辿ると、こんなものが出てくる。」）→ ②続けて、誰の体験・伝聞かを匿名で添える（鉄則1の型に従う。例:「——ある人が、確かにここで体験したという。」）。
   - **「誰が語っているか分からない地の文」でいきなり始めない。** 必ず“聞き集めた話を、いまそこにいる読者へ差し出す”形にする。
   - **末尾**は、その話をいま現地に立つ読者へそっと手渡して締める（「視えるかどうかは波長とタイミング——あなたが今そこにいるのは」のように、言い切らず示唆）。
   - 名乗り・自己描写・正体の説明は禁止（無名のまま気配だけ）。枠の“機能”は毎回固定、“言葉”は毎回変える（同じ言い回しを反復しない）。
1. 実話怪談の語り。**伝聞は「枠組み」で一度示し、本文は体験者の主観で生々しく語る**。錨(土地の事実)の性質に合わせて語りの“出どころ”を選ぶ:
   - 近年の個人の体験・噂・都市伝説型 → 「これは、◯◯から聞いた話です」と**匿名の体験者から聞いた話**として導入(年代・性別・関係性だけぼかす。必要なら仮名「彼女を仮にSさんとします」)。実名や特定情報は書かない。
   - 土地の歴史・古い事実(古戦場・刑場跡・古墳・塚・暗渠・災害・神社の由緒など) → 「この土地には、古くからこんな話が伝わっています」と**その土地に伝わる言い伝え**として語る。無理に個人の体験談へ仕立てない。
   - 折衷も可: 「この町で、ある人から聞きました——この土地に古く伝わるという話です」。
   - **文末に「〜そうです／〜だそうです／〜とのことです」を使うのは禁止（多用は興ざめ）**。伝聞だと示すのは冒頭の枠（「聞いた話だ」）一度きりで十分。以後の本文は、体験者がその場にいるように**過去形で言い切って**進める(例:「歩いていると、背後の足音が、いつまでも止まなかった」)。どうしても伝聞をにじませたい要所だけ「〜という」「〜と聞いた」を**全体で一度だけ**。「そうです」の連なりは絶対に作らない。
   - どの型でも結果的に読者の現在地と符合させる(指摘でなく符合)。語り出しの型は毎回変え、反復させない。
2. 恐怖の正体を説明しない。感情語(怖い・不気味など)を使わない。五感の描写のみ。
2b. **内容を薄くしない（厚み・最重要）**: 「気配がした」「何かがいた」だけで終わらせない。
   - 具体的な細部を**最低3つ**置く: 光や暗がりの質、音の種類、におい、相手の仕草や身につけたものの一部、数、手触り、温度など。抽象語でなく固有の感覚で書く。
   - 体験者に**小さな具体的行動**をさせる(数を数える/引き返す/触れてしまう/声をかける等)。その選択が事態を進める。
   - 出来事を **平穏→予感→接近→決定的な一瞬→その後の異変** まで必ず運ぶ。一場面で止めない。「その後」に小さな後日譚や残った痕跡を一つ置くと厚みが出る。
   - 錨の土地の事実は**飾りでなく怪異の“理由の芯”**として骨に通す(説明はしないが、読者が後で符合に気づく)。
3. 土地の事実(錨)を物語に自然に編み込む。**錨に無い「事実風の嘘」を絶対に書かない**(歴史・地名・出来事の捏造禁止)。創作してよいのは登場人物と怪異のみ。本文では事実を検証可能な形で説明しなくてよい——**裏取りは読後のエンドロール(出典)が担う**。本文の仕事は怖がらせること。
   - **指摘でなく符合**: 読者の現在地を「あなたは今ここにいる」と直接指さない。語り手自身が体験・伝聞した土地のこととして書き、結果として読者が「これは…今いる場所のことでは?」と自分で気づく形にする。当てると手品、符合させると怪異。
   - **質で錨を選ぶ(数は問わない)**: 最も強い土地の事実を物語の芯に据える。一本の筋が通り最も怖くなるなら錨は1つでよい。複数使うのは互いに響き合って質が上がるときだけで、無理な全部盛り(散漫)を避ける。距離の数字は書かない。最も近い土地の素性を「今この場所」として語りの中心に置く(コンセプトの核＝『今の場所』はぶらさない)。
4. 現存する個人・特定の住宅・営業中の店舗に怪異を紐づけない。読者を別の場所へ誘導・移動させない。
5. 土地の事件・死・心霊にまつわる錨は、必ずぼかして語る。
   - 「いつ・誰・どうやって」は書かない。「昔」「このあたりで」までの曖昧さに留める。
   - 場所を建物単位で指さず、エリア・方角の解像度で語る(錨に添えられた範囲表現をそのまま使う)。
   - 歴史化していない噂は「〜という話が残る」「〜と聞いた」の伝聞にし、事実と断定しない。
   - **見切れない曖昧さを残す**: 怪異も語り手も土地を完全には把握していない。「この辺りに、古い水場のようなものが…ありませんか」のように、わからなさ・言いよどみを残す(全部を見通したように書かない)。
6. 構成: 静かな日常→微かな違和感→理不尽な接近→手遅れ、の順。
   - **怖さは"わずかなズレ"から作る**: 数がひとつ多い、影がひとつ足りない、音が半拍ずれる、いつもと同じはずの道がどこか違う——説明・正体・理由は書かない。読者の身体感覚に近い小さな異常ほど効く。
   - **結末＝余韻の設計**: 最後の2〜3行で、語りの怪異を読者の『今いる場所・今の時間帯・身体』へそっと侵入させ、言い切らずに断ち切る。読み終えて顔を上げたとき、読者の現実が一段ズレて見えるように。オチを説明して回収しない。怖いのは「読後にまだ続いている」感覚。
7. 文中に {{TIME}} と書くと、読者が読んでいる「時間帯」の言葉(例: 昼下がり/夕暮れどき/宵/真夜中)に置換される。**分刻みの時刻ではない**ので、「{{TIME}}のことでした」「ちょうど{{TIME}}の頃」のように時間帯として自然に使う。『時計の針が〜を指す』のような数字・分刻みの表現は禁止。冒頭で1回だけ。読者の“今と同じ時間帯の話”という符合をさりげなく作る。
8. **定番の怪異・言い回しは「必然があるときだけ」使う（禁止ではない）**: 赤い服の女、長い黒髪で顔の見えない女、白い着物、鏡に映る背後の人影、首の無い武者、子どもの笑い声、などの“定番”は、
   - **使ってよい**: 錨の土地の事実（例: 古戦場・刑場・水難・祭り・地蔵）や話の流れと結びつき、定番であることがかえって怖さを増すとき（「知っているはずの怖さが、ここで本当に起きる」）。その場合も部分・痕跡で見せ、全身を描写しない。
   - **避ける**: 土地とも流れとも関係なく「怪談らしさ」のために置くだけのとき。その場合は、生活の中の具体的な違和感（見慣れた物の数・位置・温度・におい・声の調子のズレ）に置き換える。
9. **いまの空模様**が与えられていれば、本文のどこかで**一度だけ**、さりげなく重ねる（例:「ちょうど今夜のような、細い雨の晩だった」「こんなふうに風のない夜は——」）。天気の説明はしない。与えられた空模様と矛盾する天気を、読者の“いま”として書かない（過去の出来事の天気は自由）。

【語りのテンポと質感（呼吸・緩急・間を手本に。下の手本の語句・設定・事実は真似ず、リズムだけ真似る）】
- 視点と時制: 一人称の過去形を基調に、**怪異の核心だけ現在形**へ切り替えて臨場感を出す(「足音が、止まる」「すぐうしろにいる」)。
- リズム: 状況説明は長めの文、怪異の発生・焦燥は**短文の畳みかけ・反復**で詰める。
- 間: 体験談型は反復や短い疑問(「え。何。」)で、土地伝承型は同行者の軽い否定(「気のせいだろう」)で一度ゆるめてから落とす。
- 伝聞の使い分け: **「〜そうです／〜だそうです」は使わない**。背景や噂をにじませたい時だけ「〜という」を全体で一度。語り手が見聞きした核心は必ず言い切る。怪異の最中は言い切りのみ。
- 怪異は正体でなく**部分・痕跡**で見せる(足だけ/手のあと/足音だけ)。
- 結末: 体験談型は答えを出さず宙吊り、土地伝承型は曰くと現象を結びつけるか、そっと注意を促して終える。

手本1（人から聞いた体験談型）:
これは、前の職場の先輩から聞いた話だ。仮にNさんとしておく。
Nさんがこの町に住んでいたのは、もう十年も前になる。
{{TIME}}、駅から続く細い坂道を、いつも一人で帰った。
ある晩、坂の半ばで、後ろから足音がついてきた。
革靴の、硬い音。
歩調を合わせてみると、向こうも合わせてくる。
速めれば、速くなる。
立ち止まれば——止まる。
ただ、止まったあとに、もう一歩だけ、音が鳴った。
すぐ後ろで。
Nさんは坂を駆け上がり、それきり、夜にあの道を使うのをやめた。
坂の下がかつてどういう場所だったのか、知ったのは、ずっと後のことだ。

手本2（土地に伝わる型。※「そうです」を使わない。具体的な痕跡で厚みを出す）:
この土地には、古くからの言い伝えがある。
今は区画整理された平らな住宅地だが、ひと筋だけ、妙に低くなった通りがある。
そこは昔、水を抜いて埋めた土地だと聞いた。
雨の{{TIME}}、その通りで足を取られた人がいる。
泥のせいだと思って下を見ると、濡れた手のかたちが、地面に幾つも残っていた。
自分の靴の甲にも、同じ濡れた跡が、ぴたりと付いていた。
拭いても、その晩は乾かなかった。
低い土地を通るときは、足元を見ないほうがいい。
見れば、向こうも、見上げてくる。

※上の手本は「呼吸・緩急・間」を学ぶための参考。語句・設定・展開はなぞらず、必ず下の【今回だけの語りの指定】に従って毎回違う表情にすること。

${variety.block}

【出力フォーマット(厳守)】
[STORY]
**1つの文(句点「。」まで)を必ず1行にする。** 句点の途中で改行してはいけない。一文が長くてもそのまま1行で書く。短い体言止めや「……」だけの行は許容。全体で30〜45行程度（薄い場合は細部と「その後」を足して厚くする。水増しの繰り返しは不可）。
強い展開の前後には空白行を1つ入れて「間」を作る。
**禁止: 文末の「〜そうです／〜だそうです／〜とのことです」。** 伝聞は冒頭の枠で一度だけ。本文は過去形で言い切る。
【演出タグ（控えめに・内容と合わせる）】
- 使えるのは次の種類のみ。必ず単独行で、**その出来事を書いた行の直後**に置く:
  [SOUND:THUMP] [SOUND:HEARTBEAT] [SOUND:STATIC] [SOUND:RINGING] [SOUND:VOICE] [SOUND:RAIN] [SOUND:SILENCE] [SOUND:KNOCK] [SOUND:FOOTSTEP] [SOUND:DOOR] [SOUND:PHONE] [SOUND:CHILD] [SOUND:CROSSING] [SOUND:SCRATCH] [SOUND:BREATH] [SOUND:WATER] [VISUAL:SHAKE] [VISUAL:FLASH] [VISUAL:BLACKOUT] [VISUAL:BLINK] [VISUAL:GHOST] [VISUAL:STREETLIGHT_FLICKER]
- **音のタグ([SOUND:..])は、直前の行にその音が“書かれている”ときだけ**置く。本文に無い音を鳴らして脅かすのは禁止（意図が透けて冷める）。
  - 音の場面は、擬音で書くと効く: 「コン、コン。」「カツッ……カツッ……」「ギィ、と戸が鳴った」「ぽたり、と落ちた」。その行の直後に対応するタグを置く。足音の擬音は数えて鳴らすので、聞かせたい歩数だけ書く。
  - **「しん、と静まり返った」「音が消えた」など無音の場面には [SOUND:SILENCE]** を置く（環境音がピタッと止まる）。無音は数に含めない。
- 数は絞る: **無音以外で1話に合計2〜3個まで**。出しすぎは雰囲気を壊す。無くてよい場面には入れない。
- 置かない場所: **静かな冒頭の数行と、結末(余韻)の数行には入れない**。
- 内容と合わせる: 足音→FOOTSTEP、雨の描写→RAIN、しんと静まる瞬間→SILENCE、戸を叩く→KNOCK、耳鳴り→RINGING、背後の声/ささやき→VOICE、砂嵐/ノイズ→STATIC、何かが落ちる/倒れる重い音→THUMP、鼓動→HEARTBEAT、戸がきしんで開く/閉まる→DOOR、電話が鳴る→PHONE、笑い声→CHILD、踏切の警報→CROSSING、壁や戸をひっかく→SCRATCH、すぐそばの息づかい→BREATH、水がぽたりと落ちる→WATER。描写と無関係な演出は入れない。
- **強い演出([VISUAL:BLACKOUT]/[VISUAL:BLINK]/[VISUAL:FLASH]/[VISUAL:SHAKE])は、手遅れの決定的な一瞬に1回だけ**。乱発しない。([VISUAL:BLINK]=画面が完全に真っ暗に明滅する)
[/STORY]
[META]
{"title": "ピン一覧用の短い題(12字以内・ネタバレ禁止)", "tags": ["状況タグを3〜4個"], "usedAnchors": [使った錨の番号の配列。例: [1,3]], "shareText": "ネタバレなしで土地の事実を一片だけ含む共有文(60字以内)", "ambience": "話の舞台に最も合う環境音を次から1つ: rain(雨の夜) / residential(静かな住宅街・夜道) / water(川・池・海などの水辺) / forest(山・林・神社・墓地) / tunnel(地下道・トンネル・駅の構内・地下駐車場) / room(部屋の中・屋内の深夜)"}
[/META]`;
    return { prompt, skeleton: variety.skeleton };
}

// ---------- 生成後の安全検品(プロンプトのお願いだけに頼らない“最後の砦”) ----------
/**
 * 任意で足せるブラックリスト。施設の固有名や、出さないと決めた語をここに入れると
 * 本文中で「ある場所」にぼかされる。既定は空(=プロンプト規律＋パターン検出のみ)。
 */
const SAFETY_BLACKLIST = [];

/**
 * 怪談本文(lines)から、土地の事実を錨にする方針に反する“特定情報”を検出して伏せる。
 * 規律(コンセプト思想・プロンプト鉄則): 近隣の特定住居・実在の連絡先・実在個人には触れない。
 *   - 郵便番号 / 電話番号 → 除去
 *   - 番地表現(丁目+番地、N番地、N番M号、3連ハイフン数字) → 「このあたり」にぼかす
 *   - ブラックリスト語 → 「ある場所」にぼかす
 *   - 他言語文字の混入(キリル文字。BUGLOG #2) → 除去。簡体字らしき字はフラグのみ
 * 触らないもの: ギミックタグ行 [SOUND:..]/[VISUAL:..] と空行。
 *   また「N番ホーム」「N番線」等の鉄道表現は住所ではないので誤検出しない(N番単独は対象外)。
 * 返り値: { lines, flags } flagsは手を入れた箇所のログ(デバッグログに出す)。
 */
function sanitizeStoryLines(lines, options) {
    const opts = options || {};
    const blacklist = Array.isArray(opts.blacklist) ? opts.blacklist : SAFETY_BLACKLIST;
    const TAG = /^\[(?:SOUND|VISUAL):[A-Z_]+\]$/;
    const flags = [];

    // 順番に適用(具体的な番地表現を先に、単独数字は対象にしない)
    const rules = [
        { type: "postal",  re: /〒?\s?\d{3}-\d{4}/g,                 to: "" },
        { type: "phone",   re: /0\d{1,3}[-(]\d{1,4}[-)]?\d{3,4}/g,  to: "" },
        { type: "address", re: /\d+丁目\d+番地?(?:\d+号)?/g,         to: "このあたり" },
        { type: "address", re: /\d+番地(?:\d+号)?/g,                 to: "このあたり" },
        { type: "address", re: /\d+番\d+号/g,                        to: "このあたり" },
        { type: "address", re: /\d{1,4}-\d{1,4}-\d{1,4}/g,          to: "このあたり" },
    ];

    const out = (lines || []).map((raw, idx) => {
        let line = raw == null ? "" : String(raw);
        if (line.trim() === "" || TAG.test(line.trim())) return line; // 触らない

        // 1) パターン伏せ字
        for (const r of rules) {
            line = line.replace(r.re, (m) => {
                flags.push({ line: idx, type: r.type, original: m });
                return r.to;
            });
        }
        // 2) ブラックリスト
        for (const term of blacklist) {
            if (!term) continue;
            if (line.indexOf(term) >= 0) {
                flags.push({ line: idx, type: "blacklist", original: term });
                line = line.split(term).join("ある場所");
            }
        }
        // 3) キリル文字混入は除去、簡体字らしき字はフラグのみ(誤切り防止)
        if (/[Ѐ-ӿ]/.test(line)) {
            const removed = (line.match(/[Ѐ-ӿ]+/g) || []).join("");
            flags.push({ line: idx, type: "cyrillic", original: removed });
            line = line.replace(/[Ѐ-ӿ]+/g, "");
        }
        if (/[们为这]/.test(line)) {
            flags.push({ line: idx, type: "non_jp_cjk", original: (line.match(/[们为这]/g) || []).join("") });
        }
        return line;
    });

    return { lines: out, flags };
}

// ---------- 演出タグの安全弁(プロンプトのお願いだけに頼らない“最後の砦”) ----------
/**
 * 生成された本文の演出タグ([SOUND:..]/[VISUAL:..])を、雰囲気を壊さない範囲に間引く。
 *   - 合計は maxTotal 個まで(既定3)
 *   - 静かな冒頭(openingGuard 行)と結末(closingGuard 行)には演出を置かない
 *   - 強い演出(SHAKE/FLASH/BLACKOUT)は1つだけ。残すのは最もクライマックス寄り(後方)の1つ
 *   - 上限超過ぶんは、間隔が詰まっている演出から外す(強い1つは死守)
 * テキスト行・空行はそのまま。返り値 { lines, flags }(間引いた記録)。
 */
function capGimmicks(lines, options) {
    const o = options || {};
    const MAX_TOTAL = o.maxTotal != null ? o.maxTotal : 3;
    const OPENING = o.openingGuard != null ? o.openingGuard : 4;
    const CLOSING = o.closingGuard != null ? o.closingGuard : 3;
    const TAG = /^\[(?:SOUND|VISUAL):[A-Z_]+\]$/;
    const STRONG = { "[VISUAL:SHAKE]": 1, "[VISUAL:FLASH]": 1, "[VISUAL:BLACKOUT]": 1, "[VISUAL:BLINK]": 1 };
    const src = lines || [];

    // テキスト行の総数
    let textTotal = 0;
    src.forEach(l => { const t = (l == null ? "" : String(l)).trim(); if (t !== "" && !TAG.test(t)) textTotal++; });

    // 各タグに「直前までのテキスト行数(=物語の位置)」を付ける
    let seen = 0;
    const tags = [];
    src.forEach((l, idx) => {
        const t = (l == null ? "" : String(l)).trim();
        if (t === "") return;
        if (TAG.test(t)) tags.push({ idx, tag: t, pos: seen });
        else seen++;
    });

    const removed = new Set();
    const flags = [];

    // 1) 冒頭・結末ゾーンの演出を外す
    tags.forEach(g => {
        if (g.pos < OPENING || g.pos > textTotal - CLOSING) {
            removed.add(g.idx); flags.push({ type: "zone", tag: g.tag });
        }
    });

    // 2) 強い演出は1つだけ(最もクライマックス寄り=後方を残す)
    const strong = tags.filter(g => !removed.has(g.idx) && STRONG[g.tag]);
    if (strong.length > 1) {
        const keep = strong[strong.length - 1];
        strong.forEach(g => { if (g !== keep) { removed.add(g.idx); flags.push({ type: "strong_extra", tag: g.tag }); } });
    }

    // 3) 合計上限。多ければ間隔の詰まったものから外す(強いタグは守る)
    const SILENCE = "[SOUND:SILENCE]";   // 無音(環境音を止める)は脅かしではないので数に含めない(2026-10)
    let kept = tags.filter(g => !removed.has(g.idx) && g.tag !== SILENCE);
    while (kept.length > MAX_TOTAL) {
        let target = null, minGap = Infinity;
        for (let i = 0; i < kept.length; i++) {
            if (STRONG[kept[i].tag]) continue; // 強いタグは守る
            const prev = i > 0 ? kept[i - 1].pos : -OPENING;
            const next = i < kept.length - 1 ? kept[i + 1].pos : textTotal + CLOSING;
            const gap = Math.min(kept[i].pos - prev, next - kept[i].pos);
            if (gap < minGap) { minGap = gap; target = kept[i]; }
        }
        if (!target) break; // 残りが全部強いタグ等
        removed.add(target.idx); flags.push({ type: "over_total", tag: target.tag });
        kept = tags.filter(g => !removed.has(g.idx) && g.tag !== SILENCE);
    }

    const out = src.filter((_, idx) => !removed.has(idx));
    return { lines: out, flags };
}

// ---------- 音タグの検品(2026-10): 本文に書かれていない音は鳴らさない ----------
function getCues() {
    if (typeof ImakokoCues !== "undefined") return ImakokoCues;
    if (typeof require !== "undefined") { try { return require("./sound_cues.js"); } catch (e) { /* noop */ } }
    return null;
}
/**
 * - [SOUND:..] の直前2行に、その音を示す言葉・擬音が無ければ外す
 * - 「しん、と静まり返る」行の直後に [SOUND:SILENCE] が無ければ足す
 * 返り値 { lines, flags }
 */
function validateSoundTags(lines) {
    const cues = getCues();
    if (!cues) return { lines: lines || [], flags: [] };
    const TAG = /^\[(?:SOUND|VISUAL):[A-Z_]+\]$/;
    const src = (lines || []).slice();
    const out = [], flags = [];
    const prevTexts = [];          // 直前のテキスト行（新しい順に2つ）
    const moveAfterNext = [];      // 次の行に音が書かれている場合は、その行の後ろへ移す
    for (let i = 0; i < src.length; i++) {
        const l = src[i];
        const t = (l == null ? "" : String(l)).trim();
        if (t.startsWith("[SOUND:") && TAG.test(t)) {
            const m = cues.match(t, prevTexts[0] || "", prevTexts[1] || "");
            if (m.ok) { out.push(l); continue; }
            // 次のテキスト行に音が書かれていれば、その行の直後へ移す（タグが一行早く置かれた場合）
            let nextText = "";
            for (let j = i + 1; j < src.length; j++) { const u = String(src[j] || "").trim(); if (u && !TAG.test(u)) { nextText = u; break; } }
            if (nextText && cues.match(t, nextText).ok) { moveAfterNext.push(t); flags.push({ type: "moved", tag: t, line: nextText.slice(0, 30) }); continue; }
            flags.push({ type: "no_cue", tag: t, line: (prevTexts[0] || "").slice(0, 30) });
            continue;
        }
        out.push(l);
        if (t && !TAG.test(t)) {
            prevTexts.unshift(t); prevTexts.length = Math.min(prevTexts.length, 2);
            while (moveAfterNext.length) out.push(moveAfterNext.shift());
        }
    }
    // 無音の自動付与
    const res = [];
    for (let i = 0; i < out.length; i++) {
        res.push(out[i]);
        const t = String(out[i] || "").trim();
        if (t && !TAG.test(t) && cues.isHush(t)) {
            let has = false;
            for (let j = i + 1; j < out.length && j <= i + 2; j++) if (String(out[j]).trim() === "[SOUND:SILENCE]") has = true;
            if (!has) { res.push("[SOUND:SILENCE]"); flags.push({ type: "add_silence", line: t.slice(0, 30) }); }
        }
    }
    return { lines: res, flags };
}

// ---------- 応答パース ----------

const AMBIENCES = ["rain", "residential", "water", "forest", "tunnel", "room"];

// ---------- 2026-10: 季節・いまの天気 ----------
function seasonOf(d) {
    const m = d.getMonth() + 1;
    return m <= 2 || m === 12 ? "冬" : m <= 5 ? "春" : m <= 8 ? "夏" : "秋";
}
const WMO_JA = {
    0: "晴れ", 1: "晴れ", 2: "薄曇り", 3: "曇り", 45: "霧", 48: "霧（霧氷）",
    51: "霧雨", 53: "霧雨", 55: "強い霧雨", 56: "冷たい霧雨", 57: "冷たい霧雨",
    61: "小雨", 63: "雨", 65: "強い雨", 66: "冷たい雨", 67: "冷たい強い雨",
    71: "小雪", 73: "雪", 75: "大雪", 77: "霧雪", 80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨",
    85: "にわか雪", 86: "強いにわか雪", 95: "雷雨", 96: "ひょうを伴う雷雨", 99: "ひょうを伴う雷雨"
};
/**
 * いまの天気（Open-Meteo・無料・キー不要）。座標は小数2桁(約1km)に丸めて送る（プライバシー）。
 * 失敗しても生成は止めない（null を返す）。
 */
async function fetchWeather(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`
            + `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,is_day&timezone=auto`;
        const j = await fetchJson(url, 4000);
        const c = j && j.current;
        if (!c) return null;
        const sky = WMO_JA[c.weather_code] || "";
        const wind = c.wind_speed_10m == null ? "" : c.wind_speed_10m < 5 ? "風はほとんどない" : c.wind_speed_10m < 20 ? "やや風がある" : "風が強い";
        const hum = c.relative_humidity_2m >= 85 ? "空気がひどく湿っている" : c.relative_humidity_2m <= 35 ? "空気が乾いている" : "";
        const temp = c.temperature_2m != null ? `気温${Math.round(c.temperature_2m)}℃` : "";
        return [sky, temp, wind, hum].filter(Boolean).join("・");
    } catch (e) { return null; }
}

// ---------- 2026-10: 推敲（編集者AIが怖さの観点で添削して書き直す） ----------
function buildRefinePrompt(draftRaw, anchors, ex) {
    const facts = anchors.length
        ? anchors.map((a, i) => `【錨${i + 1}】${a.text.slice(0, 220)}`).join("\n")
        : "(錨なし)";
    return `# あなたは実話怪談の名編集者
新耳袋・平山夢明・川奈まり子の本を手がけてきた。下の【初稿】を、**同じ話のまま**「もっと怖く、もっと具体的に、もっと余韻が残る」ように書き直す。
新しい話に作り替えない。登場人物・骨格・語り手の枠・使った土地の事実は保つ。

【書き直しの観点（上から順に効く）】
1. **説明を削る**: 怪異の正体・理由・因果を説明している文、読者に感想を言わせる文、「〜のです」で回収する文を消す。わからないまま残すほうが怖い。
2. **抽象を具体へ**: 「不気味な」「異様な」「何か」「気配」だけの文を、五感の具体（光の色・音の種類・におい・温度・手触り・数）に置き換える。感情語（怖い・ゾッとした等）は使わない。
   - ただし**ミリ・センチ・メートル等の測った数値は一話に一つまで**。数字で測るより、体の感覚（指一本ぶん・息がかかるほど）で書く。
3. **日常の手触りを足す**: 体験者の生活の具体（持ち物・習慣・いつもの道順・部屋の様子）を1〜2点だけ足し、そこに入り込む“わずかなズレ”を際立たせる。
4. **ズレを段階で強める**: 最初の違和感 → 二度目は少し大きく → 三度目で決定的、のように積み上げる。同じ強さの出来事を並べない。
5. **最後の2〜3行を研ぐ**: 余計な締めの文・まとめ・教訓を削る。最後の一文は短く、読者の“いま・ここ・身体”へ矛先を向けて、言い切らずに断つ。
   - 語り手が読者へ話を手渡す締め（いまそこに立つあなたへ、という示唆）は消さない。研ぐのは言葉であって、枠ではない。
6. **定番の扱い（鉄則8）**: 赤い服の女・長い黒髪・鏡の人影などの定番は、土地の事実や流れに必然があり怖さを増すなら残す。必然がなく“怪談らしさ”のためだけなら、生活の中の具体的な違和感に置き換える。
7. **テンポ**: 状況は長めの文、怪異の瞬間は短文の畳みかけ。強い展開の前後に空行で間。
${ex && ex.weather ? `8. いまの空模様は「${ex.weather}」。初稿で天気が読者の“いま”と矛盾していれば直す。重ねるのは一度だけ。{{TIME}}（時間帯）と同じ文で「昼下がり」「夜」など時間帯の言葉を重ねない。` : ""}

【絶対に守ること（初稿の規則をそのまま引き継ぐ）】
- 冒頭1〜3行の「語り手の枠」（聞き集めた話をいまここにいる読者へ差し出す形）と、末尾の手渡しを必ず残す。
- 土地の事実は下の錨にあるものだけ。**錨に無い事実風の嘘を足さない**。地名・事件・年代を新しく作らない。事件・死はぼかしたまま。
- 1文1行、全体30〜45行。文末の「〜そうです／〜だそうです／〜とのことです」は禁止。{{TIME}} は冒頭で1回だけ（初稿にあれば残す）。
- 演出タグ（[SOUND:..]/[VISUAL:..]）は初稿のものを、対応する出来事の行の直後に残す。新しく増やさない（無音以外で合計3個まで）。
- **音のタグは、直前の行にその音が書かれているときだけ残す**。書き直しで音の描写が消えたらタグも消す。音の場面は擬音（「コン、コン。」「カツッ……カツッ……」）で書くと効く。「しん、と静まり返る」場面には [SOUND:SILENCE] を置いてよい。
- 実在の個人・住宅・営業中の店舗に怪異を紐づけない。読者を移動させない。
- 出力は初稿と**同じ形式**（[STORY]〜[/STORY] と [META]〜[/META]）。METAのJSONは初稿の値を基本に、題が弱ければ直してよい。前置き・解説は一切書かない。

【この土地の事実の錨】
${facts}

【初稿】
${draftRaw}`;
}

function parseGenerated(text, anchors) {
    const storyMatch = text.match(/\[STORY\]([\s\S]*?)\[\/STORY\]/);
    const metaMatch = text.match(/\[META\]([\s\S]*?)\[\/META\]/);
    const storyText = (storyMatch ? storyMatch[1] : text).trim();
    const lines = storyText.split(/\r?\n/).map(l => l.trim());
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    let meta = {};
    if (metaMatch) {
        try {
            const jsonStr = metaMatch[1].trim().replace(/^```json?/, "").replace(/```$/, "").trim();
            meta = JSON.parse(jsonStr);
        } catch (e) {
            Logger.warn("METAのJSONパース失敗(フォールバックで続行)", String(e.message));
            meta = {};
        }
    }
    const used = Array.isArray(meta.usedAnchors) ? meta.usedAnchors : anchors.map((_, i) => i + 1);
    const credits = anchors
        .filter((_, i) => used.includes(i + 1))
        .map(a => ({ fact: a.text.slice(0, 160), source: a.source, url: a.url, distM: a.distM ?? null }));

    return {
        title: typeof meta.title === "string" ? meta.title.slice(0, 20) : "",
        tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 5).map(String) : [],
        shareText: typeof meta.shareText === "string" ? meta.shareText.slice(0, 90) + " #イマココ怪談" : "いまいる場所の怪談を聞いた。 #イマココ怪談",
        lines,
        credits,
        ambience: AMBIENCES.includes(meta.ambience) ? meta.ambience : "",
        creditsNote: credits.length
            ? "この怪談はフィクションです。ただし、上の土地の事実は本物です。"
            : "この怪談はフィクションです。"
    };
}

// ---------- メインフロー ----------

if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("generate-btn");
    const statusEl = document.getElementById("status");
    const apiKeyInput = document.getElementById("api-key");

    const savedKey = localStorage.getItem("imakoko_api_key");
    if (savedKey) apiKeyInput.value = savedKey;

    // ---- APIキーの保存と判定(2026-10) ------------------------------------------
    // 判定はモデル一覧を1件取るだけの通信で行う（文章を作らないので料金はかからない）
    const keyStatus = document.getElementById("api-key-status");
    const keySaveBtn = document.getElementById("api-key-save");
    function showKeyStatus(cls, text) {
        if (!keyStatus) return;
        keyStatus.className = "key-status" + (cls ? " " + cls : "");
        keyStatus.textContent = text;
    }
    const looksLikeKey = (k) => /^AIza[0-9A-Za-z_\-]{35}$/.test(k);
    async function verifyKey(key) {
        if (!/^https?:$/.test(location.protocol)) return { state: "warn", text: "この画面では通信できないため確認できません。ブラウザでサイトのURLを開いてください。" };
        try {
            const res = await fetch(`${GEMINI_API_BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": key } });
            if (res.ok) return { state: "ok", text: "✓ 有効なキーです。この端末に保存しました。" };
            const body = await res.text();
            if (/API_KEY_INVALID|API key not valid|API key expired/i.test(body) || res.status === 400) {
                return { state: "ng", text: "✗ このキーは使えません（無効か期限切れ）。Google AI Studio でキーを確かめてください。" };
            }
            if (res.status === 403) return { state: "ng", text: "✗ このキーでは Gemini API が許可されていません（APIが無効、または利用制限）。" };
            if (res.status === 429) return { state: "warn", text: "△ キーは届きましたが、いま利用回数の上限に達しています。少し待ってからお試しください。" };
            return { state: "warn", text: `△ 確認できませんでした（エラー ${res.status}）。時間をおいてもう一度お試しください。` };
        } catch (e) {
            return { state: "warn", text: "△ 通信できず確認できませんでした。電波の良い場所でもう一度お試しください。" };
        }
    }
    async function saveAndVerify() {
        const key = apiKeyInput.value.trim();
        if (!key) { showKeyStatus("ng", "APIキーを入力してください。"); return; }
        localStorage.setItem("imakoko_api_key", key);
        if (!looksLikeKey(key)) {
            showKeyStatus("warn", "△ 保存しましたが、キーの形が見慣れません（通常は「AIza」で始まる39文字）。確認しています…");
        } else {
            showKeyStatus("", "確認しています…");
        }
        if (keySaveBtn) keySaveBtn.disabled = true;
        const r = await verifyKey(key);
        if (keySaveBtn) keySaveBtn.disabled = false;
        showKeyStatus(r.state, r.text);
        Logger.info("APIキーの確認", `${r.state}（末尾 ${key.slice(-4)}）`);
    }
    if (keySaveBtn) keySaveBtn.addEventListener("click", saveAndVerify);
    apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveAndVerify(); } });
    // 入力中は形だけ見る（通信しない）
    apiKeyInput.addEventListener("input", () => {
        const k = apiKeyInput.value.trim();
        if (!k) showKeyStatus("", "");
        else if (looksLikeKey(k)) showKeyStatus("", "形はOKです。「保存して確認」を押すと、使えるキーか確かめます。");
        else showKeyStatus("warn", "キーの形が違うようです（通常は「AIza」で始まる39文字）。");
    });
    // 開いたとき、保存済みのキーがあれば静かに確認して結果を表示
    if (savedKey) {
        showKeyStatus("", `保存済みのキー（末尾 ${savedKey.slice(-4)}）を確認しています…`);
        verifyKey(savedKey).then(r => showKeyStatus(r.state, r.state === "ok"
            ? `✓ 保存済みのキー（末尾 ${savedKey.slice(-4)}）は有効です。` : r.text));
    }

    // モデル選択の復元・保存
    const modelSelect = document.getElementById("model-select");
    const savedModel = localStorage.getItem("imakoko_model");
    if (savedModel && modelSelect && [...modelSelect.options].some(o => o.value === savedModel)) {
        modelSelect.value = savedModel;
    }
    if (modelSelect) {
        modelSelect.addEventListener("change", () => localStorage.setItem("imakoko_model", modelSelect.value));
    }

    // 語り手の声(読み上げ)のON/OFF。初期OFF。OFFの間は音声生成を一切行わない(settings.js)
    const voiceToggle = document.getElementById("voice-enabled");
    if (voiceToggle && window.ImakokoSettings) {
        voiceToggle.checked = ImakokoSettings.voiceEnabled();
        voiceToggle.addEventListener("change", () => {
            ImakokoSettings.setVoiceEnabled(voiceToggle.checked);
            Logger.info("語り手の声", voiceToggle.checked ? "ON" : "OFF");
        });
    }

    // 推敲のON/OFF(初期ON)
    const refineToggle = document.getElementById("refine-enabled");
    if (refineToggle && window.ImakokoSettings) {
        refineToggle.checked = ImakokoSettings.refineEnabled();
        refineToggle.addEventListener("change", () => {
            ImakokoSettings.setRefineEnabled(refineToggle.checked);
            Logger.info("推敲", refineToggle.checked ? "ON" : "OFF");
        });
    }

    // 怖さ(控えめ/標準/本気)。読む画面の灯りの乱れ・一瞬の恐怖演出・強い視覚演出の量が変わる(settings.js)
    const scareSel = document.getElementById("scare-level");
    if (scareSel && window.ImakokoSettings) {
        scareSel.value = ImakokoSettings.scareLevel();
        scareSel.addEventListener("change", () => {
            ImakokoSettings.setScareLevel(scareSel.value);
            Logger.info("怖さ", scareSel.value);
        });
    }

    Logger.info("イマココ怪談 起動", {
        ua: navigator.userAgent.slice(0, 80),
        secure: window.isSecureContext,
        online: navigator.onLine
    });

    // ログパネルの操作
    document.getElementById("log-copy").addEventListener("click", async () => {
        const text = Logger.text() || "(ログは空です)";
        const btnEl = document.getElementById("log-copy");
        try {
            await navigator.clipboard.writeText(text);
            btnEl.textContent = "コピーしました";
        } catch (e) {
            // clipboard API が使えない場合のフォールバック
            const ta = document.createElement("textarea");
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            btnEl.textContent = "コピーしました";
        }
        setTimeout(() => btnEl.textContent = "ログをコピー", 2000);
    });
    document.getElementById("log-clear").addEventListener("click", () => Logger.clear());

    function setStatus(text, cls = "") {
        statusEl.textContent = text;
        statusEl.className = "status " + cls;
    }

    // 通信できない開き方(アプリ内プレビュー・file://等)を起動時に検知して案内する
    const OPEN_IN_BROWSER = "ブラウザのアドレスバーに http://localhost:8000/index.html を入れて開いてください（公開後はサイトのURL）。";
    const isWebOrigin = /^https?:$/.test(location.protocol);
    if (!isWebOrigin) {
        setStatus("この画面では通信できないため、怪談を生成できません。" + OPEN_IN_BROWSER, "error");
        Logger.warn("通信できない開き方を検知", location.protocol);
    }

    btn.addEventListener("click", async () => {
        if (!isWebOrigin) {
            setStatus("この画面では通信できないため、怪談を生成できません。" + OPEN_IN_BROWSER, "error");
            return;
        }
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            document.getElementById("settings").open = true;
            setStatus("Gemini APIキーを設定してください。", "error");
            Logger.warn("APIキー未設定のため中断");
            return;
        }
        localStorage.setItem("imakoko_api_key", apiKey);
        btn.disabled = true;

        try {
            // 1. 位置情報
            setStatus("……あなたの座標を、探しています……", "tuning");
            const pos = await getPosition();
            const lat = pos.coords.latitude, lon = pos.coords.longitude;
            Logger.info("測位成功", { lat: lat.toFixed(5), lon: lon.toFixed(5), accuracy: Math.round(pos.coords.accuracy) + "m" });

            // 2. 錨収集(並列)
            setStatus("……この土地の記憶を、掘り起こしています……", "tuning");
            const [geo, localSpots, wiki, weather, pinsForWeights] = await Promise.all([
                reverseGeocode(lat, lon),
                fetchLocalSpotAnchors(lat, lon),
                fetchWikipediaAnchors(lat, lon),
                fetchWeather(lat, lon),                                            // いまの空模様(2026-10)
                ImakokoDB.getAllPins().catch(() => [])                             // 星評価→骨格の重み(2026-10)
            ]);
            const weights = skeletonWeights(pinsForWeights);
            Logger.info("いまの空模様", weather || "(取得できず→天気なしで生成)");
            Logger.info("骨格の重み", Object.keys(weights).length ? `${Object.keys(weights).length}種に評価反映` : "(評価なし→均等)");
            // 自然災害伝承碑は現状タイルが取得不能(z12が全座標404)。毎回の無駄打ちとデッド錨を避けるため停止。
            // 正しい配信ズーム/形式を確定してから fetchDisasterLore を再投入する(BUGLOG #11)。
            const lore = [];
            // 自前スポット(最も統制された“その場所固有の事実”)を先頭に、続けて伝承碑・Wikipediaを近い順に。
            const localFirst = localSpots
                .slice()
                .sort((a, b) => (a.priority - b.priority) || ((a.distM ?? 9e9) - (b.distM ?? 9e9)));
            const rest = [...lore, ...wiki]
                .sort((a, b) => (a.distM ?? 9e9) - (b.distM ?? 9e9));
            const anchors = [...localFirst, ...rest].slice(0, 5);
            Logger.info(`錨収集完了: ${anchors.length}本(近い順)`,
                anchors.map(a => `${a.title}(${a.distM != null ? a.distM + "m" : "?"})`).join(" / ") || "(なし→場所タイプで生成)");

            // 3. 生成
            const chosenModel = modelSelect ? modelSelect.value : null;
            Logger.info("選択モデル", chosenModel || "(既定チェーン)");
            setStatus("……この座標の周波数に、合わせています……", "tuning");
            const built = buildPrompt(geo, anchors, new Date(), { weather, weights });
            const raw = await callGemini(apiKey, built.prompt, chosenModel);
            let story = parseGenerated(raw, anchors);
            // 推敲(2026-10): 編集者AIが怖さの観点で添削して書き直す。失敗・異常時は初稿を使う
            let draftLines = null, refined = false;
            const textCount = (ls) => ls.filter(l => l && !String(l).startsWith("[")).length;
            if (window.ImakokoSettings && ImakokoSettings.refineEnabled() && textCount(story.lines) >= 8) {
                try {
                    setStatus("……語りを、研ぎ澄ましています……", "tuning");
                    const raw2 = await callGemini(apiKey, buildRefinePrompt(raw, anchors, { weather }), chosenModel);
                    const story2 = parseGenerated(raw2, anchors);
                    if (/\[STORY\]/.test(raw2) && textCount(story2.lines) >= 20) {
                        draftLines = sanitizeStoryLines(story.lines).lines;   // 比較用に初稿も残す
                        if (!story2.ambience) story2.ambience = story.ambience;
                        if (!story2.title) story2.title = story.title;
                        story = story2;
                        refined = true;
                        Logger.info("推敲", `採用(初稿${textCount(draftLines)}行→改稿${textCount(story2.lines)}行)`);
                    } else {
                        Logger.warn("推敲", "改稿が形式外/短すぎ→初稿を採用");
                    }
                } catch (e) {
                    Logger.warn("推敲に失敗→初稿を採用", String(e.message).slice(0, 160));
                }
            }
            // 生成後の安全検品: 特定情報(番地・連絡先)や他言語混入を伏せる(最後の砦)
            const safe = sanitizeStoryLines(story.lines);
            story.lines = safe.lines;
            if (safe.flags.length) {
                Logger.warn(`安全検品: ${safe.flags.length}件を伏せ/除去`,
                    safe.flags.map(f => `${f.type}「${f.original}」`).join(" / "));
            }
            // 音タグの検品: 本文に書かれていない音は外し、無音の場面には無音を足す(2026-10)
            const vs = validateSoundTags(story.lines);
            story.lines = vs.lines;
            if (vs.flags.length) {
                Logger.info(`音タグの検品: ${vs.flags.length}件`, vs.flags.map(f => `${f.type}:${f.tag || ""}「${f.line}」`).join(" / "));
            }
            // 演出タグを雰囲気優先で間引く(合計2〜3個・冒頭末尾なし・強い演出は1回)
            const capped = capGimmicks(story.lines, { maxTotal: 3 });
            story.lines = capped.lines;
            if (capped.flags.length) {
                Logger.warn(`演出を間引き: ${capped.flags.length}件`,
                    capped.flags.map(f => `${f.type}:${f.tag}`).join(" / "));
            }
            const textLineCount = story.lines.filter(l => l && !l.startsWith("[")).length;
            Logger.info("パース完了", { textLines: textLineCount, credits: story.credits.length, title: story.title });
            if (textLineCount < 8) {
                throw new Error(`生成結果が短すぎました(本文${textLineCount}行)。もう一度お試しください。`);
            }

            // 4. 保存(地図のピンになる)
            const pin = {
                id: "pin_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                createdAt: new Date().toISOString(),
                model: chosenModel || "auto",
                skeleton: built.skeleton,   // 使った話の骨格(評価集計で弱い骨格を炙り出す)
                rating: 0,                  // 読者の星評価(0=未評価, 1〜5)
                // 評価集計用(改善のため): 主な錨=スポット名/出典 と エリア名。生GPSは集計に送らない(プライバシー)。
                spotName: (anchors[0] && (anchors[0].title || anchors[0].source)) || "",
                area: (anchors[0] && anchors[0].areaLabel) || geo.town || "",
                lat, lon,
                placeName: geo.town || geo.address || "名前のない場所",
                prefecture: geo.prefecture || "",   // 都道府県(2026-10。地図の一覧の絞り込み・並び替え用)
                title: story.title || (geo.town || "この場所") + "の話",
                tags: story.tags,
                duration: "約3分",
                lines: story.lines,
                ambience: story.ambience,   // 舞台の環境音(2026-10)。空なら読む画面で本文から推定
                weather: weather || "",     // 生成時の空模様(2026-10)
                refined,                    // 推敲を通したか(2026-10)
                draftLines,                 // 推敲前の初稿(比較用。推敲しなかった場合は null)
                credits: story.credits,
                creditsNote: story.creditsNote,
                shareText: story.shareText
            };
            await ImakokoDB.savePin(pin);
            Logger.info("保存完了", { id: pin.id, place: pin.placeName });

            // 5. ビューアへ
            setStatus("……つながりました。", "done");
            setTimeout(() => { location.href = `./viewer.html?pin=${encodeURIComponent(pin.id)}`; }, 800);
        } catch (e) {
            console.error(e);
            Logger.error("パイプライン失敗", {
                name: e.name, code: e.code, status: e.status,
                message: String(e.message || e).slice(0, 300)
            });
            if (e.stack) Logger.error("stack", String(e.stack).split("\n").slice(0, 4).join(" ← "));
            let msg = geoErrorMessage(e) || ("失敗しました: " + (e.message || e));
            // 全部の通信が失敗した(=ネット接続なし/通信禁止の画面)なら、原因と対処を分かりやすく
            if (/Failed to fetch|NetworkError|Load failed/i.test(String(e.message || e))) {
                msg = isWebOrigin
                    ? "通信できませんでした。インターネット接続を確認して、もう一度お試しください。"
                    : "この画面では通信できないため、怪談を生成できません。" + OPEN_IN_BROWSER;
            }
            if (e.code === 3 || e.code === 2) {
                msg += " 端末の位置情報が使えない場合は、設定欄で座標を手動入力できます。";
                document.getElementById("settings").open = true;
            }
            setStatus(msg, "error");
            document.getElementById("log-panel").open = true; // 失敗時はログを自動展開
            btn.disabled = false;
        }
    });

    // 集めた怪談の数を表示
    ImakokoDB.getAllPins().then(pins => {
        if (pins.length) {
            document.getElementById("pin-count").textContent = `あなたによって産まれた怪談 ── ${pins.length}話`;
        }
    }).catch(() => { /* noop */ });
});

// Node(サンプル生成ハーネス)から関数を再利用するためのexport。ブラウザでは無害。
if (typeof module !== "undefined" && module.exports) {
    module.exports = { validateSoundTags, buildPrompt, pickVariety, skeletonWeights, seasonOf, buildRefinePrompt, timeBand, distanceLabel, callGemini, parseGenerated, sanitizeStoryLines, capGimmicks };
}
