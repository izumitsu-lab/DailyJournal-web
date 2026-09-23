# Daily Journal テスト

実際のブラウザ（Chromium）でアプリを開き、偽の Supabase サーバーに複数の「端末」をつないで確認します。
本物の Supabase には接続しません。

## 実行方法

```bash
cd tests
npm install
npx playwright install chromium   # 初回のみ
npm test
```

## 内容

- `test-sync.js` … 同期（オフライン編集・削除の伝播・競合・新端末・スキーマ未更新時の停止・画像）
- `test-ui.js` … XSS対策、PCサイドバーの再表示、スマホ用CSS、旧形式データの移行
- `test-round2.js` … 空ノートのキャンセル、月表示、Ctrl/Cmd判定、タイプ復活、バックアップ書き出し、
  カードビューの描画削減、ノート編集中の競合
- `test-round3.js` … クラウドの不要画像の掃除（使用中・猶予期間中は残す、他端末の再アップロード、画像欠損時も同期継続）、
  複数タブ（後から開いたタブだけが保存し、前のタブは上書きしない）
- `harness.js` / `fake-supabase.js` … テスト用の偽サーバー（timestamptz は Postgres と同じ形式で返す）
