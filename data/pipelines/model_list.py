#!/usr/bin/env python3
"""
Model list — our own names for the models the index scores.

The upstream MII file names models the way its sources did, and that is not
one name per car:

  case and brand prefix   "Volkswagen Tiguan", "VOLKSWAGEN TIGUAN" and
                          "TIGUAN" are three models
  listing counters        Bring a Trailer numbers repeat titles in the URL
                          ("…-mustang-903"); untagged listings carry that
                          counter into the model name, so "MUSTANG 903" is a
                          model of one sale
  word order              "AMG G63" and "G63 AMG"
  renamed groups          Bring a Trailer renamed some groups mid-stream, so
                          "996 Turbo" and "996 911 Turbo" are the same car

Each duplicate is a separate row every month, and because the site credits a
model with every Bring a Trailer lot filed under its name, a duplicate counts
the same lots twice.

This script writes data/models.csv: every source name, the one name we use for
it, why, and a flag where the name is not a single car. The browser merges a
month's duplicate rows before scoring (mii-normalize.js), and the collectors
measure each model once (signal_lib.load_universe). Judgment calls — two
Bring a Trailer groups that are the same car, a flag — go in
data/model_overrides.csv and win over the rules.

Flags:
  replica    a replica or tribute, not the car
  catch-all  a bare nameplate from untagged listings ("MUSTANG") that mixes
             generations which have their own groups; scored, but never an
             index constituent

Run: python3 data/pipelines/model_list.py [--csv PATH]
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib  # noqa: E402

MODELS_PATH = os.path.join(lib.DATA_DIR, "models.csv")
OVERRIDES_PATH = os.path.join(lib.DATA_DIR, "model_overrides.csv")
FIELDS = ["manufacturer", "source_model", "model", "rule", "flag", "auctions"]

# Brands that appear under more than one name across the sources (mirrors
# MAKE_ALIASES in app.js): the MII file keeps Datsun-era cars under Nissan.
MAKE_ALIASES = {"datsun": "nissan"}

_YEAR_SUFFIX = re.compile(r"\s*\(\d{4}-\d{4}\)$")


def canonical_make(make):
    m = (make or "").strip().lower()
    return MAKE_ALIASES.get(m, m)


def _prefixes(make):
    canon = canonical_make(make)
    return [canon] + [alias for alias, c in MAKE_ALIASES.items() if c == canon]


def model_key(make, model):
    """The comparison key for a make/model pair: case-folded, any leading
    brand word and trailing "(1969-1973)" removed, spaces collapsed.

    Mirrors MII.modelKey in mii-normalize.js; both sides of every join use it.
    """
    m = re.sub(r"\s+", " ", (model or "").strip())
    for prefix in _prefixes(make):
        if m.lower().startswith(prefix + " "):
            m = m[len(prefix) + 1:]
            break
    m = _YEAR_SUFFIX.sub("", m).strip().lower()
    return canonical_make(make) + "|" + m


def is_upper(name):
    """All capitals with a real word in them ("MUSTANG 903", "SL55 AMG"): an
    untagged listing's title rather than a Bring a Trailer group. A short code
    ("R8", "Z3", "300E") has no lowercase either, but is a group name."""
    return bool(re.search(r"[A-Z]{3}", name)) and not re.search(r"[a-z]", name)


def _tokens(key):
    return sorted(key.partition("|")[2].split())


def strip_counter(make, key, known):
    """Drop a trailing listing counter ("mustang 903", "cl55 amg cabriolet 7 2")
    when what is left is a model we already know. Returns the key unchanged
    otherwise, so a real number ("911", "2002") is never touched."""
    head, _, model = key.partition("|")
    tokens = model.split(" ")
    best = key
    while len(tokens) > 1 and tokens[-1].isdigit():
        tokens = tokens[:-1]
        candidate = head + "|" + " ".join(tokens)
        if candidate in known:
            best = candidate
    return best


def load_overrides(path=OVERRIDES_PATH):
    """{(make_key, source_key): {"model": str, "flag": str}}."""
    out = {}
    for r in lib.read_rows(path):
        man = (r.get("manufacturer") or "").strip()
        src = (r.get("source_model") or "").strip()
        if not man or not src or man.startswith("#"):
            continue
        out[model_key(man, src)] = {"model": (r.get("model") or "").strip(),
                                    "flag": (r.get("flag") or "").strip()}
    return out


def build(universe, overrides=None):
    """Map every source name in `universe` (load_universe(raw=True) records)
    to one model name. Returns rows for data/models.csv."""
    overrides = overrides or {}
    auctions = {}
    for rec in universe:
        k = (rec["manufacturer"], rec["model"])
        auctions[k] = auctions.get(k, 0) + int(rec.get("auction_count") or 0)
    names = sorted(auctions)

    known = {model_key(m, n) for m, n in names}
    group = {}   # (make, source) -> group key
    rule = {}
    for man, src in names:
        k = model_key(man, src)
        group[(man, src)], rule[(man, src)] = k, "same"
        if is_upper(src):
            stripped = strip_counter(man, k, known)
            if stripped != k:
                group[(man, src)], rule[(man, src)] = stripped, "listing counter"

    # Untagged titles that only reorder a known name's words.
    by_tokens = {}
    for (man, src), k in group.items():
        head, _, model = k.partition("|")
        by_tokens.setdefault(head + "|" + " ".join(sorted(model.split())), set()).add(k)
    reorder = {}
    for keys in by_tokens.values():
        if len(keys) > 1:
            target = min(keys)
            for k in keys:
                if k != target:
                    reorder[k] = target
    for name, k in list(group.items()):
        if k in reorder and is_upper(name[1]):
            group[name], rule[name] = reorder[k], "word order"

    # Manual overrides: a source name pointed at another group's name.
    for name in names:
        o = overrides.get(model_key(*name))
        if o and o["model"]:
            group[name], rule[name] = model_key(name[0], o["model"]), "override"

    # One display name per group: a Bring a Trailer group name (mixed case)
    # before an untagged title, then the most auctions.
    members = {}
    for name, k in group.items():
        members.setdefault(k, []).append(name)
    display = {}
    for k, ms in members.items():
        ms.sort(key=lambda n: (is_upper(n[1]), -auctions[n], n[1]))
        display[k] = ms[0][1]
    for name in names:
        o = overrides.get(model_key(*name))
        if o and o["model"]:
            display[group[name]] = o["model"]

    # Flags.
    mixed_words = {}
    for (man, src) in names:
        if not is_upper(src):
            head, _, model = model_key(man, src).partition("|")
            for w in set(re.findall(r"[a-z0-9]+", model)):
                mixed_words.setdefault((head, w), set()).add(model)
    flags = {}
    for k, ms in members.items():
        head, _, model = k.partition("|")
        shown = display[k]
        if "replica" in shown.lower():
            flags[k] = "replica"
        elif is_upper(shown) and " " not in model and len(mixed_words.get((head, model), ())) >= 2:
            flags[k] = "catch-all"
    for name in names:
        o = overrides.get(model_key(*name))
        if o and o["flag"]:
            flags[group[name]] = "" if o["flag"] == "-" else o["flag"]

    rows = []
    for name in names:
        k = group[name]
        rows.append({
            "manufacturer": name[0], "source_model": name[1], "model": display[k],
            "rule": _rule(name, display[k], known, rule[name]),
            "flag": flags.get(k, ""), "auctions": auctions[name],
        })
    rows.sort(key=lambda r: (r["manufacturer"].lower(), r["model"].lower(), r["source_model"]))
    return rows


def _rule(name, shown, known, applied):
    """Why a source name maps to the name shown, in words."""
    man, src = name
    if src == shown:
        return "same"
    if applied == "override":
        return "override"
    k, target = model_key(man, src), model_key(man, shown)
    if k == target:
        return "case or prefix"
    stripped = strip_counter(man, k, known)
    if stripped == target:
        return "listing counter"
    return "word order" if _tokens(stripped) == _tokens(target) else applied


def summary(rows):
    renamed = [r for r in rows if r["source_model"] != r["model"]]
    groups = {(r["manufacturer"], r["model"]) for r in rows}
    by_rule = {}
    for r in renamed:
        by_rule[r["rule"]] = by_rule.get(r["rule"], 0) + 1
    flagged = {}
    for r in rows:
        if r["flag"]:
            flagged.setdefault(r["flag"], set()).add((r["manufacturer"], r["model"]))
    return (f"{len(rows)} source names -> {len(groups)} models; "
            f"{len(renamed)} renamed ({', '.join(f'{v} {k}' for k, v in sorted(by_rule.items()))}); "
            + "; ".join(f"{len(v)} {k}" for k, v in sorted(flagged.items())))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=lib.MII_CSV_URL, help="MII results CSV (URL or path)")
    args = ap.parse_args()
    universe = lib.load_universe(args.csv, raw=True)
    rows = build(universe, load_overrides())
    lib.write_rows(MODELS_PATH, FIELDS, rows)
    print(summary(rows))
    print(f"{MODELS_PATH}: {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
