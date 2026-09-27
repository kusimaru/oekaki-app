# お絵かきツール (oekaki-app) — 作業ルール

## 作業を始める前に必ず最新にそろえる
複数の会話・複数の場所で開発しているため、手元が GitHub より古いことがある。
古い版をもとに作業して push すると、その間の更新が消える。

1. `git fetch` → `git status -sb` で `behind` が無いことを確認する。
2. 遅れていれば、手元に変更が無いうちに `git pull --ff-only` で取り込んでから作業を始める。
3. 手元に未コミットの変更があって遅れている場合は、上書きせずに利用者に確認する。

## 公開（push）の前にも確認する
- `npm run build`（型チェック込み）が通ることを確かめる。
- push 直前にもう一度 `git fetch` し、GitHub の方が進んでいたら、統合してビルドをやり直してから push する。
- `git push --force` は使わない。

## このアプリの決まりごと
- TypeScript + Vite（フレームワークなし）。`main` に push すると GitHub Actions がビルドして GitHub Pages に出る。
- ビルドごとに `version.json` が作られ、アプリは公開先と比べて更新を促す（`vite.config.ts`）。

## 他のアプリとの連携（壊さないこと）
「余白ノートへ送る」（`src/main.ts` の `sendToYohaku`）は、余白ノートの「データ受け取り」と対になっている。
次のどれかを変えるときは、余白ノート側（`app.mjs` の受け取り処理）も合わせて直す。
- 共有 IndexedDB: データベース `oekaki-share`（版 1）、ストア `inbox`（keyPath `id`）、
  中身 `{id, name, src: PNG の data URL, width, height, createdAt}`
- クリップボード: `image/png` と、`text/plain` の印 `oekaki-tool:<名前>`
- GitHub: 設定したリポジトリの `_yohaku-inbox/<時刻>-<名前>.png`（余白ノートが取り込んだら削除する）

## 同じアプリを複数の会話で同時に編集しない
並行して作業すると、互いの変更を上書きしやすい。
