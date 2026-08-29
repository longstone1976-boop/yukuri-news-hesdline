# yukkuri-news-collector

ゆっくりNEWS 仕様書「3. 記事収集ロジック」を実装した、**実際にRSSを取得してキュレーションする**Pythonプログラムです。ChatGPT/Gemini等の外部AI要約APIは使用していません（要約は非AIの文字数短縮で代替しています）。

## 使い方

```bash
pip install -r requirements.txt

# 実際にネットからRSSを取得して収集する
python3 collect_news.py

# 出力先や収集条件を変える場合
python3 collect_news.py --output out.json --hours 24 --per-site-limit 20

# ネットに繋がない状態で動作確認したい場合（本物の記事データを使ったテスト用フィクスチャ同梱）
python3 collect_news.py --fixture-dir ./fixtures --now 2026-08-29T16:18:00+09:00
```

実行すると `curated_articles.json`（記事一覧）が生成され、件数や短縮件数がコンソールに表示されます。`examples/sample_output.json` に、上記フィクスチャを使って実際に生成した出力サンプル（実データ30件）を同梱しています。

## 収集対象サイト（実在の公開RSS、動作確認済み）

| カテゴリ | サイト | フィードURL |
|---|---|---|
| 経済 | 東洋経済オンライン | https://toyokeizai.net/list/feed/rss |
| IT | ITmedia | https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml |
| 暮らし | ライフハッカー・ジャパン | https://www.lifehacker.jp/feed/index.xml |
| スポーツ | Full-Count | https://full-count.jp/feed/ |
| エンタメ | 映画.com | https://feeds.eiga.com/eiga_news |
| 国際 | Japan Today（英語） | https://japantoday.com/feed |

サイトの追加・削除は `collect_news.py` 冒頭の `SITES` リストを編集するだけです。

## 仕様との対応

| 仕様項目 | 実装内容 |
|---|---|
| 2.1 時刻の扱い | 取得した全時刻を日本時間(Asia/Tokyo, UTC+9)に変換して統一的に扱う |
| 2.2 見出し25文字ルール | 25文字を超える見出しは短縮する |
| 2.3 要約AI連携 | **不使用**。代わりに句読点・カギ括弧の位置を優先した非AIの文字数短縮を行う（`shorten_text()`）。概要が取得できない記事は元タイトルをそのまま概要として扱う（仕様の「AI要約失敗時」に相当する経路） |
| 3.1 収集タイミング | 本スクリプト自体は常駐しません。1日3回(6:00/11:55/16:00 JST)起動したい場合は、お使いの環境のcron等で本スクリプトを3回叩いてください（下記参照） |
| 3.2 収集対象の記事範囲 | 実行時刻から遡って24時間以内・サイトごとに最新20件まで（`--hours` / `--per-site-limit` で変更可） |

## 自動化したい場合（参考・任意）

ご自身のサーバーやPCのcronに以下のように登録すると、仕様通り1日3回収集できます（JST）。

```cron
0 6 * * *    cd /path/to/yukkuri-news-collector && python3 collect_news.py
55 11 * * *  cd /path/to/yukkuri-news-collector && python3 collect_news.py
0 16 * * *   cd /path/to/yukkuri-news-collector && python3 collect_news.py
```

## 制限事項（正直な注意点）

- **AI要約は行っていません。** 見出し・概要の短縮は単純な文字数トリミングです。将来ChatGPT等のAPIを使う場合は `shorten_text()` の呼び出し箇所を差し替えてください。
- サムネイル画像の取得は行っていません（`<enclosure>` や `<media:thumbnail>` があれば拡張可能です）。
- このプログラムは**インターネットに接続できる通常の環境**（お使いのPC・サーバー等）で実行してください。RSS取得元サイトへの直接アクセスが制限された環境（一部のサンドボックス環境など）では動作しません。
- `fixtures/` フォルダのXMLは、2026-08-29に各サイトの公開RSSから実際に取得した本物の見出し・リンク・概要をそのまま保存したテスト用データです（`--fixture-dir` 指定時のみ使用、ネット不要）。日々の実運用では使いません。

## リポジトリ構成

```
collect_news.py         本体プログラム
requirements.txt        依存パッケージ（feedparser）
fixtures/                オフライン動作確認用の実データテストフィクスチャ一式
examples/sample_output.json  上記フィクスチャで生成した出力サンプル
LICENSE                  MIT License
```
