/**
 * イマココ怪談 — 端末ごとの設定（localStorageに保存）
 *
 * voiceEnabled: 語り手の声で読み上げるか。初期値 OFF。
 *   OFF のあいだは、読み上げ音声(TTS)の生成リクエストを一切送らない＝料金も発生しない。
 *   読み上げ機能を実装するときは、生成の直前に必ず ImakokoSettings.voiceEnabled() を確認すること。
 * scareLevel: 演出の強さ。"mild"(控えめ) / "standard"(標準) / "intense"(強め)。
 *   2026-10: 利用者の設定はやめ、お話ごとに決める（生成時にAIが判定して pin.fear に保存。
 *   無い古い話は estimateFear で本文から推定）。読む画面が setStoryLevel() で入れる。
 *   端末の「視差効果を減らす(prefers-reduced-motion)」がONなら常に控えめ（点滅・揺れを出さない）。
 */
window.ImakokoSettings = (() => {
    const VOICE_KEY = "imakoko_voice_enabled";
    function voiceEnabled() {
        try { return localStorage.getItem(VOICE_KEY) === "1"; } catch (e) { return false; }
    }
    function setVoiceEnabled(on) {
        try { localStorage.setItem(VOICE_KEY, on ? "1" : "0"); } catch (e) { /* 保存できなくてもOFF扱い */ }
    }
    const LEVELS = ["mild", "standard", "intense"];
    let storyLevel = "standard";
    const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    function scareLevel() { return reduceMotion() ? "mild" : storyLevel; }
    function setStoryLevel(v) { if (LEVELS.includes(v)) storyLevel = v; }
    /** 本文から演出の強さを推定（AIの判定が無い古い話・判定が壊れていた時の補い） */
    function estimateFear(lines) {
        const ls = (lines || []).map(String);
        let score = 0;
        for (const l of ls) {
            if (/^\[SOUND:(?!SILENCE)/.test(l)) score += 1;
            if (/^\[VISUAL:(BLACKOUT|BLINK|FLASH|SHAKE|GHOST)\]/.test(l)) score += 2;
            if (!l.startsWith("[")) score += Math.min(2, (l.match(/血|死体|首|悲鳴|叫|目が合|顔が|すぐ後ろ|耳元|掴ま|つかま|引きずり|追いかけ|逃げ/g) || []).length);
        }
        return score <= 3 ? "mild" : score <= 8 ? "standard" : "intense";
    }
    const SCARE_LABEL = { mild: "静か", standard: "標準", intense: "強め" };
    // 推敲(2026-10): 初稿を編集者AIが怖さの観点で書き直す。初期値 ON（+約1.3円・+約20秒）
    const REFINE_KEY = "imakoko_refine";
    function refineEnabled() {
        try { return localStorage.getItem(REFINE_KEY) !== "0"; } catch (e) { return true; }
    }
    function setRefineEnabled(on) {
        try { localStorage.setItem(REFINE_KEY, on ? "1" : "0"); } catch (e) { /* noop */ }
    }
    return { voiceEnabled, setVoiceEnabled, scareLevel, setStoryLevel, estimateFear, LEVELS, SCARE_LABEL, refineEnabled, setRefineEnabled };
})();
