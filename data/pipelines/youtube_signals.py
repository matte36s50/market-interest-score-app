#!/usr/bin/env python3
"""
YouTube Signals Pipeline — video attention per model, per month, measured on a
curated list of enthusiast channels.

Feeds two different things from one pass:

  yt_view_share   the MII's YouTube input (weight 0.10): the model's share, in
                  percent, of every view on the tracked channels' videos
                  published in the 12 months ending that month
  yt_videos       a sub-signal of the *social* composite: the count of new
                  videos about the model (docs/social-score-methodology.md)

Deliberately different facets — attention versus supply of new content — so
the social score and the YouTube input never double-count each other.

WHY CHANNELS, NOT SEARCH. The previous collector ran one search.list per
model. Search is YouTube's expensive call (100 units, and a project-level cap
on searches per day), and after two months of daily runs it had measured 18 of
~3,200 models: the project's key gets about one search a day. Reading channels
needs no search at all. A channel's uploads playlist pages at 1 unit per 50
videos and their statistics cost 1 unit per 50, so every tracked upload in the
window costs a few hundred units, the whole universe is measured on every run,
and a model the channels did not cover is a measured zero rather than a gap.
It is also the measure the Utility Dividend framework names for network size:
view counts on top enthusiast channels.

CHANNELS. data/youtube_channels.csv (handle, name, focus). Auction houses and
marketplaces are deliberately absent: their uploads promote listings, they are
not independent attention. Each run looks every handle up (1 unit), skips a
channel whose title does not contain the expected name — so a mistyped or
reassigned handle is reported, never counted — and records what it found in
data/youtube_channels_state.csv.

MATCHING. A video counts toward a model when its title names it (descriptions
are full of links and sponsor reads, so they are not used):

  - Every word of the model's name must appear, in any order. Hyphens and
    spacing are forgiven ("MX-5", "MX5" and "MX 5" are the same word).
  - "a/b/c" in a name means any one of them ("E90/E92/E93 M3"); "x / y" and
    "x & y" are alternative names for the same model.
  - A year range in the name ("F-Series 1973-1979", "Camaro (1st Generation –
    1967-1969)") requires a year in that range in the title. Other words in
    brackets are qualifiers and are ignored.
  - The make must appear too, unless the title has a word that only this make
    uses in the universe and that is either a code with a digit ("E46",
    "R107", "L405") or a famous nameplate on the NAMEPLATES list ("Corvette",
    "Countach"). Plain numbers ("911", "2002"), shared words ("Spider") and
    model names that are also ordinary words ("Legend", "Expedition") never
    stand alone.
  - Names in data/search_phrases.csv (shared with the other collectors) are
    used in place of the raw name, so "Ford A" is matched as "Model A".
  - When a title fits several models of the same make, the most specific wins:
    "Corvette Z06" goes to CORVETTE Z06 rather than CORVETTE, and "1967
    Mustang" to Mustang 1967-1968 rather than MUSTANG. Different cars in one
    title ("986 Boxster vs 996 911") each count.
  - data/youtube_aliases.csv adds other names a model goes by on YouTube
    ("560SL" for the R107 SL), matched by the same rules.

WHY A TRAILING SHARE. View counts keep growing after a video is published, and
the browser ranks every month's values together, so raw views would score
older months higher just for being older. Dividing by the total views of every
tracked video in the same window makes months comparable: each window's videos
have the same mix of ages for every model in it.

The window is the 12 months ending at each month, not the month alone. The
first live run found videos for only ~5% of car model-months in any single
month, which made the input an on/off switch: a car gained ~5 MII points the
month a video went up and lost them the next. Over 12 months a featured car
keeps its credit while the attention lasts, and the input moves smoothly.
yt_videos and yt_views stay monthly (new videos that month, and their views):
the social composite counts new supply, not accumulated attention.

Shorts are excluded (three minutes or less): YouTube counts every replay of a
Short as a view, which would swamp long-form views.

CARS ONLY. The channels cover cars, so only models whose vehicle_class is
'car' are matched and scored. Motorcycles, boats, tractors, ATVs and RVs get
no rows at all: a zero from channels that never cover them would mark them
down, so they keep the input missing and their weights renormalize.

A run that cannot read at least 75% of the channels (and at least ten) writes
nothing, so a partial read never replaces a full one: shares from a subset of
the channels would not be comparable with the last full run. A handle that
does not exist or names a different channel is a configuration problem, not a
read failure, so it is reported and left out of that count.

Usage:
  export YOUTUBE_API_KEY=...
  python data/pipelines/youtube_signals.py              # full run, ~1,000 units
  python data/pipelines/youtube_signals.py --limit 2    # smoke test; writes no signals
"""

import argparse
import math
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import signal_lib as lib  # noqa: E402

API = "https://www.googleapis.com/youtube/v3"
OUTPUT_PATH = os.path.join(lib.DATA_DIR, "youtube_signals.csv")
STATE_PATH = os.path.join(lib.DATA_DIR, "youtube_state.csv")
CHANNELS_PATH = os.path.join(lib.DATA_DIR, "youtube_channels.csv")
CHANNEL_STATE_PATH = os.path.join(lib.DATA_DIR, "youtube_channels_state.csv")
ALIASES_PATH = os.path.join(lib.DATA_DIR, "youtube_aliases.csv")

FIELDS = [
    "manufacturer", "model", "month",
    "yt_videos", "yt_views", "yt_views_12m", "yt_view_share",
    "yt_likes", "yt_comments", "yt_engagement_rate", "measured_at",
]
CHANNEL_FIELDS = [
    "handle", "name", "channel_id", "title", "subscribers",
    "videos_in_window", "videos_matched", "status", "note", "measured_at",
]

PAGE = 50                  # items per playlistItems / videos call, 1 unit each
SHORTS_MAX_SECONDS = 180   # Shorts run up to three minutes
MIN_CHANNEL_SHARE = 0.75   # of the reachable channels, read in full, before writing
MIN_CHANNELS = 10          # and never fewer than this
MAX_PAGES = 80             # per channel per run (4,000 uploads): a runaway guard
TRAILING_MONTHS = 12       # the MII input's window, ending at each month


class BudgetSpent(Exception):
    """The run's unit budget would be exceeded by the next call."""


class Quota:
    """Counts units and refuses a call that would overrun the run's budget."""

    def __init__(self, budget):
        self.budget = budget
        self.spent = 0

    def charge(self, units):
        # Charge before the call: a request that fails has still been made.
        if self.spent + units > self.budget:
            raise BudgetSpent(f"budget of {self.budget} units reached")
        self.spent += units


def yt_get(path, params, api_key):
    """One YouTube Data API call. Raises QuotaExhausted on a quota refusal."""
    params = dict(params)
    params["key"] = api_key
    url = f"{API}/{path}?" + urllib.parse.urlencode(params)
    try:
        return lib.http_get_json(url, retries=3, timeout=30)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        if "quotaExceeded" in body or "dailyLimitExceeded" in body:
            raise lib.QuotaExhausted(
                "YouTube daily quota exhausted — rerun tomorrow")
        if exc.code in (400, 403, 404):
            reason = body[:300] or str(exc)
            raise RuntimeError(lib.redact(f"YouTube API {exc.code}: {reason}"))
        raise


# --------------------------------------------------------------------------
# Channels
# --------------------------------------------------------------------------

def load_channels(path=CHANNELS_PATH):
    out = []
    for r in lib.read_rows(path):
        handle = (r.get("handle") or "").strip()
        if not handle or handle.startswith("#"):
            continue
        out.append({
            "handle": handle if handle.startswith("@") else "@" + handle,
            "name": (r.get("name") or "").strip(),
            "focus": (r.get("focus") or "").strip(),
        })
    return out


def _squash(text):
    return re.sub(r"[^a-z0-9]", "", normalize(text).replace("&", "and"))


def name_matches(expected, title):
    """The channel's title contains the name we expect, ignoring spacing and
    punctuation: "The Smoking Tire" is the channel titled "TheSmokingTire",
    "Road & Track" the one titled "RoadandTrack"."""
    want = _squash(expected)
    return bool(want) and want in _squash(title)


def resolve_channel(handle, api_key, quota):
    """{channel_id, title, uploads, subscribers} for a handle, or None."""
    quota.charge(1)
    data = yt_get("channels", {
        "part": "snippet,contentDetails,statistics",
        "forHandle": handle,
    }, api_key) or {}
    items = data.get("items") or []
    if not items:
        return None
    it = items[0]
    return {
        "channel_id": it.get("id", ""),
        "title": (it.get("snippet") or {}).get("title", ""),
        "uploads": ((it.get("contentDetails") or {}).get("relatedPlaylists") or {}).get("uploads", ""),
        "subscribers": (it.get("statistics") or {}).get("subscriberCount", ""),
    }


def list_uploads(playlist_id, since, api_key, quota, max_pages=MAX_PAGES):
    """Uploads published on or after `since` (YYYY-MM-DD), newest first.

    Returns ([(video_id, title, published_at)], complete). The uploads playlist
    runs newest first, so paging stops at the first page that reaches back
    past `since`; `complete` is False only when the page cap cut it short.
    """
    out, token = [], None
    for _ in range(max_pages):
        params = {"part": "snippet,contentDetails", "playlistId": playlist_id,
                  "maxResults": PAGE}
        if token:
            params["pageToken"] = token
        quota.charge(1)
        data = yt_get("playlistItems", params, api_key) or {}
        oldest = None
        for it in data.get("items", []):
            details = it.get("contentDetails") or {}
            vid = details.get("videoId")
            # Private and deleted uploads carry no videoPublishedAt.
            published = details.get("videoPublishedAt")
            if not vid or not published:
                continue
            day = published[:10]
            oldest = day if oldest is None or day < oldest else oldest
            if day >= since:
                out.append((vid, (it.get("snippet") or {}).get("title", ""), published))
        token = data.get("nextPageToken")
        if not token or (oldest is not None and oldest < since):
            return out, True
    return out, False


def video_details(video_ids, api_key, quota):
    """{video_id: item} with statistics and duration, 50 ids per call."""
    out = {}
    for i in range(0, len(video_ids), PAGE):
        quota.charge(1)
        data = yt_get("videos", {
            "part": "statistics,contentDetails",
            "id": ",".join(video_ids[i:i + PAGE]),
            "maxResults": PAGE,
        }, api_key) or {}
        for it in data.get("items", []):
            out[it.get("id")] = it
    return out


_DURATION = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def duration_seconds(iso):
    """Seconds in an ISO-8601 duration ('PT12M3S'); 0 when unparseable."""
    m = _DURATION.match(iso or "")
    if not m:
        return 0
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


def _count(stats, key):
    try:
        return int(stats.get(key, 0) or 0)
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------------
# Matching titles to models
# --------------------------------------------------------------------------

# Words that name a body style, trim or generation rather than a car. They can
# be part of a model's name, but never identify it on their own.
GENERIC = {
    "coupe", "convertible", "roadster", "spider", "spyder", "sedan", "saloon",
    "wagon", "estate", "cabriolet", "cabrio", "hardtop", "fastback",
    "hatchback", "targa", "touring", "sport", "sports", "super", "special",
    "deluxe", "custom", "classic", "limited", "edition", "series", "class",
    "model", "standard", "base", "turbo", "pickup", "truck", "van", "bus",
    "competition", "club", "racing", "race", "rally", "street", "road",
    "track", "performance", "signature", "premium", "luxury", "grand",
    "generation", "gen", "spec", "euro", "door", "body", "new", "old",
    "convertable", "speedster", "shooting", "brake", "motorcycle", "bike",
}
STOP = {"the", "and", "of", "with", "for", "on", "in"}
# One-word nameplates famous enough to be named without the make ("Corvette
# vs 911"). Everything else needs its make, or a code with a digit in it,
# because so many model names are also ordinary words: Legend, Expedition,
# Spirit, Journey, Defender. A word here still has to be used by one make
# only in the universe.
NAMEPLATES = {
    "corvette", "camaro", "chevelle", "corvair", "mustang", "thunderbird",
    "bronco", "miata", "countach", "diablo", "murcielago", "gallardo",
    "huracan", "aventador", "testarossa", "boxster", "cayman", "wrangler",
    "supra", "skyline", "viper", "firebird", "beetle", "vanagon",
    "westfalia", "esprit", "elise", "exige", "veyron", "chiron", "laferrari",
    "celica", "integra", "eldorado", "cutlass", "panamera", "landcruiser",
}
MAKE_FILLER = {"land", "motor", "motors", "cars", "car", "company",
               "automobiles", "automobili", "de", "the"}
MAKE_ALIASES = {
    "Chevrolet": ["chevy"], "Volkswagen": ["vw"],
    "Mercedes-Benz": ["mercedes", "benz"], "Alfa Romeo": ["alfa"],
    "Aston Martin": ["aston"], "Harley-Davidson": ["harley"],
    "Rolls-Royce": ["rolls"], "Austin-Healey": ["healey"],
    "Land Rover": ["landrover"], "De Tomaso": ["detomaso"],
}

_WORD = re.compile(r"[a-z0-9]+(?:[./-][a-z0-9]+)*")
_YEAR_RANGE = re.compile(r"\b((?:18|19|20)\d{2})\s*[-/]\s*((?:18|19|20)?\d{2})\b")
_OPEN_YEAR = re.compile(r"\b((?:19|20)\d{2})\s*(?:\+|-\s*(?=\)))")
_TRAILING_YEAR = re.compile(r"\b((?:18|19|20)\d{2})\s*$")
_PARENS = re.compile(r"\([^)]*\)")
_TITLE_YEAR = re.compile(r"^(?:18|19|20)\d{2}$")


def normalize(text):
    """Lowercase ASCII: accents dropped, apostrophes removed, dashes unified."""
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.lower().replace("’", "").replace("'", "")
    return re.sub(r"[‐-―]", "-", t)


def _pieces(word):
    """'f-150' → ['f', '150']; '3.2' stays one piece."""
    return [p for p in re.split(r"[-/]", word) if p]


def title_terms(title):
    """(terms, words, years) for a video title.

    terms holds every word, every hyphenated word joined up, and every pair of
    neighbouring words joined up, so 'MX-5', 'MX5' and 'MX 5' all yield 'mx5'.
    """
    words = []
    terms = set()
    for w in _WORD.findall(normalize(title)):
        parts = _pieces(w)
        words.extend(parts)
        terms.update(parts)
        if len(parts) > 1:
            terms.add("".join(parts))
    for a, b in zip(words, words[1:]):
        terms.add(a + b)
    years = {int(w) for w in words if _TITLE_YEAR.match(w)}
    return terms, words, years


def make_terms(manufacturer):
    words = [p for w in _WORD.findall(normalize(manufacturer)) for p in _pieces(w)]
    out = {w for w in words if w not in MAKE_FILLER and len(w) > 1}
    if len(words) > 1:
        out.add("".join(words))
    out.update(MAKE_ALIASES.get(manufacturer, []))
    return out


def _parse_years(text):
    """(years or None, text without them). '2019+' runs to the present."""
    m = _YEAR_RANGE.search(text)
    if m:
        lo, hi_raw = int(m.group(1)), m.group(2)
        hi = int(hi_raw) if len(hi_raw) == 4 else int(str(lo)[:2] + hi_raw)
        if 1885 <= lo <= hi <= lo + 40:
            return (lo, hi), text[:m.start()] + " " + text[m.end():]
    m = _OPEN_YEAR.search(text)
    if m:
        return (int(m.group(1)), date.today().year + 1), text[:m.start()] + " " + text[m.end():]
    return None, text


def _groups(part, make_t, has_years):
    """Required word groups for one name: each group needs any one of its terms."""
    groups, words, codes = [], [], []
    for w in _WORD.findall(part):
        code = False
        if "/" in w:
            alts = [a for a in w.split("/") if a]
            if all(len(a) <= 1 for a in alts):
                group = {"".join(alts)}            # "c/k" is one name
            else:
                # A lone letter in "T/V/W-Series" would match any title.
                group = {"".join(_pieces(a)) for a in alts if len(a) > 1}
                code = True
        else:
            group = {"".join(_pieces(w))}
        group = frozenset(g for g in group if g and g not in make_t and g not in STOP)
        if not group:
            continue
        if code:
            codes.append(group)
        else:
            groups.append(group)
            words.extend(sorted(group)[:1])
    # Chassis codes like "U13/U14/U15" are rarely in a title; when a year range
    # already picks the generation out, they are only required if nothing else
    # names the model.
    if codes and (not has_years or not groups):
        groups.extend(codes)
    return groups, words


class Spec:
    """One way of naming one model."""

    __slots__ = ("key", "make", "groups", "years", "words", "weak", "free_terms")

    def __init__(self, key, make, groups, years, words):
        self.key, self.make, self.groups = key, make, groups
        self.years, self.words = years, words
        # A one-letter word ("Model A") is matched as an exact phrase only.
        self.weak = any(len(t) <= 1 for g in groups for t in g)
        # Terms that name the model without its make; set once the whole
        # universe is known.
        self.free_terms = frozenset()

    def specificity(self):
        return len(self.groups) + (2 if self.years else 0)


def _names_something(spec_groups):
    """A secondary name needs a real word: "GTV & Spider" must not turn every
    Spider into this model, nor "750 & 850" every 850."""
    return any(len(t) >= 3 and re.search(r"[a-z]", t) and t not in GENERIC
               for g in spec_groups for t in g)


def _is_code(word):
    """A generation or chassis code: letters and digits ('gmt800', '300sl'),
    or numbers joined by a slash ('750/101')."""
    if "/" in word:
        return all(len(a) > 1 for a in word.split("/") if a)
    return bool(re.search(r"\d", word)) and bool(re.search(r"[a-z]", word))


def _share_codes(names):
    """A code at the end of the last name, or the start of the first, belongs
    to every name: "Escalade & EXT GMT800" is the GMT800 Escalade and
    Escalade EXT, and "750/101 Series Giulietta & Giulia" a 750/101 Giulia,
    not today's Giulia."""
    first, last = _WORD.findall(names[0]), _WORD.findall(names[-1])
    out = list(names)
    if len(last) >= 2 and _is_code(last[-1]):
        out = [n if i == len(out) - 1 or last[-1] in _WORD.findall(n) else f"{n} {last[-1]}"
               for i, n in enumerate(out)]
    if len(first) >= 2 and _is_code(first[0]):
        out = [n if i == 0 or first[0] in _WORD.findall(n) else f"{n} {first[0]}"
               for i, n in enumerate(out)]
    return out


def model_specs(manufacturer, model, aliases=(), phrase=None):
    """Specs for a model: its own name (and alternatives), plus any aliases.

    `phrase` is a curated search phrase for the model (search_phrases.csv); it
    replaces the raw name, whose years still apply.
    """
    make_t = make_terms(manufacturer)
    key = (manufacturer, model)
    text = normalize(model)
    years, text = _parse_years(text)
    text = _PARENS.sub(" ", text)
    if years is None:
        m = _TRAILING_YEAR.search(text.strip())
        # A trailing year qualifies a name ("Mustang 1969") unless it IS the
        # name ("2002").
        if m and text.strip()[:m.start()].strip():
            y = int(m.group(1))
            years, text = (y, y), text.strip()[:m.start()]
    names = [p for p in re.split(r"\s+/\s+|&", text) if p.strip()]
    if len(names) > 1:
        names = _share_codes(names)
    if phrase:
        names = [normalize(phrase)]
    specs = []
    for i, name in enumerate(names + [normalize(a) for a in aliases]):
        groups, words = _groups(name, make_t, years is not None)
        if not groups or all(len(t) <= 1 for g in groups for t in g):
            continue    # "Ford T" alone would match any stray letter
        if 0 < i < len(names) and not _names_something(groups):
            continue
        specs.append(Spec(key, manufacturer, groups, years, words))
    return specs


def load_aliases(path=ALIASES_PATH):
    out = {}
    for r in lib.read_rows(path):
        man, mod = (r.get("manufacturer") or "").strip(), (r.get("model") or "").strip()
        alias = (r.get("alias") or "").strip()
        if man and mod and alias:
            out.setdefault((man, mod), []).append(alias)
    return out


def _names_alone(term, makes_using):
    """Can this term name a model without its make in the title?"""
    if len(makes_using.get(term, ())) != 1 or term in GENERIC:
        return False
    has_digit = re.search(r"\d", term) is not None
    has_letter = re.search(r"[a-z]", term) is not None
    return (has_digit and has_letter and len(term) >= 3) or term in NAMEPLATES


def _contains(words, phrase):
    n = len(phrase)
    return any(words[i:i + n] == phrase for i in range(len(words) - n + 1))


class Matcher:
    """Maps a video title to the models it names (see the module docstring)."""

    def __init__(self, universe, aliases=None, phrases=None):
        aliases = aliases or {}
        phrases = lib.load_phrase_overrides() if phrases is None else phrases
        self.specs = []
        for rec in universe:
            key = (rec["manufacturer"], rec["model"])
            self.specs.extend(model_specs(*key, aliases=aliases.get(key, ()),
                                          phrase=phrases.get(key)))
        makes_using = {}
        for s in self.specs:
            for g in s.groups:
                for t in g:
                    makes_using.setdefault(t, set()).add(s.make)
        self.make_terms = {}
        self.index = {}
        for i, s in enumerate(self.specs):
            s.free_terms = frozenset(t for g in s.groups for t in g
                                     if _names_alone(t, makes_using))
            self.make_terms.setdefault(s.make, make_terms(s.make))
            for t in s.groups[0]:
                self.index.setdefault(t, []).append(i)

    def match(self, title):
        """The (manufacturer, model) keys this title names."""
        terms, words, years = title_terms(title)
        hits = {}
        for i in {i for t in terms for i in self.index.get(t, ())}:
            s = self.specs[i]
            if not all(g & terms for g in s.groups):
                continue
            if s.years and not any(s.years[0] <= y <= s.years[1] for y in years):
                continue
            if not (s.free_terms & terms) and not (self.make_terms[s.make] & terms):
                continue
            if s.weak and not _contains(words, s.words):
                continue
            best = hits.get(s.key)
            if best is None or s.specificity() > best.specificity():
                hits[s.key] = s
        # Most specific wins within a make: drop a match whose words are all
        # inside another match's words when that other one says more.
        kept = []
        for s in hits.values():
            words_s = set(s.groups)
            if any(o is not s and o.make == s.make and words_s <= set(o.groups)
                   and o.specificity() > s.specificity() for o in hits.values()):
                continue
            kept.append(s.key)
        return sorted(kept)


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def cars_only(universe, periods):
    """The car models of the universe, and the months the MII scores them."""
    cars = [r for r in universe if (r.get("vehicle_class") or "car") == "car"]
    keys = {(r["manufacturer"], r["model"]) for r in cars}
    return cars, {k: v for k, v in periods.items() if k in keys}


def window_months(periods, today=None):
    """Every month from the earliest the MII covers through the current one."""
    today = today or date.today()
    current = f"{today.year}-{today.month:02d}"
    months = sorted(m for ms in periods.values() for m in ms if m <= current)
    if not months:
        return lib.month_window(12, today) + [current]
    y, m = (int(p) for p in months[0].split("-"))
    out = []
    while f"{y}-{m:02d}" <= current:
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def shift_month(month, k):
    """'2026-01' moved k months (k may be negative)."""
    y, m = (int(p) for p in month.split("-"))
    i = y * 12 + (m - 1) + k
    return f"{i // 12}-{i % 12 + 1:02d}"


def trailing(month):
    """The TRAILING_MONTHS months ending at `month`, newest first."""
    return [shift_month(month, -k) for k in range(TRAILING_MONTHS)]


def fetch_months(months):
    """The output months plus the ones before the first that its trailing
    window reaches back to, oldest first."""
    out, m = [], shift_month(months[0], -(TRAILING_MONTHS - 1))
    while m <= months[-1]:
        out.append(m)
        m = shift_month(m, 1)
    return out


def aggregate(videos, months):
    """Per (manufacturer, model, month) totals, per-month view totals, examples.

    Each video carries the model keys its title matched, in v["keys"].
    """
    month_set = set(months)
    per, totals, examples = {}, {m: 0 for m in months}, {}
    for v in videos:
        if v["month"] not in month_set:
            continue
        totals[v["month"]] += v["views"]
        for key in v["keys"]:
            b = per.setdefault(key + (v["month"],),
                               {"videos": 0, "views": 0, "likes": 0, "comments": 0})
            b["videos"] += 1
            b["views"] += v["views"]
            b["likes"] += v["likes"]
            b["comments"] += v["comments"]
            top = examples.get(key)
            if top is None or v["views"] > top[0]:
                examples[key] = (v["views"], v["title"])
    return per, totals, examples


def build_rows(per, totals, periods, months, now):
    """Rows for the output `months`: every model-month with videos in its
    trailing window, plus a zero for every model-month the MII has results
    for — every car was read, so no videos on the tracked channels is a
    measurement, not a gap.

    `per` and `totals` cover fetch_months(months), so each output month's
    trailing window is complete.
    """
    monthly = {}
    for (man, mod, month), b in per.items():
        monthly.setdefault((man, mod), {})[month] = b
    window_total = {m: sum(totals.get(w, 0) for w in trailing(m)) for m in months}
    keys = set()
    for key, by_month in monthly.items():
        for m in months:
            if any(w in by_month for w in trailing(m)):
                keys.add(key + (m,))
    month_set = set(months)
    for key, ms in periods.items():
        keys.update(key + (m,) for m in ms if m in month_set)
    rows = []
    zero = {"videos": 0, "views": 0, "likes": 0, "comments": 0}
    for man, mod, month in sorted(keys):
        by_month = monthly.get((man, mod), {})
        b = by_month.get(month, zero)
        views_12m = sum(by_month[w]["views"] for w in trailing(month) if w in by_month)
        total = window_total[month]
        rows.append({
            "manufacturer": man, "model": mod, "month": month,
            "yt_videos": b["videos"], "yt_views": b["views"], "yt_views_12m": views_12m,
            "yt_view_share": round(100 * views_12m / total, 6) if total else 0.0,
            "yt_likes": b["likes"], "yt_comments": b["comments"],
            "yt_engagement_rate": round((b["likes"] + b["comments"]) / b["views"], 6)
            if b["views"] else 0.0,
            "measured_at": now,
        })
    return rows


# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------

def read_channel(ch, since, api_key, quota):
    """(videos, state row) for one channel. Raises on quota and budget stops."""
    row = {"handle": ch["handle"], "name": ch["name"], "measured_at": lib.utcnow_iso()}
    info = resolve_channel(ch["handle"], api_key, quota)
    if not info:
        row.update(status="not_found", note="no channel has this handle")
        return [], row
    row.update(channel_id=info["channel_id"], title=info["title"],
               subscribers=info["subscribers"])
    if not name_matches(ch["name"], info["title"]):
        row.update(status="name_mismatch",
                   note=f"expected '{ch['name']}', found '{info['title']}'")
        return [], row
    uploads, complete = list_uploads(info["uploads"], since, api_key, quota)
    details = video_details([u[0] for u in uploads], api_key, quota)
    videos = []
    for vid, title, published in uploads:
        item = details.get(vid)
        if not item:
            continue    # removed or made private since it was listed
        if duration_seconds((item.get("contentDetails") or {}).get("duration")) <= SHORTS_MAX_SECONDS:
            continue
        stats = item.get("statistics") or {}
        videos.append({
            "id": vid, "title": title, "month": lib.month_of(published),
            "views": _count(stats, "viewCount"), "likes": _count(stats, "likeCount"),
            "comments": _count(stats, "commentCount"), "channel": ch["handle"],
        })
    row.update(status="ok" if complete else "truncated",
               videos_in_window=len(videos),
               note="" if complete else f"stopped at {MAX_PAGES} pages")
    return videos, row


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    lib.add_common_args(ap)
    ap.add_argument("--budget", type=int, default=9000,
                    help="API units to spend this run (daily quota is 10,000)")
    ap.add_argument("--api-key", default=os.environ.get("YOUTUBE_API_KEY", ""))
    args = ap.parse_args()

    if not args.api_key:
        print("YOUTUBE_API_KEY is not set — skipping YouTube collection.")
        print("Create a key at https://console.cloud.google.com/apis/credentials "
              "with the YouTube Data API v3 enabled.")
        return 0

    periods = {}
    universe = lib.load_universe(args.csv, min_auctions=args.min_auctions,
                                 periods=periods)
    universe, periods = cars_only(universe, periods)
    months = window_months(periods)
    fetched = fetch_months(months)
    since = fetched[0] + "-01"
    channels = load_channels()
    todo = channels[:args.limit] if args.limit else channels
    matcher = Matcher(universe, load_aliases())
    quota = Quota(args.budget)
    print(f"Universe {len(universe)} car models; {len(todo)} of {len(channels)} "
          f"channels; months {months[0]} to {months[-1]} (videos from {fetched[0]}); "
          f"budget {args.budget} units")

    videos, channel_rows, read = [], [], 0
    for ch in todo:
        try:
            found, row = read_channel(ch, since, args.api_key, quota)
        except (lib.QuotaExhausted, BudgetSpent) as exc:
            channel_rows.append({"handle": ch["handle"], "name": ch["name"],
                                 "status": "stopped", "note": lib.redact(exc),
                                 "measured_at": lib.utcnow_iso()})
            print(f"  {ch['handle']}: stopped — {lib.redact(exc)}")
            break
        except Exception as exc:  # noqa: BLE001 — one bad channel must not end the run
            channel_rows.append({"handle": ch["handle"], "name": ch["name"],
                                 "status": "error", "note": lib.redact(exc),
                                 "measured_at": lib.utcnow_iso()})
            print(f"  [ERROR] {ch['handle']}: {lib.redact(exc)}")
            continue
        if row["status"] in ("ok", "truncated"):
            read += 1
            videos.extend(found)
        print(f"  {ch['handle']}: {row['status']}"
              + (f", {len(found)} videos" if found else "")
              + (f" ({row.get('note')})" if row.get("note") else ""))
        channel_rows.append(row)
        time.sleep(args.sleep)

    for v in videos:
        v["keys"] = matcher.match(v["title"])
    per, totals, examples = aggregate(videos, fetched)
    matched_by_channel = {}
    for v in videos:
        if v["keys"]:
            matched_by_channel[v["channel"]] = matched_by_channel.get(v["channel"], 0) + 1
    for row in channel_rows:
        if row.get("status") in ("ok", "truncated"):
            row["videos_matched"] = matched_by_channel.get(row["handle"], 0)
    lib.upsert(CHANNEL_STATE_PATH, CHANNEL_FIELDS, channel_rows, key=("handle",))

    misconfigured = sum(1 for r in channel_rows if r.get("status") in ("not_found", "name_mismatch"))
    needed = max(MIN_CHANNELS, math.ceil(MIN_CHANNEL_SHARE * (len(todo) - misconfigured)))
    print(f"Read {read}/{len(todo)} channels ({misconfigured} misconfigured), "
          f"{len(videos)} long-form videos, {quota.spent}/{args.budget} units.")
    if args.limit:
        print("Smoke test (--limit): channel state saved, signals not written.")
        return 0
    if read < needed:
        print(f"Fewer than {needed} channels read — shares would not be comparable "
              f"with a full run, so {os.path.basename(OUTPUT_PATH)} is left as it is.")
        return 0

    now = lib.utcnow_iso()
    rows = build_rows(per, totals, periods, months, now)
    lib.write_rows(OUTPUT_PATH, FIELDS, rows)

    counts = {}
    for k, b in per.items():
        counts[k[:2]] = counts.get(k[:2], 0) + b["videos"]
    state = lib.State(STATE_PATH)
    state.rows = {}
    for rec in universe:
        key = (rec["manufacturer"], rec["model"])
        n = counts.get(key, 0)
        if n:
            views, title = examples[key]
            state.mark(*key, "ok", f"{n} videos; top: {title[:120]} ({views:,} views)")
        else:
            state.mark(*key, "empty", "no videos on the tracked channels")
    state.save()

    matched = sum(1 for v in videos if v["month"] in totals and v["keys"])
    covered = len(counts)
    print(f"{matched}/{len(videos)} videos named a model; "
          f"{covered}/{len(universe)} models have at least one.")
    print(f"{OUTPUT_PATH}: {len(rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
