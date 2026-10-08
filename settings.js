/**
 * イマココ怪談 — 端末ごとの設定（localStorageに保存）
 *
 * voiceEnabled: 語り手の声で読み上げるか。初期値 OFF。
 *   OFF のあいだは、読み上げ音声(TTS)の生成リクエストを一切送らない＝料金も発生しない。
 *   読み上げ機能を実装するときは、生成の直前に必ず ImakokoSettings.voiceEnabled() を確認すること。
 * scareLevel: 怖さ。"mild"(控えめ) / "standard"(標準・初期値) / "intense"(本気)。
 *   控えめ＝激しい点滅・暗転の明滅・画面の揺れを出さず、一瞬の恐怖演出も少なめ（光に敏感な人向けでもある）。
 *   端末の「視差効果を減らす(prefers-reduced-motion)」がONなら、未設定時は控えめにする。
 */
window.ImakokoSettings = (() => {
    const VOICE_KEY = "imakoko_voice_enabled";
    function voiceEnabled() {
        try { return localStorage.getItem(VOICE_KEY) === "1"; } catch (e) { return false; }
    }
    function setVoiceEnabled(on) {
        try { localStorage.setItem(VOICE_KEY, on ? "1" : "0"); } catch (e) { /* 保存できなくてもOFF扱い */ }
    }
    const SCARE_KEY = "imakoko_scare_level";
    const LEVELS = ["mild", "standard", "intense"];
    function scareLevel() {
        try {
            const v = localStorage.getItem(SCARE_KEY);
            if (LEVELS.includes(v)) return v;
        } catch (e) { /* noop */ }
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        return reduce ? "mild" : "standard";
    }
    function setScareLevel(v) {
        try { if (LEVELS.includes(v)) localStorage.setItem(SCARE_KEY, v); } catch (e) { /* noop */ }
    }
    const SCARE_LABEL = { mild: "控えめ", standard: "標準", intense: "本気" };
    // 推敲(2026-10): 初稿を編集者AIが怖さの観点で書き直す。初期値 ON（+約1.3円・+約20秒）
    const REFINE_KEY = "imakoko_refine";
    function refineEnabled() {
        try { return localStorage.getItem(REFINE_KEY) !== "0"; } catch (e) { return true; }
    }
    function setRefineEnabled(on) {
        try { localStorage.setItem(REFINE_KEY, on ? "1" : "0"); } catch (e) { /* noop */ }
    }
    return { voiceEnabled, setVoiceEnabled, scareLevel, setScareLevel, SCARE_LABEL, refineEnabled, setRefineEnabled };
})();
