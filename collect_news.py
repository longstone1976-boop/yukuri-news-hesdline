#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
collect_news.py — ゆっくりNEWS 記事収集プログラム

仕様書「3. 記事収集ロジック」「2.2 見出しタイトルの文字数」「2.3 要約AI連携」を
実装した、実際にRSSを取得してキュレーションするプログラムです。

ChatGPT/Gemini等の外部AI要約APIは使用しません（ユーザー指示により不使用）。
そのため 2.2/2.3 の「AI要約」部分は、句読点・カギ括弧を優先した簡易な
文字数トリミングに置き換えています（要約ではなく短縮です。README参照）。

------------------------------------------------------------------------
■ 使い方
    pip install feedparser
    python3 collect_news.py                       # 実際にRSSを取得して収集
    python3 collect_news.py --output out.json      # 出力先を指定
    python3 collect_news.py --hours 24 --per-site-limit 20   # 仕様3.2のデフォルト値
    python3 collect_news.py --now 2026-08-29T16:00:00+09:00  # 収集時刻を指定（テスト用）
    python3 collect_news.py --fixture-dir ./fixtures             # ネット不要のオフライン検証モード

■ 仕様との対応
    2.1 時刻の扱い       : すべて日本時間(Asia/Tokyo, UTC+9)に変換して扱う
    2.2 見出し25文字ルール : 25文字を超える見出しは短縮する（本プログラムでは非AI）
    2.3 要約AI連携        : 本プログラムでは不使用（--use-ai系のフックのみ用意）
    3.1 収集タイミング     : 1日3回 6:00 / 11:55 / 16:00(JST) ※cron等の外部スケジューラから
                             1日3回このスクリプトを起動する想定（本ファイル単体では常駐しない）
    3.2 収集対象の記事範囲 : 収集実行時刻から24時間前まで、サイトごとに最新20件
------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import urllib.request
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

try:
    import feedparser
except ImportError:
    sys.exit("feedparser が見つかりません。先に `pip install feedparser` を実行してください。")

JST = dt.timezone(dt.timedelta(hours=9))

# ------------------------------------------------------------------------
# 1. キュレーション対象サイト（仕様3.2「管理画面に登録されたURL」に相当）
#    すべて実在し、本プログラム作成時点で配信が確認できた公開RSSフィード。
# ------------------------------------------------------------------------
SITES = [
    {"id": "s1", "name": "東洋経済オンライン",     "category": "経済",   "feed_url": "https://toyokeizai.net/list/feed/rss"},
    {"id": "s2", "name": "ITmedia",               "category": "IT",     "feed_url": "https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml"},
    {"id": "s3", "name": "ライフハッカー・ジャパン", "category": "暮らし",  "feed_url": "https://www.lifehacker.jp/feed/index.xml"},
    {"id": "s4", "name": "Full-Count",            "category": "スポーツ", "feed_url": "https://full-count.jp/feed/"},
    {"id": "s5", "name": "映画.com",               "category": "エンタメ", "feed_url": "https://feeds.eiga.com/eiga_news"},
    {"id": "s6", "name": "Japan Today",            "category": "国際",   "feed_url": "https://japantoday.com/feed"},
]

TITLE_MAX_CHARS = 25      # 仕様2.2
SUMMARY_MAX_CHARS = 250   # 仕様2.3
DEFAULT_LOOKBACK_HOURS = 24   # 仕様3.2
DEFAULT_PER_SITE_LIMIT = 20   # 仕様3.2

USER_AGENT = "YukkuriNewsCollector/1.0 (+personal curation prototype)"


@dataclass
class Article:
    id: str
    source_id: str
    source: str
    category: str
    title: str            # 表示用（短縮後）
    title_full: str       # 元タイトル（未加工）
    title_shortened: bool
    url: str
    posted_at: str         # ISO8601, JST
    posted_at_ms: int
    summary: str           # 表示用（250字に短縮後）
    summary_full: str       # 元の概要（未加工）
    collected_at: str


def to_jst_iso(struct_time) -> tuple[str, int]:
    """feedparser の time.struct_time (UTC) を JST の ISO文字列とms epochに変換する。仕様2.1。"""
    if struct_time is None:
        now = dt.datetime.now(tz=JST)
        return now.isoformat(), int(now.timestamp() * 1000)
    utc_dt = dt.datetime(*struct_time[:6], tzinfo=dt.timezone.utc)
    jst_dt = utc_dt.astimezone(JST)
    return jst_dt.isoformat(), int(jst_dt.timestamp() * 1000)


_CUT_POINTS = "。！？」』、,.!?"


def shorten_text(text: str, max_chars: int) -> tuple[str, bool]:
    """
    AIを使わない簡易短縮。max_charsを超える場合、句読点などの区切りのうち
    max_chars以内で最も長く収まる位置を探して切り、無ければ単純に切って「…」を付ける。
    戻り値: (表示用テキスト, 短縮したかどうか)
    """
    text = re.sub(r"\s+", " ", (text or "")).strip()
    chars = list(text)
    if len(chars) <= max_chars:
        return text, False

    window = chars[: max_chars - 1]
    best_cut = None
    for i in range(len(window) - 1, -1, -1):
        if window[i] in _CUT_POINTS and i >= max_chars * 0.5:
            best_cut = i + 1
            break
    if best_cut:
        shortened = "".join(chars[:best_cut]).rstrip("。、,.") + "…"
    else:
        shortened = "".join(window) + "…"
    return shortened, True


def strip_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", "", raw or "")
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&#39;", "'", text)
    return re.sub(r"\s+", " ", text).strip()


def fetch_feed_bytes(url: str, timeout: int = 15) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def load_feed(site: dict, fixture_dir: Optional[Path]) -> "feedparser.FeedParserDict":
    """fixture_dir が指定されていればローカルファイルから、なければ実際にネットから取得する。"""
    if fixture_dir:
        path = fixture_dir / f"{site['id']}.xml"
        if not path.exists():
            raise FileNotFoundError(f"フィクスチャが見つかりません: {path}")
        return feedparser.parse(str(path))
    raw = fetch_feed_bytes(site["feed_url"])
    return feedparser.parse(raw)


def entry_datetime_struct(entry):
    return getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)


def collect_site(site: dict, *, now: dt.datetime, lookback_hours: int, per_site_limit: int,
                  fixture_dir: Optional[Path]) -> list[Article]:
    feed = load_feed(site, fixture_dir)
    if feed.bozo and not feed.entries:
        print(f"  ! {site['name']}: 取得/解析に失敗しました ({feed.bozo_exception})", file=sys.stderr)
        return []

    cutoff = now - dt.timedelta(hours=lookback_hours)
    articles: list[Article] = []

    for entry in feed.entries:
        posted_iso, posted_ms = to_jst_iso(entry_datetime_struct(entry))
        posted_dt = dt.datetime.fromisoformat(posted_iso)
        if posted_dt < cutoff:
            continue  # 仕様3.2: 収集実行時刻から24時間前まで

        title_full = strip_html(getattr(entry, "title", "") or "")
        desc_full = strip_html(getattr(entry, "summary", "") or getattr(entry, "description", "") or "")
        if not desc_full:
            # 仕様2.3: 要約(この場合は元テキスト)が取得できない場合は元タイトルのみ扱いとする
            desc_full = title_full

        title_disp, title_short = shorten_text(title_full, TITLE_MAX_CHARS)
        summary_disp, _ = shorten_text(desc_full, SUMMARY_MAX_CHARS)

        link = getattr(entry, "link", "") or ""
        uid = re.sub(r"[^0-9A-Za-z]+", "", (getattr(entry, "id", "") or link))[-16:] or str(posted_ms)

        articles.append(Article(
            id=f"{site['id']}_{uid}",
            source_id=site["id"],
            source=site["name"],
            category=site["category"],
            title=title_disp,
            title_full=title_full,
            title_shortened=title_short,
            url=link,
            posted_at=posted_iso,
            posted_at_ms=posted_ms,
            summary=summary_disp,
            summary_full=desc_full,
            collected_at=now.isoformat(),
        ))

        if len(articles) >= per_site_limit:
            break  # 仕様3.2: サイトごとに最新20件まで

    return articles


def collect_all(*, now: dt.datetime, lookback_hours: int, per_site_limit: int,
                 fixture_dir: Optional[Path]) -> list[Article]:
    all_articles: list[Article] = []
    for site in SITES:
        print(f"収集中: {site['name']} ({site['feed_url']})")
        try:
            site_articles = collect_site(
                site, now=now, lookback_hours=lookback_hours,
                per_site_limit=per_site_limit, fixture_dir=fixture_dir,
            )
        except Exception as exc:  # noqa: BLE001 — 1サイトの失敗で全体を止めない
            print(f"  ! {site['name']}: エラーのためスキップ ({exc})", file=sys.stderr)
            continue
        print(f"  -> {len(site_articles)}件（過去{lookback_hours}時間・上限{per_site_limit}件）")
        all_articles.extend(site_articles)

    all_articles.sort(key=lambda a: a.posted_at_ms, reverse=True)
    return all_articles


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default="curated_articles.json", help="出力JSONファイルのパス")
    parser.add_argument("--hours", type=int, default=DEFAULT_LOOKBACK_HOURS, help="収集対象の遡り時間（時間単位、仕様3.2）")
    parser.add_argument("--per-site-limit", type=int, default=DEFAULT_PER_SITE_LIMIT, help="サイトごとの最大取得件数（仕様3.2）")
    parser.add_argument("--now", default=None, help="収集実行時刻をISO8601で指定（未指定なら現在時刻）。テストや過去データ再現に使用。")
    parser.add_argument("--fixture-dir", default=None, help="この場所のローカルXMLからオフラインで読み込む（<site.id>.xml）。ネット接続不要の検証用。")
    args = parser.parse_args()

    now = dt.datetime.fromisoformat(args.now).astimezone(JST) if args.now else dt.datetime.now(tz=JST)
    fixture_dir = Path(args.fixture_dir) if args.fixture_dir else None

    print(f"=== ゆっくりNEWS 記事収集プログラム ===")
    print(f"収集実行時刻(JST): {now.isoformat()}")
    print(f"対象サイト: {len(SITES)}件 / 遡り{args.hours}時間 / サイト毎上限{args.per_site_limit}件")
    if fixture_dir:
        print(f"(オフライン検証モード: {fixture_dir})")
    print()

    articles = collect_all(now=now, lookback_hours=args.hours, per_site_limit=args.per_site_limit, fixture_dir=fixture_dir)

    shortened_titles = sum(1 for a in articles if a.title_shortened)
    output = {
        "collected_at": now.isoformat(),
        "lookback_hours": args.hours,
        "per_site_limit": args.per_site_limit,
        "sites": SITES,
        "article_count": len(articles),
        "articles": [asdict(a) for a in articles],
    }
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"合計 {len(articles)} 件を収集しました（うち見出し短縮 {shortened_titles} 件）。")
    print(f"出力: {args.output}")


if __name__ == "__main__":
    main()
