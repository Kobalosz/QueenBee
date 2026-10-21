#!/usr/bin/env python3
"""Funder sweep: fetch every program page in data/funders.md, report which ones changed since the
last run, and pull out open/closed wording and dates so the agent only opens pages that moved.

    python3 scripts/funder_sweep.py          # check, then remember page fingerprints
    python3 scripts/funder_sweep.py --dry    # check without updating state/funder_pages.json

RUN IT IN THE FOREGROUND, once per run. It stops itself at DEADLINE seconds.

A page that answers 403/429 is BLOCKED, not dead: many funders block scripts. Check those in the
browser when they are due. The Aggregators section is skipped; aggregators are searched by hand.
Signals are hints pulled from page text, never facts: confirm on the page before acting.
"""
import concurrent.futures as cf
import datetime
import hashlib
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNDERS = os.path.join(R, "data", "funders.md")
STATE = os.path.join(R, "state", "funder_pages.json")
DEADLINE = 180
dry = "--dry" in sys.argv[1:]


def _utf8_stdout():
    # Windows consoles default to a legacy code page and fail on characters such as ★ or —.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


_utf8_stdout()

OPEN = re.compile(r"applications? (?:are |is )?(?:now )?(?:open|being accepted)|now accepting|apply now|accepting applications|apply today|open for applications", re.I)
CLOSED = re.compile(r"applications? (?:are |is )?(?:now )?closed|no longer accepting|currently closed|closed for|not accepting|check back|opens? (?:in|on)|coming soon", re.I)
MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
DATE = re.compile(rf"\b{MONTHS} \d{{1,2}}(?:st|nd|rd|th)?,? \d{{4}}\b|\b\d{{1,2}}/\d{{1,2}}/\d{{2,4}}\b", re.I)
DUE = re.compile(r"deadline|due|close[sd]?|closing|ends?|opens?|open until|by\b", re.I)


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


CTX = _ctx()


def rows():
    """(program, url, section) for every table row with a URL, outside the Aggregators section."""
    out, section = [], ""
    for line in open(FUNDERS, encoding="utf-8"):
        if line.startswith("## "):
            section = line[3:].strip()
        if section.lower().startswith("aggregators") or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0].startswith("~~"):
            continue
        m = re.search(r"https?://\S+", cells[1])
        if m:
            out.append((cells[0], m.group().rstrip(").,"), section))
    return out


def page_text(raw):
    raw = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


def fetch(item):
    name, url, section = item
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US"})
        with urllib.request.urlopen(req, timeout=25, context=CTX) as r:
            t = page_text(r.read().decode("utf-8", "replace"))
        return name, url, section, "ok", t
    except urllib.error.HTTPError as e:
        return name, url, section, "BLOCKED" if e.code in (401, 403, 429, 503) else f"HTTP {e.code}", ""
    except Exception as e:
        return name, url, section, f"ERROR {type(e).__name__}", ""


def signals(t):
    opens = sorted({m.group().lower() for m in OPEN.finditer(t)})
    closes = sorted({m.group().lower() for m in CLOSED.finditer(t)})
    dates = []
    for m in DATE.finditer(t):
        y = re.search(r"(\d{2,4})$", m.group())
        year = int(y.group(1)) if y else 0
        if (year + 2000 if year < 100 else year) < datetime.date.today().year:
            continue  # last cycle's deadline, a blog date, a changelog
        ctx = t[max(0, m.start() - 80): m.end() + 20]
        if DUE.search(ctx):
            dates.append(re.sub(r"\s+", " ", ctx).strip())
        if len(dates) >= 3:
            break
    return opens, closes, dates


try:
    old = json.load(open(STATE, encoding="utf-8"))
except (OSError, ValueError):
    old = {}
items = rows()
t0 = time.time()
res = []
with cf.ThreadPoolExecutor(8) as ex:
    futs = [ex.submit(fetch, i) for i in items]
    try:
        for f in cf.as_completed(futs, timeout=DEADLINE):
            res.append(f.result())
    except cf.TimeoutError:
        print(f"★ stopped at the {DEADLINE}s deadline; {len(items) - len(res)} pages not checked")

now = datetime.date.today().isoformat()
new_state = dict(old)
groups = {"CHANGED": [], "NEW PAGE": [], "UNCHANGED": [], "BLOCKED": [], "FAILED": []}
for name, url, section, status, t in sorted(res, key=lambda r: (r[2], r[0])):
    prev = old.get(url, {})
    if status != "ok":
        groups["BLOCKED" if status == "BLOCKED" else "FAILED"].append((name, url, status, prev.get("checked", "never"), None))
        continue
    # Fingerprint the words, not the markup, so rotating ads and tokens do not read as a change.
    fp = hashlib.sha256(re.sub(r"\d{1,2}:\d{2}|\b\d{6,}\b", "", t).encode()).hexdigest()[:16]
    sig = signals(t)
    key = "NEW PAGE" if not prev else ("CHANGED" if prev.get("fp") != fp else "UNCHANGED")
    groups[key].append((name, url, status, prev.get("changed", now), sig))
    new_state[url] = {"fp": fp, "checked": now, "changed": now if key != "UNCHANGED" else prev.get("changed", now)}

print(f"funders {len(items)}  checked {len(res)}  {time.time() - t0:.0f}s")
for g in ("CHANGED", "NEW PAGE", "UNCHANGED", "BLOCKED", "FAILED"):
    if not groups[g]:
        continue
    print(f"\n== {g} ({len(groups[g])})")
    for name, url, status, when, sig in groups[g]:
        if sig is None:
            print(f"{name}\t{url}\t{status}\tlast fetched: {when}")
            continue
        opens, closes, dates = sig
        hint = ("OPEN? " + "; ".join(opens) if opens else "") + ("  CLOSED? " + "; ".join(closes) if closes else "")
        print(f"{name}\t{url}\t{hint.strip() or 'no open/closed wording'}" + (f"\tlast change: {when}" if g == "UNCHANGED" else ""))
        if g != "UNCHANGED":
            for d in dates:
                print(f"    date near deadline wording: ...{d}...")
if not dry:
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(new_state, open(STATE, "w", encoding="utf-8"), indent=1)
