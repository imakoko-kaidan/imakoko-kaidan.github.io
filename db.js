/**
 * イマココ怪談 - 永続化層
 * IndexedDB に「聞いた怪談(ピン)」を保存する。
 *
 * キャッシュクリア対策(三段構え):
 *   1. IndexedDB(localStorageより堅牢・大容量)
 *   2. navigator.storage.persist() で永続ストレージを要求(ブラウザの自動削除を防ぐ)
 *   3. エクスポート/インポート(JSONファイル) — ユーザー操作による消去にも耐える唯一の確実な手段
 *
 * ピンの形式:
 *   { id, createdAt, lat, lon, placeName, tags[], duration,
 *     lines[], credits[], creditsNote, shareText }
 */
const ImakokoDB = (() => {
    const DB_NAME = "imakoko_kaidan";
    const STORE = "pins";
    // 読み上げ音声のキャッシュは「別のデータベース」に保存する。
    // 本体(imakoko_kaidan)のバージョンを上げると、旧版のタブが開いている間アップグレードが止まり、
    // 話が表示されなくなる(BUGLOG #18)。別DBならその心配がない。キー="<話のID>|<声ID>|<行番号>"、値=WAVのBlob
    const AUDIO_DB = "imakoko_audio";
    const AUDIO = "audio";
    let dbPromise = null;
    let audioDbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            // バージョン番号を指定しない＝今あるバージョンのまま開く(新規ならv1で作成)。
            // 過去に一瞬だけv2へ上げる版(v0.131)があったため、v1/v2どちらでも開けるようにしておく
            const req = indexedDB.open(DB_NAME);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const st = db.createObjectStore(STORE, { keyPath: "id" });
                    st.createIndex("createdAt", "createdAt");
                }
            };
            req.onsuccess = () => {
                const db = req.result;
                db.onversionchange = () => db.close();   // 将来のアップグレードを他タブが止めないように
                resolve(db);
            };
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    /** ブラウザに永続ストレージを要求(初回保存時に呼ぶ) */
    async function requestPersist() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                const already = await navigator.storage.persisted();
                if (already) return true;
                return await navigator.storage.persist();
            }
        } catch (e) { /* 非対応ブラウザは黙って続行 */ }
        return false;
    }

    function openAudio() {
        if (audioDbPromise) return audioDbPromise;
        audioDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(AUDIO_DB);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
            };
            req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
            req.onerror = () => reject(req.error);
        });
        return audioDbPromise;
    }
    /** 音声キャッシュの削除(prefix指定で1話ぶん / 省略で全部)。失敗しても本体の処理は止めない */
    async function clearAudio(prefix) {
        try {
            const db = await openAudio();
            await new Promise((resolve) => {
                const t = db.transaction(AUDIO, "readwrite");
                const os = t.objectStore(AUDIO);
                if (prefix) os.delete(IDBKeyRange.bound(prefix + "|", prefix + "|\uffff")); else os.clear();
                t.oncomplete = resolve; t.onerror = resolve;
            });
        } catch (e) { /* noop */ }
    }

    /**
     * 語りの声のキャッシュを「最近聞いた15話ぶん」に保つ（1話 約9MB。放っておくと端末を圧迫するため）。
     * 読み上げを始めるたびに呼ぶ。古い話の声は消えるが、もう一度聞けば作り直す（そのときだけ料金が発生）。
     */
    const AUDIO_LRU = "imakoko_audio_lru", AUDIO_KEEP = 15;
    function touchAudioStory(id) {
        if (!id) return;
        try {
            let list = JSON.parse(localStorage.getItem(AUDIO_LRU) || "[]").filter(x => x !== id);
            list.unshift(id);
            const drop = list.slice(AUDIO_KEEP);
            list = list.slice(0, AUDIO_KEEP);
            localStorage.setItem(AUDIO_LRU, JSON.stringify(list));
            drop.forEach(old => clearAudio(old));
        } catch (e) { /* noop */ }
    }

    function tx(db, mode) {
        return db.transaction(STORE, mode).objectStore(STORE);
    }

    async function savePin(pin) {
        const db = await open();
        await requestPersist();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, "readwrite");
            t.objectStore(STORE).put(pin);
            t.oncomplete = () => resolve(pin.id);
            t.onerror = () => reject(t.error);
        });
    }

    async function getPin(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const req = tx(db, "readonly").get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function getAllPins() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const req = tx(db, "readonly").getAll();
            req.onsuccess = () => {
                const pins = req.result || [];
                pins.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
                resolve(pins);
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** ピンの星評価(1〜5)を保存。怪談の良し悪し＝骨格の評価集計に使う。 */
    async function setRating(id, rating) {
        const pin = await getPin(id);
        if (!pin) return null;
        pin.rating = rating;
        pin.ratedAt = new Date().toISOString();
        await savePin(pin);
        return pin;
    }

    /** すべてのピンを削除する(全消去)。元に戻せないので、呼ぶ側で必ず確認＆バックアップを取る。 */
    async function clearAll() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, "readwrite");
            t.objectStore(STORE).clear();
            t.oncomplete = () => { clearAudio(); resolve(); };   // 音声キャッシュも一緒に消す
            t.onerror = () => reject(t.error);
        });
    }

    async function deletePin(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction(STORE, "readwrite");
            t.objectStore(STORE).delete(id);
            t.oncomplete = () => { clearAudio(id); resolve(); };   // その話の音声キャッシュも削除
            t.onerror = () => reject(t.error);
        });
    }

    /**
     * 古いピンのメタ補完(非破壊マイグレーション)。
     * skeleton/spotName/area フィールド導入前のピンは、評価送信時にこれらが空になり、
     * 集計が「(記録なし)」へ流れてしまう。復元できる範囲だけ、空欄のときに限り埋める:
     *   - area が空 → placeName(町名)で補う(エリア別集計が効くようになる)
     * skeleton は生成時の選択であり後から復元できないので触らない(嘘の事実を作らない=思想)。
     * spotName も元の錨タイトルが保存されておらず正確に復元できないため、推測で埋めない。
     * 既存の値は決して上書きしない。アプリのバージョンごとに一度だけ実行する。
     * @returns {number} 補完したピン数
     */
    async function backfillPinMeta(appVersion) {
        try {
            const KEY = "imakoko_backfill_done";
            if (appVersion && localStorage.getItem(KEY) === String(appVersion)) return 0;
            const pins = await getAllPins();
            let updated = 0;
            for (const pin of pins) {
                let changed = false;
                if ((pin.area == null || pin.area === "") && pin.placeName) {
                    pin.area = pin.placeName;
                    changed = true;
                }
                if (changed) { await savePin(pin); updated++; }
            }
            if (appVersion) localStorage.setItem(KEY, String(appVersion));
            return updated;
        } catch (e) {
            // マイグレーション失敗はアプリ本体を止めない
            return 0;
        }
    }

    /** 全ピンをJSONファイルとしてダウンロード(バックアップ) */
    async function exportAll() {
        const pins = await getAllPins();
        const payload = {
            app: "imakoko_kaidan",
            version: 1,
            exportedAt: new Date().toISOString(),
            count: pins.length,
            pins
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        const d = new Date();
        a.download = `imakoko_kaidan_backup_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        return pins.length;
    }

    /** バックアップJSONを読み込んでマージ(同IDは新しい方を残す) */
    async function importFile(file) {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.app !== "imakoko_kaidan" || !Array.isArray(data.pins)) {
            throw new Error("イマココ怪談のバックアップファイルではありません。");
        }
        let imported = 0;
        for (const pin of data.pins) {
            if (!pin.id || !Array.isArray(pin.lines)) continue;
            const existing = await getPin(pin.id);
            if (!existing || (pin.createdAt || "") > (existing.createdAt || "")) {
                await savePin(pin);
                imported++;
            }
        }
        return imported;
    }

    /** 読み上げ音声キャッシュ: 取得(無ければnull) */
    async function getAudio(key) {
        const db = await openAudio();
        return new Promise((resolve, reject) => {
            const req = db.transaction(AUDIO, "readonly").objectStore(AUDIO).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }
    /** 読み上げ音声キャッシュ: 保存 */
    async function putAudio(key, blob) {
        const db = await openAudio();
        return new Promise((resolve, reject) => {
            const t = db.transaction(AUDIO, "readwrite");
            t.objectStore(AUDIO).put(blob, key);
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        });
    }

    return { savePin, getPin, getAllPins, deletePin, clearAll, setRating, exportAll, importFile, requestPersist, backfillPinMeta, getAudio, putAudio, touchAudioStory };
})();
