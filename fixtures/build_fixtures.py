# -*- coding: utf-8 -*-
"""
このディレクトリの *.xml は、collect_news.py の動作検証用フィクスチャです。
このサンドボックス環境は一般サイトへの直接アクセスが制限されているため、
各サイトの実際の公開RSSから2026-08-29に取得できた「本物の見出し・リンク・
配信日時・概要」を、そのままRSS 2.0形式で保存しています（文面の創作はしていません）。
本番でネット接続がある環境で動かす場合は --fixture-dir を付けず実行してください。
"""
import html
from pathlib import Path

HERE = Path(__file__).parent

RSS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>{title}</title>
{items}
</channel></rss>
"""
ITEM_TEMPLATE = """<item>
<title>{title}</title>
<link>{link}</link>
<pubDate>{pubdate}</pubDate>
<description>{description}</description>
</item>"""

# 実データ（2026-08-29、各サイトの公開RSSから取得した実際の項目を使用）
FEEDS = {
    "s1": ("東洋経済オンライン", [
        ("6.4億円相当のダイヤのネックレスが白昼堂々盗まれる…ウィーンのオーストリア応用美術博物館で",
         "https://toyokeizai.net/articles/-/956255", "Sat, 29 Aug 2026 11:00:00 +0900",
         "ウィーンのオーストリア応用美術博物館で､エジプト王室の結婚式のために製作された約6億円相当のダイヤモンドネックレスが白昼堂々と盗まれました。"),
        ("三菱｢トライトン｣の劇的変化を実現したヤマハ｢パフォーマンスダンパー｣とは一体なにか？",
         "https://toyokeizai.net/articles/-/956092", "Sat, 29 Aug 2026 11:00:00 +0900",
         "三菱｢トライトン｣の走りが､ヤマハ製パフォーマンスダンパーの採用で劇的に進化した。静粛性や一体感のあるハンドリングが実現し､上質なドライブフィールになったのだ。"),
        ("なぜ腐っていそうな｢納豆｣に｢腐｣がなく､腐っていない｢豆腐｣に｢腐｣があるのか",
         "https://toyokeizai.net/articles/-/954521", "Sat, 29 Aug 2026 10:00:00 +0900",
         "腐っていそうな見た目なのに｢腐｣の字がない｢納豆｣､腐っていないのに｢腐｣の字がある｢豆腐｣――。毎日の食卓に並ぶおなじみの2つの食品に隠された､漢字と語源の不思議。"),
        ("AIを使いすぎると｢バカになる｣は真実　MITが証明した､1カ月後も消えない\"脳の認知負債\"",
         "https://toyokeizai.net/articles/-/955690", "Sat, 29 Aug 2026 09:30:00 +0900",
         "AIが業務効率化の必須ツールとなった現代､あなたは｢AI任せ｣で本当にパフォーマンスを高められているのでしょうか。最新研究は､考える力を手放すことで脳が衰えるリスクを警告しています。"),
        ("世界の指導者はトランプの言うことを聞かなくなったのか",
         "https://toyokeizai.net/articles/-/956177", "Sat, 29 Aug 2026 08:00:00 +0900",
         "アメリカのトランプ大統領に\"屈しない\"ことが世界のトレンドになりつつあります。"),
    ]),
    "s2": ("ITmedia", [
        ("パスワードの先へ　Microsoft、Googleが変える認証と情報保護の新常識",
         "https://www.itmedia.co.jp/enterprise/articles/2608/28/news047.html", "Sat, 29 Aug 2026 07:00:00 +0900",
         "生成AIへの入力ミス、盗まれたクッキーの悪用、判別しにくい認証の強さ。企業のIT部門が悩む3つのリスクに、MicrosoftとGoogleが相次いで新対策を投入した。導入方法まで分かる3本をまとめ読み。"),
        ("「新幹線料金と同じ」　ラピダス小池社長が明かす、2ナノ半導体\"短納期\"の勝算",
         "https://www.itmedia.co.jp/business/articles/2608/28/news065.html", "Sat, 29 Aug 2026 07:00:00 +0900",
         "ラピダスが計画する2ナノメートル級先端半導体の量産化について、小池淳義社長が見解を示した。旺盛なAI需要を背景に「工程は遅れなく進行している」と強調。"),
        ("OpenAIのAIエージェント、約700体の群れで企業を襲撃　ハッキングの痕跡隠蔽を試みる――事件の裏で何が？",
         "https://www.itmedia.co.jp/business/articles/2608/28/news067.html", "Sat, 29 Aug 2026 06:55:00 +0900",
         "OpenAIのAIエージェントが、企業をハッキングした事件の詳細が明らかになった。実に700体のエージェント群が連携していたという。事件の裏で何が起きていたのか。"),
        ("「あの頃のTwitterに戻って」――X元法務担当者が「Twitter」奪還劇か、新SNS始動",
         "https://www.itmedia.co.jp/mobile/articles/2608/28/news068.html", "Sat, 29 Aug 2026 06:00:00 +0900",
         ""),
        ("「Galaxy S26 FE」グローバル発表　撮影も編集もAIにお任せ　約11万円から",
         "https://www.itmedia.co.jp/mobile/articles/2608/28/news069.html", "Sat, 29 Aug 2026 01:50:00 +0900",
         "Samsungが新スマートフォン「Galaxy S26 FE」を発表した。自動追跡機能「My FanCam」など充実したカメラ機能や編集機能を備える。"),
    ]),
    "s3": ("ライフハッカー・ジャパン", [
        ("横・縦どちらでも使える。USB扇風機でPCも自分もクールダウン",
         "https://www.lifehacker.jp/article/2608-amazon-usb-elecom-takujo-lly/", "Fri, 28 Aug 2026 13:00:00 GMT",
         "気温もノートPCの内部温度もグッと上昇してくる季節です。そんな真夏の二重苦をクールダウンしてくれるのが、エレコムのUSB扇風機FAN‑U177BK。"),
        ("うまく撮ろうとしなくても驚くほど「仕上がる」。動画撮影のハードルを下げたGoProの使い方",
         "https://www.lifehacker.jp/article/2608-korekai-lht-gopro-hero12-black/", "Fri, 28 Aug 2026 13:15:00 GMT",
         "2025年に買ったモノの中で、いちばん気持ちがワクワクしたモノはこれ！首かけ撮影、強力な手ブレ補正、超広角――「記録する楽しさ」を思い出させてくれたGoProの魅力を語ります。"),
        ("Apple Watchで「睡眠データ」を使いこなす3つの方法",
         "https://www.lifehacker.jp/article/2608-apple-watch-matome/", "Fri, 28 Aug 2026 12:45:00 GMT",
         "「Apple Watch、毎日着けているけど通知と運動記録くらいしか使っていないかも…」そんな方にこそ、ぜひ活用してほしいのが睡眠データの記録・分析機能です。"),
        ("充電を気にせず動画漬け。Xiaomiの大容量タブレットが2.5万円切り",
         "https://www.lifehacker.jp/article/amazon-timesale-fes-2026-0828-4/", "Fri, 28 Aug 2026 11:45:00 GMT",
         ""),
        ("「エアコンをつけるほどじゃない」微妙な暑さ、水1杯で解決してみない？",
         "https://www.lifehacker.jp/article/machi-ya-diamondicefog-end-962088/", "Fri, 28 Aug 2026 21:30:00 GMT",
         "猛暑対策と節電を両立する次世代の卓上冷風扇「Diamond-ice fog」。TEC半導体技術とナノミストが融合し驚きの涼感をもたらします。"),
    ]),
    "s4": ("Full-Count", [
        ("16歳有望株が前代未聞の偽装工作　出生証明書、死亡届、墓石まで「映画のようだ」",
         "https://full-count.jp/2026/08/29/post2009434/", "Sat, 29 Aug 2026 16:07:47 +0900",
         "メジャーリーグ（MLB）が、架空の死亡届提出や偽の墓石設置などの過激な偽装工作を用いて年齢詐称を行ったドミニカ共和国出身のダウリー・セベリーノ内野手に処分を下した。"),
        ("ロッテ助っ人右腕、判定に\"ブチギレ\"→悪夢5失点　今川に四球、連打で炎上",
         "https://full-count.jp/2026/08/29/post2009469/", "Sat, 29 Aug 2026 15:33:28 +0900",
         "ロッテのアンドレ・ジャクソン投手は29日、エスコンフィールドで行われた日本ハム戦に先発登板した。4回には今川優馬外野手への判定を巡り、納得がいかないといった表情を浮かべた。"),
        ("阪神に「突如現れた救世主」　西武戦力外→帳消しにした\"-19.8\"…際立つ「1.0」の価値",
         "https://full-count.jp/2026/08/29/post2009442/", "Sat, 29 Aug 2026 15:00:28 +0900",
         "セ・リーグ連覇を狙う阪神は28日の巨人戦（甲子園）に勝利し、2位とのゲーム差を「2.5」に広げた。"),
        ("村上宗隆の\"神判断\"「賢いムネ」　シカゴ放送が息をのんだ瞬間「なんという送球だ」",
         "https://full-count.jp/2026/08/29/post2009378/", "Sat, 29 Aug 2026 14:13:09 +0900",
         "ホワイトソックスの村上宗隆内野手が28日（日本時間29日）、敵地でのツインズ戦に「2番・一塁」で先発出場。頭脳的な併殺を完成させた。"),
        ("佐藤輝明の今オフMLB移籍は「疑問が残る」　3冠王の可能性も…専門家が挙げた\"懸念材料\"",
         "https://full-count.jp/2026/08/29/post2009308/", "Sat, 29 Aug 2026 11:41:20 +0900",
         "セ・リーグ首位の阪神は28日、本拠地・甲子園で行われた巨人戦に4-1で勝利。4番の佐藤輝明内野手は3回に右前適時打を放った。"),
    ]),
    "s5": ("映画.com", [
        ("夏休みの終わり、少年時代の記憶と幻のような少女　珠玉のバカンスアニメーション「見えない子ども」",
         "https://eiga.com/news/20260829/4/", "Sat, 29 Aug 2026 09:00:00 +0900",
         "「ひろしまアニメーションシーズン2026」（HAS2026）に参加した。会期中には40以上のプログラム、300以上の作品が上映された。"),
        ("福山雅治主演「ガリレオ」など珠玉のミステリーが集結！TVerにて「東野圭吾特集」を無料配信",
         "https://eiga.com/news/20260829/3/", "Sat, 29 Aug 2026 08:00:00 +0900",
         "福山雅治が主演を務めたドラマ「ガリレオ」など、珠玉のミステリー作品が集結した「東野圭吾特集」が、TVerにて配信開始された。"),
        ("桜田通「ドラえもん」誕生日スペシャル放送にゲスト出演！　物語の鍵を握る未来のキツネ型ロボット・コンロボ役に",
         "https://eiga.com/news/20260829/1/", "Sat, 29 Aug 2026 06:00:00 +0900",
         "テレビ朝日が、ドラえもんの誕生日を記念した「ドラえもん 誕生日スペシャル」を、9月6日に放送することが分かった。"),
        ("成島出監督死去、65歳　代表作に「八日目の蝉」「ソロモンの偽証」など",
         "https://eiga.com/news/20260828/22/", "Sat, 29 Aug 2026 21:00:00 +0900",
         "映画監督の成島出さんが、8月24日に死去したと所属事務所が発表した。享年65。"),
        ("アンドリュー・ガーフィールド、OpenAIサム・アルトマン役について語る",
         "https://eiga.com/news/20260828/21/", "Sat, 29 Aug 2026 20:00:00 +0900",
         "アンドリュー・ガーフィールドが、ルカ・グァダニーノ監督の新作映画でOpenAIのCEOサム・アルトマンを演じることについて語った。"),
    ]),
    "s6": ("Japan Today", [
        ("Bessent warns unstable yen could lead to higher U.S. interest rates",
         "https://japantoday.com/category/business/bessent-warns-unstable-yen-could-lead-to-higher-u.s.-interest-rates",
         "Sat, 29 Aug 2026 07:04:06 +0000",
         "U.S. Treasury Secretary Scott Bessent on Friday disclosed a letter justifying last month's coordinated market intervention by the United States and Japan to prop up the yen."),
        ("Number of missing in Nepal, China floods soars past 2,400",
         "https://japantoday.com/category/world/number-of-missing-in-nepal-china-floods-soars-past-2-400",
         "Sat, 29 Aug 2026 03:57:15 +0000",
         "Rescuers in Nepal and China were struggling Saturday to locate thousands of people missing days after a deadly, tsunami-like wall of water and debris swept through the Himalayan region."),
        ("Trump says U.S. has entered deal with Venezuela to take control of 65 billion barrels of oil reserves",
         "https://japantoday.com/category/world/trump-says-us-has-entered-deal-with-venezuela-to-take-control-of-65-billion-barrels-of-oil-reserves",
         "Sat, 29 Aug 2026 06:50:19 +0000",
         "President Donald Trump on Friday said the U.S. has entered an agreement with Venezuela to take control of 65 billion barrels of the South American country's oil reserves."),
        ("Man City overrun Palace to stay perfect in the Premier League",
         "https://japantoday.com/category/sports/man-city-overrun-palace-to-stay-perfect-in-the-premier-league",
         "Sat, 29 Aug 2026 01:29:34 +0000",
         "Rayan Cherki scored two goals in five minutes and Erling Haaland also got a brace as Manchester City won at Crystal Palace 4-1."),
        ("Rei Sakamoto earns U.S. Open spot, but beats his retiring hero Kei Nishikori to do it",
         "https://japantoday.com/category/sports/japanese%27s-rei-sakamoto-earns-a-us-open-spot-but-beats-his-retiring-hero-kei-nishikori-to-do-it",
         "Fri, 28 Aug 2026 20:47:35 +0000",
         "Rei Sakamoto played his way into the U.S. Open — but only by taking the spot that Kei Nishikori, Japan's greatest men's tennis star, hoped to earn."),
    ]),
}

for site_id, (name, items) in FEEDS.items():
    xml_items = []
    for title, link, pubdate, desc in items:
        xml_items.append(ITEM_TEMPLATE.format(
            title=html.escape(title),
            link=html.escape(link),
            pubdate=pubdate,
            description=html.escape(desc),
        ))
    xml = RSS_TEMPLATE.format(title=html.escape(name), items="\n".join(xml_items))
    (HERE / f"{site_id}.xml").write_text(xml, encoding="utf-8")
    print(f"wrote {site_id}.xml ({len(items)} items)")
