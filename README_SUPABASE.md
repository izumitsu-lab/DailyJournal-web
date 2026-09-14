# Daily Journal - Supabase 差分同期版

## できること

- ローカル保存は従来どおり IndexedDB / localStorage
- Supabase Auth でメールアドレス＋パスワードのログイン / アカウント作成
- Journal は **1記録 = 1 PostgreSQL row**
- Notebook は **1ノート = 1 PostgreSQL row**
- 設定は小さな1 rowとして保存
- 画像は PostgreSQL に詰め込まず、Supabase Storageへ個別保存
- 初回だけ既存データを全量移行
- 初回以降は変更・追加・削除された行だけを同期
- 別端末では約20秒ごとに差分確認
- ローカルのデータはクラウド接続後も保持
- service_role / secret key は使用しない

## 初回セットアップ

1. Supabase DashboardでProjectを作る。
2. SQL Editorで `supabase_setup.sql` を1回実行する。
3. Authentication > Providers で Email を有効にする。
4. Email確認を有効にする場合、公開URLを Auth の Redirect URLs に登録する。
5. GitHub PagesなどのHTTPS上で `index.html` を公開する。
6. アプリの「設定 → クラウド」で Project URL と Publishable key（旧anon key）を入力する。
7. 「アカウント作成」または「ログイン」を実行する。

## 通信量

通常の編集では `journalData` 全体や `notebookData` 全体を送信しません。

例:

- Journalを1件追加 → その1行だけ
- Journalを1件編集 → その1行だけ
- Notebookを1件編集 → その1行だけ
- 写真を1枚追加 → その画像だけ
- 別端末の確認 → 前回同期時刻以降に変更されたrowだけ

削除はDB側に小さなtombstone（deleted_at）を残し、他端末へ削除を伝えます。

## 初回だけ全量になる理由

端末側に100MBの既存データがある場合、その100MBをSupabaseへ初回移行する必要があります。
一度移行して同期メタデータができた後は、変更分だけを通信します。

## file:// について

ローカル保存だけなら `file://` でも動作しますが、Supabase Authのメール確認・パスワード再設定などはHTTPSで配信することを推奨します。
GitHub Pagesなどで公開してください。

## セキュリティ

ブラウザにはProject URLとPublishable/anon keyだけを設定します。
`service_role` や `sb_secret_...` などの秘密鍵は絶対にHTML/JS/GitHubへ入れないでください。
DBとStorageはRLSでログイン中の自分のユーザーIDだけを許可するようにしています。
