/*
 * イマココ怪談 — 公開時の設定
 * 評価(星)を集約する受け口のURLをここに貼る。空のままなら送信しない(ローカルのみ)。
 *
 * 設定手順は ../評価集約_セットアップ.md を参照:
 *   1. Googleスプレッドシートを作る → 拡張機能 → Apps Script に rating_collector.gs を貼る
 *   2. デプロイ → ウェブアプリ（アクセス: 全員）→ 発行されたURLを下の ratingEndpoint に貼る
 * 送るのは「骨格・星・時刻・スポット名・エリア名」だけ。生のGPS座標や個人情報は送らない。
 */
window.IMAKOKO_CONFIG = {
    ratingEndpoint: "https://script.google.com/macros/s/AKfycbx5lEt0iv2PmRZ78Ikde6ptsjnMDEbQV9OPokcf8FtpEMAvhhjEmvudNPTjZGwQ6HPC5A/exec",
    // 語り手「聞き集める者」の声（2026-10-07 ボイスデザインで作成・採用＝「穏やかに語りかける男性」）。
    // ※ このIDは作成に使ったAPIキーのGoogleプロジェクトでしか使えない。公開時はプロキシ側の同じプロジェクトで使う。
    // ※ 保存期限は作成から1年（2027-10頃）。期限前に作り直すか、本人の声(Voice replication)に差し替える。
    narratorVoice: "voice_3sqhl84m3scv",
    narratorTtsModel: "gemini-3.8-flash-tts"
};
