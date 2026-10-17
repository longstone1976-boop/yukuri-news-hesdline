-- ゆっくりNEWS のテーブル（仕様書 2.3・3章・5.2・8章・9章 に対応）
-- 起動のたびに実行される。何度実行しても同じ結果になるように書く

CREATE TABLE IF NOT EXISTS sites (
  site_id      SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  feed_url     TEXT NOT NULL UNIQUE,          -- 同じURLは全ユーザー共通で1件。収集も1回（3.2）
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

-- 見出しも再要約の対象にする（2.3）
ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_status TEXT NOT NULL DEFAULT 'done'; -- done / pending / final
ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_retry INTEGER NOT NULL DEFAULT 0;
UPDATE articles SET title_status = 'pending'
 WHERE title_status = 'done' AND title_retry = 0 AND char_length(title_original) > 25 AND title LIKE '%…';

-- ===== 会員（8章・9章） =====
CREATE TABLE IF NOT EXISTS users (
  user_id         TEXT COLLATE "C" PRIMARY KEY,   -- 西暦4桁＋ランダム8文字。大文字と小文字を区別（8.1）
  email           TEXT UNIQUE,                    -- ログインID。退会時に NULL にして解放（9.6）
  password_hash   TEXT,                           -- scrypt でハッシュ化（8.2）
  status          TEXT NOT NULL DEFAULT 'active', -- active / withdrawn
  session_version INTEGER NOT NULL DEFAULT 1,     -- パスワード変更・退会で増やし、全端末のログインを無効にする
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pending_registrations (  -- 仮登録（9.2）
  token         TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS email_changes (          -- メールアドレス変更（8.3）
  token      TEXT PRIMARY KEY,
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(user_id),
  new_email  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (        -- パスワードリセット（9.4）
  token      TEXT PRIMARY KEY,
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(user_id),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS login_attempts (         -- ログイン失敗（9.3）
  email        TEXT PRIMARY KEY,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS id_retry_logs (          -- ユーザーIDの作り直しの記録（8.1）
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sites (             -- ユーザーが登録した収集元URL（8.4）
  user_id       TEXT COLLATE "C" NOT NULL REFERENCES users(user_id),
  site_id       INTEGER NOT NULL REFERENCES sites(site_id) ON DELETE CASCADE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE IF NOT EXISTS user_feed_items (        -- ユーザーごとのニュース一覧（最大200件。3.2・4.2）
  user_id       TEXT COLLATE "C" NOT NULL REFERENCES users(user_id),
  position      INTEGER NOT NULL,
  article_id    INTEGER NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  collection_id INTEGER REFERENCES collections(collection_id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, position)
);
DROP TABLE IF EXISTS feed_items;                    -- 1人用だったときの一覧（使わなくなった）

CREATE TABLE IF NOT EXISTS mock_mails (             -- メール送信のモック（実際には送らない）
  mail_id    SERIAL PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  link_url   TEXT,
  link_label TEXT,
  view_key   TEXT NOT NULL,                         -- この鍵を知っている画面だけがメールを表示できる
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- MYページの「今すぐ読み込む」で行った収集は、そのユーザーIDを記録する（自動収集は NULL）
ALTER TABLE collections ADD COLUMN IF NOT EXISTS user_id TEXT COLLATE "C";
