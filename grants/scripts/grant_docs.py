#!/usr/bin/env python3
"""Checks for grant answers and budgets. Rules live in config/documents.md; this enforces what a
script can see.

  python3 scripts/grant_docs.py lint <answer.md> [--max-words N] [--max-chars N] [--funder "Name"]
      No number, dollar amount or year that is missing from config/answers.md or config/profile.json,
      within the form's limit, no placeholders, no em dashes, no grant-speak.
  python3 scripts/grant_docs.py budget <budget.md> [--max-award N]
      Every amount comes from a budget preset in config/answers.md, and the line items add up to
      the Total line (and stay under the program's maximum when given).

Both exit 1 on any FAIL. The agent fixes the draft and reruns until each exits 0.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Words reviewers name as filler, plus the tells of generated text. Matched case-insensitively on
# word boundaries. Keep in sync with the "Writing style" section of config/answers.example.md.
BANNED = [
    "leverage", "leveraging", "leveraged", "synergy", "synergies", "robust", "innovative",
    "empower", "empowering", "holistic", "impactful", "cutting-edge", "world-class", "game-changer",
    "game changer", "passionate", "delve", "thrilled", "excited to", "i believe", "we believe",
    "best-in-class", "paradigm", "seamless", "seamlessly", "unwavering", "elevate", "pivotal",
    "tapestry", "testament", "landscape", "realm", "foster", "fostering", "navigate", "navigating",
    "journey", "ever-evolving", "in today's", "furthermore", "moreover", "additionally",
    "at the intersection of", "meaningful impact", "proven track record", "commitment to excellence",
    "thank you for your consideration", "thank you for considering", "we are confident",
    "perfect fit", "ideal candidate", "this grant would allow us to take our business to the next level",
    "next level",
]
AI_STRUCTURES = ["serves as", "stands as", "underscores", "more than just", "at its core", "in essence",
                 "not to mention", "a testament", "speaks to"]

NUM_RE = re.compile(r"(?<![\w.])\$?\d[\d,]*(?:\.\d+)?(?:%|x|k|K|M|B|\+)?")
MONEY_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|K|M|million|thousand))?")


def source_text():
    """Every place a fact may come from: the narrative library and the profile."""
    parts = []
    for p in ("config/answers.md", "config/profile.json"):
        f = ROOT / p
        if f.is_file():
            parts.append(f.read_text())
    return "\n".join(parts)


def norm_num(tok):
    return tok.replace(",", "").replace("$", "").rstrip("+").strip().lower()


def money_value(tok):
    t = tok.lower().replace("$", "").replace(",", "").strip()
    mult = 1
    for suf, m in (("million", 1_000_000), ("thousand", 1_000), ("m", 1_000_000), ("k", 1_000)):
        if t.endswith(suf):
            t, mult = t[: -len(suf)].strip(), m
            break
    try:
        return round(float(t) * mult, 2)
    except ValueError:
        return None


def numbers(text):
    return {norm_num(m.group()) for m in NUM_RE.finditer(text)}


def unsourced_numbers(text, source):
    have = numbers(source)
    have_digits = {re.sub(r"[^\d.]", "", n) for n in have}
    have_money = {money_value(m.group()) for m in MONEY_RE.finditer(source)}
    out = []
    for n in sorted(numbers(text)):
        if n in have or re.sub(r"[^\d.]", "", n) in have_digits:
            continue
        out.append(n)
    # "$25,000" and "$25k" are the same claim; accept either spelling when the value is sourced.
    sourced_money = {norm_num(m.group()) for m in MONEY_RE.finditer(text) if money_value(m.group()) in have_money}
    return [n for n in out if n not in sourced_money]


def phrase_hits(text, phrases):
    low = text.lower()
    return [b for b in phrases if re.search(r"(?<![\w-])" + re.escape(b) + r"(?![\w-])", low)]


def report(errs, warns):
    for e in errs:
        print("FAIL  " + e)
    for w in warns:
        print("WARN  " + w)
    if not errs:
        print("OK" + (" (with warnings)" if warns else ""))
    return 1 if errs else 0


def default_max_words():
    try:
        s = json.loads((ROOT / "config/settings.json").read_text())
        return int(s.get("documents", {}).get("narrative_max_words_default", 300))
    except (OSError, ValueError):
        return 300


def lint(path, max_words=None, max_chars=None, funder=""):
    body = Path(path).read_text().strip()
    errs, warns = [], []
    if not body:
        return report(["empty answer"], [])
    n_words = len(body.split())
    n_chars = len(body)
    if max_chars:
        if n_chars > max_chars:
            errs.append(f"{n_chars} characters; the form allows {max_chars} (spaces count)")
        elif n_chars < 0.6 * max_chars:
            warns.append(f"{n_chars} of {max_chars} characters used; a short answer can score low")
    else:
        limit = max_words or default_max_words()
        if n_words > limit:
            errs.append(f"{n_words} words; the limit is {limit}")
        elif max_words and n_words < 0.6 * max_words:
            warns.append(f"{n_words} of {max_words} words used; a short answer can score low")
    if "—" in body or " -- " in body or re.search(r"\s–\s", body):
        errs.append("em dash or dash-as-punctuation; use a comma or a period")
    if re.search(r"\[[^\]]*\]|\{[^}]*\}|TODO|TBD|XXX|lorem ipsum", body, re.I):
        errs.append("placeholder left in the text")
    for h in phrase_hits(body, BANNED):
        errs.append(f"banned phrase: \"{h}\"")
    for h in phrase_hits(body, AI_STRUCTURES):
        warns.append(f"reads as generated: \"{h}\"; say it plainly")
    if re.search(r"(?i)to whom it may concern|dear sir or madam", body):
        errs.append("generic greeting; name the funder or the program officer")
    src = source_text()
    if not src:
        errs.append("config/answers.md and config/profile.json are missing; nothing can be checked")
    else:
        bad = unsourced_numbers(body, src)
        if bad:
            errs.append("numbers not in answers.md or profile.json (a funder will treat these as claims): "
                        + ", ".join(bad))
    if funder and funder.lower() not in body.lower():
        warns.append(f"funder name \"{funder}\" never appears; fine for a short field, odd for a narrative")
    if re.search(r"(?i)\b(will|would) (create|hire|add) \d+", body) and not re.search(r"(?i)project|plan|expect|goal|estimate", body):
        warns.append("a hiring or growth number is stated as certain; label it as the client's projection")
    sents = [s for s in re.split(r"(?<=[.!?])\s+", body) if len(s.split()) > 2]
    if len(sents) >= 4:
        lens = [len(s.split()) for s in sents]
        if max(lens) - min(lens) < 6:
            warns.append("every sentence is about the same length; vary it")
    return report(errs, warns)


def budget(path, max_award=None):
    text = Path(path).read_text()
    errs, warns = [], []
    src = source_text()
    src_money = {money_value(m.group()) for m in MONEY_RE.finditer(src)}
    items, total = [], None
    for line in text.splitlines():
        m = MONEY_RE.search(line)
        if not m or not re.match(r"\s*[-*|]", line):
            continue
        v = money_value(m.group())
        label = re.sub(r"^[\s\-*|]+", "", line.split(m.group())[0]).strip(" :|")
        if re.search(r"(?i)\btotal\b", label):
            total = v
            continue
        items.append((label, v))
        if v not in src_money:
            errs.append(f"\"{label}\" {m.group()} is not in any budget preset in answers.md")
    if not items:
        errs.append("no line items found; write one \"- item: $amount\" line per item")
    if total is None:
        errs.append("no \"- Total: $amount\" line")
    elif items:
        s = round(sum(v for _, v in items if v is not None), 2)
        if abs(s - total) > 0.01:
            errs.append(f"line items add up to ${s:,.2f} but Total says ${total:,.2f}")
        if total not in src_money:
            warns.append(f"Total ${total:,.2f} is not a preset total in answers.md; check it is a whole-line-item trim")
        if max_award and total > max_award:
            errs.append(f"Total ${total:,.2f} is above the program maximum ${max_award:,.2f}")
    return report(errs, warns)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("lint")
    p.add_argument("answer")
    p.add_argument("--max-words", type=int)
    p.add_argument("--max-chars", type=int)
    p.add_argument("--funder", default="")
    p = sub.add_parser("budget")
    p.add_argument("budget")
    p.add_argument("--max-award", type=float)
    a = ap.parse_args()
    if a.cmd == "lint":
        sys.exit(lint(a.answer, a.max_words, a.max_chars, a.funder))
    sys.exit(budget(a.budget, a.max_award))


if __name__ == "__main__":
    main()
