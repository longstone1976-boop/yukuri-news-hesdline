-- ゆっくりNEWS：収集と要約のためのテーブル（仕様書 3章・2.3・5.2・8.4 に対応）

CREATE TABLE IF NOT EXISTS sites (
  site_id      SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  feed_url     TEXT NOT NULL UNIQUE,          -- 同じURLは1件（8.4）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collections (
  collection_id SERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,                   -- 「最新記事の取得日時」
  status        TEXT NOT NULL DEFAULT 'running', -- running / done / failed
  note          TEXT
);

CREATE TABLE IF NOT EXISTS articles (
  article_id          SERIAL PRIMARY KEY,
  url                 TEXT NOT NULL UNIQUE,     -- 収集済みなら要約・サムネイルを取り直さない（3.2）
  site_id             INTEGER REFERENCES sites(site_id) ON DELETE SET NULL,
  title               TEXT NOT NULL,            -- 25文字以内の見出し（2.2）
  title_original      TEXT NOT NULL,
  summary             TEXT NOT NULL,            -- 250文字以内の概要、または代わりの説明文（2.3）
  summary_status      TEXT NOT NULL,            -- done / pending（要約未完了）/ final（確定）
  summary_retry       INTEGER NOT NULL DEFAULT 0,
  summary_source      TEXT,                     -- ai / raw / description / og / none
  source_text         TEXT,                     -- 再要約用の元文章。要約完了・確定で消す
  rss_description     TEXT,
  og_description      TEXT,
  thumbnail_url       TEXT,                     -- なければ NULL（No Image）
  posted_at           TIMESTAMPTZ NOT NULL,     -- 取れなければ収集時刻（3.2）
  posted_at_estimated BOOLEAN NOT NULL DEFAULT false,
  collected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_listed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS articles_pending_idx ON articles (summary_status) WHERE summary_status = 'pending';

CREATE TABLE IF NOT EXISTS feed_items (
  collection_id INTEGER NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  article_id    INTEGER NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, position)
);

-- 見出しも再要約の対象にする（2.3）。既存の表に列を追加
ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_status TEXT NOT NULL DEFAULT 'done'; -- done / pending / final
ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_retry INTEGER NOT NULL DEFAULT 0;
-- 列を追加する前に「先頭24文字＋…」で保存された見出しを、再要約の対象にする
UPDATE articles SET title_status = 'pending'
 WHERE title_status = 'done' AND title_retry = 0 AND char_length(title_original) > 25 AND title LIKE '%…';
