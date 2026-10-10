"""
The apex rule shared by auction_rating.py and mai.py.

A lot is apex when its apex value is at least APEX_THRESHOLD. The apex value
is the high estimate where the lot has one (the weekly digest's rule: "MAI
tests high_estimate_usd >= 500,000"); otherwise the sold price if it sold;
otherwise there is none and the lot is not apex.

Most lots in auction_lots.csv carry no estimate, so without the sold-price
fallback a sale like RM Monterey scores no apex lots at all. The fallback
only reaches lots that sold, though: an unsold lot with no estimate can never
be apex, so apex sell-through (R) is biased upward wherever lots come in
through it. apex_basis says which rule admitted each lot so the outputs can
report how many came each way.
"""

import math

APEX_THRESHOLD = 500_000

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


def is_apex(lot):
    value = apex_value(lot)
    return value is not None and value >= APEX_THRESHOLD


def add_apex_columns(df):
    """Add apex_value, apex_basis and is_apex columns to a lots DataFrame."""
    records = df.to_dict("records")
    df["apex_basis"] = [apex_basis(r) for r in records]
    df["apex_value"] = [apex_value(r) for r in records]
    df["is_apex"] = [is_apex(r) for r in records]
    return df
