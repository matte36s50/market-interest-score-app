"""
The apex (highlight) rule shared by auction_rating.py and mai.py.

An apex lot is one of the highlights of its sale: the top HIGHLIGHT_PERCENT
of the sale's lots, ranked by apex value, and never more than MAX_HIGHLIGHTS.
The cap only reaches online platforms, whose monthly "sale" runs to
thousands of lots (export_online_sales.py): 10% of a Bring a Trailer month
is over 300 cars down to about $95K, its top 25 the true marquee results. A fixed dollar line can't do this:
$500K is an ordinary lot at Monterey and the top of the sale at Hershey. How
much a sale's highlights are worth is carried instead by the sale's weight in
auction_rating.py (the apex value it takes to be a highlight there).

A sale needs at least MIN_LOTS lots to have highlights; below that, one car
would be 100% of the top of the sale.

The apex value is the high estimate where the lot has one; otherwise the sold
price if it sold; otherwise there is none and the lot can't be ranked. An
unsold lot with no estimate therefore never makes the top of its sale, so
apex sell-through (R) reads high wherever lots are ranked by sold price.
apex_basis says where each lot's value came from so the outputs can report
how many highlights came each way.
"""

import math
import os

HIGHLIGHT_PERCENT = 10
MIN_LOTS = 20
MAX_HIGHLIGHTS = 25

BASIS_ESTIMATE = "estimate"
BASIS_SOLD_PRICE = "sold_price"
BASIS_NONE = "none"


def _amount(value):
    """A positive number, or None for blank, NaN, zero or junk."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 and not math.isnan(n) else None


def _is_sold(value):
    return str(value).strip().lower() in ("true", "1", "yes")


def apex_basis(lot):
    """'estimate', 'sold_price' or 'none': where the lot's apex value comes from."""
    if _amount(lot.get("high_estimate_usd")) is not None:
        return BASIS_ESTIMATE
    if _is_sold(lot.get("sold")) and _amount(lot.get("sold_price_usd")) is not None:
        return BASIS_SOLD_PRICE
    return BASIS_NONE


def apex_value(lot):
    """high_estimate_usd if present, else sold_price_usd if the lot sold, else None."""
    basis = apex_basis(lot)
    if basis == BASIS_ESTIMATE:
        return _amount(lot.get("high_estimate_usd"))
    if basis == BASIS_SOLD_PRICE:
        return _amount(lot.get("sold_price_usd"))
    return None


def highlight_count(total_lots):
    """How many of a sale's lots are its highlights: the top 10%, rounded up,
    at most MAX_HIGHLIGHTS.

    0 for a sale under MIN_LOTS. Integer arithmetic, so 30 lots give 3, not
    ceil(3.0000000000000004) = 4.
    """
    if total_lots < MIN_LOTS:
        return 0
    return min(-(-total_lots * HIGHLIGHT_PERCENT // 100), MAX_HIGHLIGHTS)


def read_lots(*paths):
    """The lot files that exist, as one DataFrame (live sales and online months)."""
    import pandas as pd
    frames = [pd.read_csv(p) for p in paths if os.path.exists(p)]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def add_apex_columns(df, sale=("event", "event_date")):
    """Add apex_basis, apex_value and is_apex columns to a lots DataFrame.

    is_apex marks the top highlight_count(lots in the sale) lots of each sale
    by apex value. Lots without a value are never highlights; ties at the
    cutoff go to the lot listed first.
    """
    records = df.to_dict("records")
    df["apex_basis"] = [apex_basis(r) for r in records]
    df["apex_value"] = [apex_value(r) for r in records]
    df["is_apex"] = False
    for _, group in df.groupby(list(sale), sort=False):
        n = highlight_count(len(group))
        ranked = group["apex_value"].dropna().sort_values(ascending=False, kind="stable")
        df.loc[ranked.index[:n], "is_apex"] = True
    return df
