/**
 * イマココ怪談 — 効果音と本文の「手がかり」辞書（2026-10）
 *
 * 効果音は、本文がその音を書いているときにだけ鳴らす（関係ない音で脅かすと、意図が透けて冷める）。
 *  - match(tag, text): その行（と直前の行）に、タグの音を示す言葉・擬音があるか。あれば位置も返す
 *  - isHush(text):     「しん、と静まり返る」のような無音の場面か（→環境音をピタッと止める）
 *  - count(tag, text): 擬音の回数（「コツッ、コツッ、コツッ」→3）。足音の歩数に使う
 * generate.js（生成時の検品）と viewer.js（読む画面・古い話にも適用）の両方で使う。
 */
(function (root) {
    "use strict";
    // 擬音（カタカナ・ひらがな）と、音そのものを書いた言葉
    const CUES = {
        "[SOUND:KNOCK]":     /コンコン|コン、|ゴンゴン|トントン|トン、|ドンドン|コツコツと(戸|扉|窓|ドア)|ノック|叩く音|叩いた|叩かれ|戸を叩|扉を叩|窓を叩|こん、こん|とん、とん/,
        "[SOUND:FOOTSTEP]":  /コツ|カツ|カツン|コツン|ヒタ|ひた、|ひたひた|ペタ|ぺた|ザッ|じゃり|ジャリ|足音|靴音|歩く音|跫音|ぎし、ぎし/,
        "[SOUND:THUMP]":     /ドン|ドサ|どさ|ドスン|どすん|ゴトン|ごとん|ゴトッ|ごとり|ゴロン|ばたん|バタン|ドタ|落ちる音|落ちた音|倒れる音|倒れた音|重い音|鈍い音/,
        "[SOUND:HEARTBEAT]": /鼓動|心臓|ドクン|どくん|ドクドク|どくどく|脈|胸の音/,
        "[SOUND:STATIC]":    /ザー|ザザ|ざあ|砂嵐|ノイズ|雑音|ジジ|ジー/,
        "[SOUND:RINGING]":   /耳鳴り|キーン|きいん|耳の奥/,
        "[SOUND:VOICE]":     /囁|ささや|ぼそ|声がし|声が聞こ|声が、|呼ぶ声|名を呼|名前を呼|呼ばれ|声だけ|話し声|呟/,
        "[SOUND:RAIN]":      /雨脚|雨が強|雨音|ざあっと|ザアッ|土砂降り|雨が叩|降り出し|雨粒が/,
        "[SOUND:DOOR]":      /ギィ|ぎい|ギイ|キィ|きい、|軋|きしむ|きしみ|戸が開|扉が開|ドアが開|戸が閉|扉が閉|ドアが閉|開く音|閉まる音/,
        "[SOUND:PHONE]":     /着信|呼び出し音|電話が鳴|電話の音|ベルが鳴|プルル|リリリ|ジリリ|スマホが震|携帯が震|バイブ/,
        "[SOUND:CHILD]":     /笑い声|笑う声|くすくす|クスクス|けらけら|ケラケラ|ふふ|うふ|あはは|笑った|笑っていた|笑い/,
        "[SOUND:CROSSING]":  /踏切|カンカン|かんかん|警報/,
        "[SOUND:SCRATCH]":   /擦る|擦れ|こする|こすれ|かさ、|カサ|ガリ|がり|カリカリ|かりかり|ひっか|引っか|引っ掻|掻く|掻い|爪を立て|爪で/,
        "[SOUND:BREATH]":    /息が|息を|吐息|息づかい|息遣い|呼吸|はあ、|はぁ|ふう、|生暖かい息|息がかか/,
        "[SOUND:WATER]":     /ぽた|ポタ|ぴちゃ|ピチャ|ぴちょ|滴|しずく|雫|水音|水の落ちる/,
        "[SOUND:SILENCE]":   /しん、|しん…|しんと|しん——|静まり返|静まりかえ|静寂|無音|音が消え|音が止|音が途切れ|音が絶え|何の音もし|物音ひとつ|物音一つ|虫の声が止|風が止/
    };
    const HUSH = CUES["[SOUND:SILENCE]"];
    // 回数を数える擬音（足音・ノック）
    const COUNTERS = {
        "[SOUND:FOOTSTEP]": /コツ|カツ|ヒタ|ひた|ペタ|ぺた|ザッ|ジャリ|じゃり/g,
        "[SOUND:KNOCK]":    /コン|ゴン|トン|ドン|こん|とん/g
    };

    /** タグの音が本文に書かれているか。{ ok, pos(0〜1: 行の中での位置) } */
    function match(tag, text, prevText) {
        const re = CUES[tag];
        if (!re) return { ok: true, pos: 0 };            // 辞書に無いタグ(視覚演出など)は通す
        const t = String(text || "");
        const m = re.exec(t);
        if (m) return { ok: true, pos: t.length ? m.index / t.length : 0 };
        if (prevText && re.test(String(prevText))) return { ok: true, pos: 0 };   // 直前の行に書いてあるなら行頭で
        return { ok: false, pos: 0 };
    }
    function isHush(text) { return HUSH.test(String(text || "")); }
    function count(tag, text) {
        const re = COUNTERS[tag];
        if (!re) return 0;
        return (String(text || "").match(re) || []).length;
    }
    const api = { match, isHush, count, CUES };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.ImakokoCues = api;
})(typeof window !== "undefined" ? window : globalThis);
