#!/usr/bin/env python3
"""Assemble the Inbox handbook (one Markdown file and one self-contained HTML ebook)
from the staff guide, the manager's playbook and the use-case catalogue.
Standard library only."""
import html
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GUIDES = REPO / "docs" / "guides"
USECASES = GUIDES / "inbox-use-cases.md"


def split_top(text):
    """Split a Markdown file into {top-level heading: body}."""
    out, cur, buf = {}, None, []
    for line in text.splitlines():
        if line.startswith("# "):
            if cur is not None:
                out[cur] = "\n".join(buf).strip("\n")
            cur, buf = line[2:].strip(), []
        else:
            buf.append(line)
    if cur is not None:
        out[cur] = "\n".join(buf).strip("\n")
    return out


def demote(body, by=1):
    """Push every heading in a body down by N levels."""
    lines = []
    for line in body.splitlines():
        m = re.match(r"^(#{2,5}) (.*)$", line)
        lines.append("#" * (len(m.group(1)) + by) + " " + m.group(2) if m else line)
    return "\n".join(lines)


def strip_rules(body):
    return "\n".join(l for l in body.splitlines() if l.strip() != "---").strip("\n")


def section(body, heading):
    """Return the body of one '## heading' section."""
    lines, on, out = body.splitlines(), False, []
    for line in lines:
        if line.startswith("## "):
            on = line[3:].strip() == heading
            continue
        if on:
            out.append(line)
    return "\n".join(out).strip("\n")


staff = split_top((GUIDES / "inbox-staff-guide.md").read_text())
play = split_top((GUIDES / "inbox-manager-playbook.md").read_text())
uses = split_top(USECASES.read_text())

staff_intro = staff["Mrs. Samuel Inbox: Staff Guide"]
P = lambda d, k: strip_rules(d[k])

# (part title, one-line description, [(chapter title, body)])
PARTS = [
    (
        "What we have built",
        "What the Inbox is, everything it does today, and what every screen and button is for.",
        [
            ("What the Inbox is", section(staff_intro, "What the Inbox is") + "\n\n### Where to find it\n\n" + section(staff_intro, "Where to find it")),
            ("Everything it does today", demote(P(play, "Part 2: Everything the Inbox does today"))),
            ("The Inbox screen", demote(P(staff, "Part 1: Inbox"))),
            ("Inbox reports", demote(P(staff, "Part 3: Inbox reports"))),
            ("Inbox settings", demote(P(staff, "Part 4: Inbox settings"))),
        ],
    ),
    (
        "What to set up now",
        "Sixteen tasks, in order, with where to do each one and who does it.",
        [(None, P(play, "Part 1: What to set up now"))],
    ),
    (
        "Use cases",
        "What the business can use the Inbox for, area by area, and what each one needs.",
        [(None, P(uses, "Part 3: Use cases"))],
    ),
    (
        "Running it well",
        "Step-by-step jobs, the ten practices, the rules, and what to do when something goes wrong.",
        [
            ("Everyday jobs, step by step", demote(P(staff, "Part 2: Everyday jobs, step by step"))),
            ("Ten practices that make it pay", demote(P(play, "Part 3: How to get the most out of it"))),
            ("Rules to remember", demote(P(staff, "Part 5: Rules to remember"))),
            ("If something goes wrong", P(staff, "Part 6: If something goes wrong")),
            ("Coming next", P(play, "Coming next")),
            ("Who to ask", P(play, "Who to ask")),
        ],
    ),
]

TITLE = "Mrs. Samuel Inbox Handbook"
SUBTITLE = "What we have built, what to set up now, and what to use it for."
UPDATED = "18 November 2026"


def slugify(s, seen):
    base = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "section"
    slug, n = base, 2
    while slug in seen:
        slug, n = f"{base}-{n}", n + 1
    seen.add(slug)
    return slug


# ---------- build a flat list of blocks: (kind, ...) ----------
seen = set()
doc = []  # ("part", n, title, desc, id) | ("chapter", title, id) | ("md", text)
toc = []  # (part n, title, id, [(chapter title, id)])
for i, (ptitle, pdesc, chapters) in enumerate(PARTS, 1):
    pid = slugify(f"part-{i}-{ptitle}", seen)
    doc.append(("part", i, ptitle, pdesc, pid))
    entries = []
    for ctitle, body in chapters:
        if ctitle is None:
            # chapters are the body's own ## headings
            cur, buf = None, []
            pre = []
            for line in body.splitlines():
                if line.startswith("## "):
                    if cur is None and pre:
                        doc.append(("md", "\n".join(pre)))
                    if cur is not None:
                        doc.append(("md", "\n".join(buf)))
                    cur, buf = line[3:].strip(), []
                    cid = slugify(cur, seen)
                    doc.append(("chapter", cur, cid))
                    entries.append((cur, cid))
                elif cur is None:
                    pre.append(line)
                else:
                    buf.append(line)
            if cur is not None:
                doc.append(("md", "\n".join(buf)))
            elif pre:
                doc.append(("md", "\n".join(pre)))
        else:
            cid = slugify(ctitle, seen)
            doc.append(("chapter", ctitle, cid))
            entries.append((ctitle, cid))
            doc.append(("md", body))
    toc.append((i, ptitle, pid, entries))

# ---------- Markdown output ----------
md = [f"# {TITLE}", "", SUBTITLE, "", f"Last updated {UPDATED}.", "", '<a id="contents"></a>', "", "## Contents", ""]
for n, ptitle, pid, entries in toc:
    md.append(f"**[Part {n}: {ptitle}](#{pid})**")
    md.append("")
    for ctitle, cid in entries:
        md.append(f"- [{ctitle}](#{cid})")
    md.append("")
for block in doc:
    if block[0] == "part":
        _, n, title, desc, pid = block
        md += ["---", "", f'<a id="{pid}"></a>', "", f"# Part {n}: {title}", "", desc, "", "[Back to contents](#contents)", ""]
    elif block[0] == "chapter":
        _, title, cid = block
        md += [f'<a id="{cid}"></a>', "", f"## {title}", ""]
    else:
        md += [block[1].strip("\n"), ""]
(GUIDES / "inbox-handbook.md").write_text("\n".join(md).rstrip() + "\n")

# ---------- minimal Markdown -> HTML ----------
PILLS = {
    "Now": "now",
    "Now + template": "tpl",
    "Phone line": "phone",
    "Coming": "soon",
    "Now + template, one by one": "tpl",
    "Now + template if over 24 hours": "tpl",
}


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def cells(row):
    return [c.strip() for c in row.strip().strip("|").split("|")]


def to_html(text, shift=0):
    out, lines, i = [], text.splitlines(), 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        m = re.match(r"^(#{2,6}) (.*)$", line)
        if m:
            level = min(len(m.group(1)) + shift, 6)
            out.append(f"<h{level}>{inline(m.group(2))}</h{level}>")
            i += 1
            continue
        if line.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            head = cells(line)
            i += 2
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                rows.append(cells(lines[i]))
                i += 1
            is_status = head and head[-1] in ("Status", "Mark")
            h = ["<div class='tbl'><table><thead><tr>"] + [f"<th>{inline(c)}</th>" for c in head] + ["</tr></thead><tbody>"]
            for r in rows:
                h.append("<tr>")
                for j, c in enumerate(r):
                    plain = re.sub(r"\*\*", "", c)
                    pill_col = (is_status and j == len(r) - 1 and head[-1] == "Status") or (head[-1] != "Status" and j == 0 and head[0] == "Mark")
                    if pill_col and plain in PILLS:
                        h.append(f"<td><span class='pill pill--{PILLS[plain]}'>{html.escape(plain)}</span></td>")
                    else:
                        h.append(f"<td>{inline(c)}</td>")
                h.append("</tr>")
            h.append("</tbody></table></div>")
            out.append("".join(h))
            continue
        if re.match(r"^\s*- ", line):
            items = []
            while i < len(lines) and re.match(r"^\s*- ", lines[i]):
                items.append(re.sub(r"^\s*- ", "", lines[i]))
                i += 1
            out.append("<ul>" + "".join(f"<li>{inline(x)}</li>" for x in items) + "</ul>")
            continue
        if re.match(r"^\s*\d+\. ", line):
            items = []
            while i < len(lines) and re.match(r"^\s*\d+\. ", lines[i]):
                items.append(re.sub(r"^\s*\d+\. ", "", lines[i]))
                i += 1
            out.append("<ol>" + "".join(f"<li>{inline(x)}</li>" for x in items) + "</ol>")
            continue
        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{2,6} |\s*- |\s*\d+\. |\s*\|)", lines[i]):
            para.append(lines[i])
            i += 1
        out.append("<p>" + inline(" ".join(para)) + "</p>")
    return "\n".join(out)


body = []
for block in doc:
    if block[0] == "part":
        _, n, title, desc, pid = block
        body.append(
            f"<section class='part' id='{pid}'><div class='part__n'>Part {n}</div>"
            f"<h1>{html.escape(title)}</h1><p class='part__d'>{html.escape(desc)}</p>"
            f"<p class='back'><a href='#contents'>&uarr; Contents</a></p></section>"
        )
    elif block[0] == "chapter":
        _, title, cid = block
        body.append(f"<h2 class='chapter' id='{cid}'>{html.escape(title)}<a class='top' href='#contents' title='Back to contents'>&uarr; Contents</a></h2>")
    else:
        body.append(to_html(block[1]))

nav = []
contents = []
for n, ptitle, pid, entries in toc:
    nav.append(f"<a class='nav__part' href='#{pid}'><span>Part {n}</span>{html.escape(ptitle)}</a>")
    nav.append("<div class='nav__ch'>" + "".join(f"<a href='#{cid}'>{html.escape(t)}</a>" for t, cid in entries) + "</div>")
    contents.append(
        f"<a class='card' href='#{pid}'><div class='card__n'>Part {n}</div><div class='card__t'>{html.escape(ptitle)}</div>"
        f"<div class='card__d'>{html.escape(PARTS[n - 1][1])}</div><div class='card__c'>{len(entries)} chapters</div></a>"
    )
contents_list = []
for n, ptitle, pid, entries in toc:
    contents_list.append(f"<div class='toc__part'><a href='#{pid}'>Part {n}: {html.escape(ptitle)}</a><ol>" + "".join(f"<li><a href='#{cid}'>{html.escape(t)}</a></li>" for t, cid in entries) + "</ol></div>")

CSS = """
:root{--ink:#1b2a21;--soft:#5a685f;--green:#1f6b3f;--deep:#14432a;--line:#e4dccb;--cream:#fdf8ee;--card:#fff;--orange:#e86a1f;--tint:#f4ecdb}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:16px}
body{margin:0;background:var(--cream);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--green)}
.layout{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}
nav.side{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;background:var(--deep);color:#fff;padding:22px 16px 40px}
nav.side .brand{font:700 17px/1.3 Georgia,serif;margin:0 6px 4px}
nav.side .brand small{display:block;font:400 12px/1.4 -apple-system,sans-serif;opacity:.7;margin-top:2px}
.nav__part{display:block;margin:20px 6px 6px;color:#fff;text-decoration:none;font-weight:700;font-size:15px}
.nav__part span{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#f4b56a;font-weight:600}
.nav__ch a{display:block;padding:5px 10px;margin:1px 0;border-radius:8px;color:#d7e6dc;text-decoration:none;font-size:14px;line-height:1.35}
.nav__ch a:hover{background:rgba(255,255,255,.1);color:#fff}
.nav__ch a.is-here{background:#fff;color:var(--deep);font-weight:600}
main{padding:0 28px 96px;max-width:920px;width:100%;margin:0 auto}
.cover{padding:64px 0 28px}
.cover .eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--orange);font-weight:700}
.cover h1{font:700 46px/1.1 Georgia,serif;color:var(--deep);margin:10px 0 12px;border:0;padding:0}
.cover p{font-size:19px;color:var(--soft);margin:0 0 6px;max-width:620px}
.cover .meta{font-size:13px;color:var(--soft)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin:26px 0 8px}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;text-decoration:none;color:var(--ink);transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(20,67,42,.12)}
.card__n{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--orange);font-weight:700}
.card__t{font:700 20px/1.2 Georgia,serif;color:var(--deep);margin:4px 0 6px}
.card__d{font-size:14px;color:var(--soft);line-height:1.45}
.card__c{font-size:12px;color:var(--green);font-weight:600;margin-top:10px}
#contents{margin-top:34px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px}
#contents h2{margin:0 0 6px;font:700 22px/1.2 Georgia,serif;color:var(--deep);border:0;padding:0}
.toc{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 28px}
.toc__part>a{display:block;font-weight:700;color:var(--deep);text-decoration:none;margin-top:12px}
.toc__part ol{margin:4px 0 0;padding-left:20px}.toc__part li{margin:2px 0;font-size:15px}
.part{margin:72px -4px 8px;padding:34px 30px;border-radius:20px;background:linear-gradient(135deg,var(--deep),var(--green));color:#fff}
.part__n{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#f4b56a;font-weight:700}
.part h1{font:700 36px/1.15 Georgia,serif;margin:6px 0 8px;color:#fff}
.part__d{margin:0;font-size:17px;color:#dbe9df;max-width:600px}
.part .back{margin:14px 0 0;font-size:13px}.part .back a{color:#fff}
h2.chapter{font:700 27px/1.2 Georgia,serif;color:var(--deep);margin:52px 0 10px;padding-top:18px;border-top:2px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;gap:12px}
h2.chapter .top{font:500 12px/1 -apple-system,sans-serif;color:var(--soft);text-decoration:none;white-space:nowrap}
h2.chapter .top:hover{color:var(--green)}
h3{font-size:20px;margin:32px 0 8px;color:var(--ink)}
h4{font-size:16px;margin:24px 0 6px;color:var(--green);text-transform:none}
h5{font-size:15px;margin:18px 0 4px}
p{margin:10px 0}ul,ol{padding-left:22px;margin:10px 0}li{margin:4px 0}
code{background:var(--tint);padding:1px 6px;border-radius:5px;font-size:14px}
.tbl{overflow-x:auto;margin:14px 0 22px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:15px;min-width:460px}
th,td{text-align:left;vertical-align:top;padding:10px 13px;border-bottom:1px solid var(--line)}
th{background:var(--tint);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft)}
tr:last-child td{border-bottom:0}tbody tr:hover{background:#fffdf7}
td:first-child{min-width:44px}td:nth-child(2){min-width:150px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.pill--now{background:#dff3e4;color:#17603a}.pill--tpl{background:#fdeacc;color:#8a5200}
.pill--phone{background:#e1ecfb;color:#1d4f91}.pill--soon{background:#ece8f7;color:#54408f}
.menu{display:none}
footer{margin-top:64px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--soft)}
@media (max-width:900px){.layout{display:block}nav.side{position:fixed;inset:0 auto 0 0;width:84%;max-width:320px;transform:translateX(-102%);transition:transform .2s;z-index:20}
 body.open nav.side{transform:none}.menu{display:inline-flex;position:fixed;right:14px;bottom:14px;z-index:30;background:var(--deep);color:#fff;border:0;border-radius:999px;padding:12px 18px;font:600 15px -apple-system,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.25)}
 main{padding:0 16px 96px}.cover h1{font-size:34px}.part{margin:56px 0 8px;padding:26px 20px}.part h1{font-size:28px}h2.chapter{font-size:23px}}
@media print{nav.side,.menu,.top,.back{display:none!important}.layout{display:block}body{background:#fff}main{max-width:none;padding:0}
 .part{break-before:page;background:#fff;color:#000;border:2px solid #000}.part h1,.part__d{color:#000}.part__n{color:#444}
 h2.chapter{break-after:avoid}table,tr{break-inside:avoid}.tbl{border-color:#999}}
"""

JS = """
const links=[...document.querySelectorAll('.nav__ch a')];
const map=new Map(links.map(a=>[a.getAttribute('href').slice(1),a]));
const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){links.forEach(l=>l.classList.remove('is-here'));
 const a=map.get(e.target.id);if(a){a.classList.add('is-here');a.scrollIntoView({block:'nearest'});}}})},{rootMargin:'0px 0px -75% 0px'});
document.querySelectorAll('h2.chapter').forEach(h=>io.observe(h));
const btn=document.querySelector('.menu');btn.addEventListener('click',()=>document.body.classList.toggle('open'));
document.querySelectorAll('nav.side a').forEach(a=>a.addEventListener('click',()=>document.body.classList.remove('open')));
"""

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(TITLE)}</title><style>{CSS}</style></head>
<body><div class="layout">
<nav class="side" aria-label="Contents"><div class="brand">Inbox Handbook<small>Mrs. Samuel Fruit Juice</small></div>
{''.join(nav)}</nav>
<main>
<header class="cover"><div class="eyebrow">Mrs. Samuel Fruit Juice</div><h1>Inbox Handbook</h1>
<p>{html.escape(SUBTITLE)}</p><p class="meta">Last updated {UPDATED}. Tap any part to jump to it.</p>
<div class="cards">{''.join(contents)}</div></header>
<section id="contents"><h2>Contents</h2><div class="toc">{''.join(contents_list)}</div></section>
{''.join(body)}
<footer>Mrs. Samuel Inbox Handbook. Last updated {UPDATED}. <a href="#contents">Back to contents</a></footer>
</main></div><button class="menu" type="button">Contents</button><script>{JS}</script></body></html>
"""
(GUIDES / "inbox-handbook.html").write_text(page)
print("parts", len(toc), "chapters", sum(len(e) for _, _, _, e in toc), "html bytes", len(page))
