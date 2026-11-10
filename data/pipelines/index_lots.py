#!/usr/bin/env python3
"""
Index lots: every sale of every index car, for index-lots.html.

data/variants.csv names the constituents of six indexes: HAGI Top, F and P,
the BMW CI, the MBCI and MBCI Emerging. Every lot is matched to the index
car it is, if any, with variants.matches on its title: the Bring a Trailer
listing slug where the lot has one (notes "bat:<slug>"), else
"<year> <make> <model>". First match wins; no lot in the data matches two
cars. data/index_lots.csv gets one row per matched lot, from three places:

  scored        the lots behind MAI: live sales (auction_lots.csv) and Bring
                a Trailer's completed months (online_lots.csv), with the
                highlight, share and suspect columns of hagi_top_lots.csv,
                computed the same way (hagi_top.py is this module limited to
                hagi-top, and the two files agree on every HAGI Top lot)
  month to date the current month's closed Bring a Trailer listings, read
                from bat.csv as export_online_sales.py reads it. online_lots
                .csv leaves the month out until it is complete, so these are
                in no file MAI reads: share 0, never a highlight
  upcoming      catalogue lots of sales still to come (upcoming_lots.csv):
                estimates, no result

Columns: those of hagi_top_lots.csv, then

  indexes    the car's indexes, ;-separated: the M1 is hagi-top;bmw-ci
  source     live | bat | bat_month_to_date | upcoming
  sale_date  the day of the sale. For Bring a Trailer, the listing's own day:
             event_date is its month's last day, the sale MAI scores
  title      what the listing calls the car, year and make left off
  url        the listing: Bring a Trailer's, or the auction house's lot page
             where the store has one (lot_url in auction_lots.csv and
             upcoming_lots.csv)
  race       whether the title says it is a competition car (RACE): a Group
             A 635CSi is still a 635CSi and counts as one, and the page marks
             it

Three BMW CI constituents that span price tiers are split by model in
variants.csv ("635CSi & M635CSi" is a 635CSi row and an M635CSi & M6 row,
each naming HAGI's constituent in part_of), so a median and a suspect flag
are a model's own.

suspect: a sold price under variants.SUSPECT_SHARE of the car's median, with
at least three prices to take a median of, most likely not the car the title
says. The median is over the scored lots only, so a month-to-date price can't
move a HAGI Top lot's flag; month-to-date prices are judged against it.

Prices: live lots are as the store holds them (export_live_lots.py prefers
the fee-inclusive price_all_in, else the hammer); Bring a Trailer prices are
the hammer without BaT's buyer's fee.

Run after auction_rating.py (the shares need auction_ratings.csv):

  python3 data/pipelines/index_lots.py              # fetches bat.csv
  python3 data/pipelines/index_lots.py --bat PATH   # a local bat.csv
  python3 data/pipelines/index_lots.py --no-bat     # no month to date; BaT
                                                    # lots dated by month

If bat.csv can't be read the run warns and leaves index_lots.csv as it is.
"""

import argparse
import csv
import io
import os
import re
import statistics
import sys
import unicodedata
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib  # noqa: E402
import variants as V  # noqa: E402
from apex import make_key  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUTPUT_PATH = os.path.join(DATA, "index_lots.csv")
LOTS_PATH = os.path.join(DATA, "auction_lots.csv")
ONLINE_PATH = os.path.join(DATA, "online_lots.csv")
UPCOMING_PATH = os.path.join(DATA, "upcoming_lots.csv")
RATINGS_PATH = os.path.join(DATA, "auction_ratings.csv")

LOT_COLS = [
    "variant_id", "variant", "event", "event_date", "auction_house", "manufacturer",
    "model", "year_of_car", "sold", "sold_price_usd", "high_estimate_usd",
    "apex_value_usd", "highlight", "share", "suspect",
]
COLS = LOT_COLS + ["indexes", "source", "sale_date", "title", "url", "race"]

SLUG = re.compile(r"\bbat:([^\s;]+)")
BAT_LISTING = "https://bringatrailer.com/listing/{}/"

# A title that says the car is a competition version: built or converted for
# racing or rallying, or run in a named series. "Competition Package" is a
# road-car option.
RACE = re.compile(
    r"\b(race ?car|racecar|racer|race|racing|rally|rallye|competizione|competition(?! pack)|"
    r"group ?[a-c1-6n]|gr ?[a-c1-6n]|procar|gtr|rsr|imsa|dtm|scca|btcc|trans ?am|touring car|"
    r"cup car|hillclimb|ptg)\b")

LIVE, ONLINE, MONTH_TO_DATE, UPCOMING = "live", "bat", "bat_month_to_date", "upcoming"


# ── Titles ───────────────────────────────────────────────────────────────────

def plain(text):
    """Lower case, accents dropped, anything else between words a space:
    'Coupé' reads 'coupe', not 'coup'."""
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def slug_of(lot):
    m = SLUG.search(str(lot.get("notes") or ""))
    return m.group(1) if m else None


def lot_title(lot):
    """The lot as a listing title: '1955 mercedes benz 300 sl gullwing'."""
    slug = slug_of(lot)
    if slug:
        return V.title_of(slug)
    parts = [lot.get("year_of_car"), lot.get("manufacturer"), lot.get("model")]
    text = " ".join(str(p) for p in parts if p is not None and p == p and str(p).strip())
    text = re.sub(r"(\d)\.0\b", r"\1", text)  # a year read as a float
    return plain(text)


SMALL = {"a", "an", "and", "by", "de", "ex", "for", "in", "of", "on", "the", "to", "with"}
UPPER = {"amg", "ce", "cs", "csl", "gt", "gtb", "gtc", "gto", "gts", "ii", "iii", "iv", "lm",
         "lwb", "ptg", "rs", "rsr", "se", "sec", "sel", "sl", "slr", "ss", "ssk", "sv", "swb",
         "tdf", "uk", "us", "v8", "v12"}


def _word(w, prev=""):
    if prev == "cabriolet" and len(w) == 1:
        return w.upper()  # Cabriolet A, B, C, D
    if w in SMALL:
        return w
    if w == "csi":
        return "CSi"
    if w in UPPER:
        return w.upper()
    if re.search(r"\d", w) and re.search(r"[a-z]", w):
        w = w.upper()
        # BMW writes the suffix in lower case: 2002tii, 323i, 850CSi, 850Ci.
        w = re.sub(r"(?<=\d)TII?$", lambda m: m.group(0).lower(), w)
        w = re.sub(r"CSI$", "CSi", w)
        w = re.sub(r"(?<=\d)CI$", "Ci", w)
        return re.sub(r"(?<=\d)I$", "i", w)
    return w.capitalize()


def bat_title(slug, variant, make, year):
    """A Bring a Trailer slug as a title, without its year, its make or the
    counter BaT adds to repeated slugs: '1973-bmw-3-0cs-45-2' -> '3.0 CS'.
    A trailing number goes only while the rest still reads as the car, so
    the 600 of '1966-mercedes-benz-600-8' and the 6.3 of '300sel-6-3' stay."""
    words = V.title_of(slug).split()
    while len(words) > 1 and re.fullmatch(r"\d{1,3}", words[-1]) \
            and V.matches(variant, make, " ".join(words[:-1]), year):
        words.pop()
    if words and re.fullmatch(r"(18|19|20)\d\d", words[0]):
        words.pop(0)
    lead = plain(make).split()
    if words[:len(lead)] == lead:
        words = words[len(lead):]
    # '3 0cs' -> '3.0 cs', '280se 3 5' -> '280se 3.5', '2 5 16' -> '2.5-16'
    out, i = [], 0
    while i < len(words):
        w, nxt = words[i], words[i + 1] if i + 1 < len(words) else ""
        m = re.fullmatch(r"(\d)([a-z]+)", nxt)
        if re.fullmatch(r"\d", w) and (re.fullmatch(r"\d", nxt) or m):
            out.append(f"{w}.{m.group(1) if m else nxt}")
            if m:
                out.append(m.group(2))
            i += 2
            if not m and i < len(words) and words[i] == "16":
                out[-1] += "-16"
                i += 1
            continue
        out.append(w)
        i += 1
    title = " ".join(_word(w, out[i - 1] if i else "") for i, w in enumerate(out))
    return title[:1].upper() + title[1:]


def _text(x):
    return "" if x is None or x != x else " ".join(str(x).split())


# ── Matching ─────────────────────────────────────────────────────────────────

def match(lots, variants=None, index=None):
    """[(variant, lot)] for every lot that is an index car (of `index` only,
    if given); first match wins."""
    variants = variants or V.load_variants()
    if index:
        variants = [v for v in variants if index in v["index_list"]]
    out = []
    for lot in lots:
        title = lot_title(lot)
        year = V.year_of(title, lot.get("year_of_car"))
        for v in variants:
            if V.matches(v, lot.get("manufacturer"), title, year):
                out.append((v, lot))
                break
    return out


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if x == x else None


def _sold(lot):
    v = lot.get("sold")
    return v is True or str(v).strip().lower() in ("true", "1", "yes")


def medians(matched):
    """{variant id: median sold price} where a car has three or more."""
    prices = {}
    for v, lot in matched:
        p = _num(lot.get("sold_price_usd"))
        if _sold(lot) and p:
            prices.setdefault(v["id"], []).append(p)
    return {k: statistics.median(ps) for k, ps in prices.items() if len(ps) >= 3}


def suspects(matched, reference=None):
    """ids of lots sold under SUSPECT_SHARE of their car's median price, the
    median taken over `reference` (default: `matched` itself)."""
    med = medians(matched if reference is None else reference)
    out = set()
    for v, lot in matched:
        p = _num(lot.get("sold_price_usd"))
        if v["id"] in med and _sold(lot) and p and p < V.SUSPECT_SHARE * med[v["id"]]:
            out.add(id(lot))
    return out


def _whole(x):
    n = _num(x)
    return "" if n is None else round(n)


def row(v, lot, share=0.0, highlight=False, suspect=False, source=LIVE, sale_date=None):
    year = _num(lot.get("year_of_car"))
    slug = slug_of(lot)
    title = bat_title(slug, v, lot.get("manufacturer"), V.year_of(V.title_of(slug), year)) if slug \
        else _text(lot.get("model"))
    return {
        "variant_id": v["id"],
        "variant": v["variant"],
        "event": lot.get("event"),
        "event_date": lot.get("event_date"),
        "auction_house": lot.get("auction_house"),
        "manufacturer": lot.get("manufacturer"),
        "model": lot.get("model"),
        "year_of_car": "" if year is None else int(year),
        "sold": "" if source == UPCOMING else ("true" if _sold(lot) else "false"),
        "sold_price_usd": _whole(lot.get("sold_price_usd")),
        "high_estimate_usd": _whole(lot.get("high_estimate_usd")),
        "apex_value_usd": _whole(lot.get("apex_value")),
        "highlight": "true" if highlight else "false",
        "share": f"{share:.6g}",
        "suspect": "true" if suspect else "false",
        "indexes": v["indexes"],
        "source": source,
        "sale_date": sale_date or str(lot.get("event_date") or "")[:10],
        "title": title,
        "url": BAT_LISTING.format(slug) if slug else _text(lot.get("lot_url")),
        "race": "true" if RACE.search(lot_title(lot)) else "false",
    }


def scored_rows(matched, ratings_lookup, highlight_counts, total_rating, sale_dates=None):
    """Rows for the lots MAI scores. A highlight's share is the weight mai.py
    gives it (its sale's auction_rating over the sale's highlight count) over
    the sum of all sales' ratings, so a make's MAI_score is the sum of its
    highlights' shares."""
    odd = suspects(matched)
    out = []
    for v, lot in matched:
        key = (lot.get("event"), lot.get("event_date"))
        highlight = bool(lot.get("is_apex"))
        n = highlight_counts.get(key, 0)
        share = (ratings_lookup.get(key, 0.0) / n / total_rating
                 if highlight and n and total_rating > 0 else 0.0)
        slug = slug_of(lot)
        out.append(row(v, lot, share, highlight, id(lot) in odd, ONLINE if slug else LIVE,
                       (sale_dates or {}).get(slug) if slug else None))
    out.sort(key=lambda r: (r["variant_id"], str(r["event_date"]), str(r["event"])))
    return out


def highlight_counts(records):
    out = {}
    for r in records:
        if r.get("is_apex"):
            key = (r.get("event"), r.get("event_date"))
            out[key] = out.get(key, 0) + 1
    return out


def build(scored, ratings_lookup, total_rating, upcoming=(), month_to_date=(), sale_dates=None,
          variants=None):
    """index_lots rows. `scored`: lot records as mai.py has them after
    add_apex_columns; `upcoming` and `month_to_date`: lot records in the
    upcoming_lots / online_lots schema (month to date with sale_date)."""
    variants = variants or V.load_variants()
    matched = match(scored, variants)
    out = scored_rows(matched, ratings_lookup, highlight_counts(scored), total_rating, sale_dates)
    # Makes spelled as the scored lots spell them ('Mercedes Benz' ->
    # 'Mercedes-Benz'), as apex.read_lots does across its files.
    spelling = {make_key(lot.get("manufacturer")): lot.get("manufacturer") for lot in scored}

    def respell(lots):
        return [{**lot, "manufacturer": spelling.get(make_key(lot.get("manufacturer")), lot.get("manufacturer"))}
                for lot in lots]

    mtd = match(respell(month_to_date), variants)
    odd = suspects(mtd, reference=matched)
    out += [row(v, lot, suspect=id(lot) in odd, source=MONTH_TO_DATE, sale_date=lot.get("sale_date"))
            for v, lot in mtd]
    out += [row(v, lot, source=UPCOMING) for v, lot in match(respell(upcoming), variants)]
    out.sort(key=lambda r: (r["variant_id"], r["sale_date"], str(r["event"]), r["source"]))
    return out


# ── Run ──────────────────────────────────────────────────────────────────────

def scored_lots(lots_path=None, online_path=None):
    """The lots exactly as mai.py prepares them before it scores."""
    import pandas as pd
    from apex import add_apex_columns, read_lots
    lots = read_lots(lots_path or LOTS_PATH, online_path or ONLINE_PATH)
    if lots.empty:
        return lots
    lots["sold"] = lots["sold"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    lots["sold_price_usd"] = pd.to_numeric(lots["sold_price_usd"], errors="coerce")
    lots["high_estimate_usd"] = pd.to_numeric(lots["high_estimate_usd"], errors="coerce")
    lots["manufacturer"] = lots["manufacturer"].astype(str).str.strip()
    return add_apex_columns(lots)


def sale_weights(lots, ratings_path=None):
    """(ratings_lookup, total_rating) as mai.py computes them: each sale's
    auction_rating, and their sum over the sales with highlights."""
    import pandas as pd
    ratings_path = ratings_path or RATINGS_PATH
    if lots.empty or not os.path.exists(ratings_path):
        return {}, 0.0
    ratings = pd.read_csv(ratings_path)
    if ratings.empty:
        return {}, 0.0
    lookup = ratings.set_index(["event", "event_date"])["auction_rating"].to_dict()
    total = 0.0
    for key, _ in lots[lots["is_apex"]].groupby(["event", "event_date"]):
        total += lookup.get(key, 0.0)
    return lookup, total


def read_bat(source):
    csv.field_size_limit(10 ** 9)
    if re.match(r"^https?://", source):
        text = lib.http_get(source, timeout=180)
    else:
        with open(source, newline="", encoding="utf-8") as f:
            text = f.read()
    if not text:
        raise OSError("empty or not found")
    return list(csv.DictReader(io.StringIO(text)))


def summary(rows):
    by_index = {}
    for r in rows:
        for i in r["indexes"].split(";"):
            s = by_index.setdefault(i, {"cars": set(), "scored": 0, "mtd": 0, "upcoming": 0})
            s["cars"].add(r["variant_id"])
            s[{"live": "scored", "bat": "scored", MONTH_TO_DATE: "mtd", UPCOMING: "upcoming"}[r["source"]]] += 1
    return by_index


def main(argv=None, today=None, fx=None):
    from export_online_sales import BAT_CSV_URL, month_to_date, sale_dates
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=OUTPUT_PATH)
    ap.add_argument("--bat", default=BAT_CSV_URL, help="bat.csv (URL or path)")
    ap.add_argument("--no-bat", action="store_true",
                    help="skip bat.csv: no month to date, BaT lots dated by month")
    args = ap.parse_args(argv)
    today = today or date.today()

    mtd, dates = [], None
    if not args.no_bat:
        try:
            bat = read_bat(args.bat)
            if fx is None:
                from export_live_lots import EcbRates
                fx = EcbRates()
            mtd, report = month_to_date(bat, today, fx)
            dates = sale_dates(bat, today)
        except Exception as exc:  # noqa: BLE001 — any read or rate failure keeps the last file
            print(f"::warning::Could not read bat.csv ({lib.redact(str(exc))}); "
                  f"{os.path.basename(args.out)} left as it is.")
            return 0
        for cur, n in report["no_rate"].items():
            print(f"  month to date: skipped {n} listing(s), no USD rate for {cur}")

    lots = scored_lots()
    lookup, total = sale_weights(lots)
    records = lots.to_dict("records") if not lots.empty else []
    rows = build(records, lookup, total, upcoming=lib.read_rows(UPCOMING_PATH), month_to_date=mtd,
                 sale_dates=dates)
    lib.write_rows(args.out, COLS, rows)
    print(f"Wrote {len(rows)} index lots to {os.path.basename(args.out)}"
          + ("" if args.no_bat else f" ({len(mtd)} Bring a Trailer listings closed so far this month read)"))
    for index, s in sorted(summary(rows).items()):
        print(f"  {index:<14} {len(s['cars']):3d} cars  {s['scored']:4d} scored lots  "
              f"{s['mtd']:3d} this month on BaT  {s['upcoming']:3d} coming up")
    return 0


if __name__ == "__main__":
    sys.exit(main())
