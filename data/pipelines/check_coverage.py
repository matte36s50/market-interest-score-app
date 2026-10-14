#!/usr/bin/env python3
"""
Signal coverage check: fail the signals run when a collector has gone dark.

Every collector exits 0 when it has nothing to do (no secret set, too few
YouTube channels read to write comparable shares, an exhausted quota). That is
right for the collector, since one missing input must not stop the others, but
from outside it looks exactly like a healthy run. Reddit wrote zero rows for
months while every run went green.

This runs as the last step of .github/workflows/signals.yml, after the commit
and the deploy, so a red result costs nothing and is what makes a dark
collector visible. Severity is split on purpose:

  not configured   warning, naming the secret to set (may be deliberate)
  too few models   error: the collector is configured and too little came back
  stale            error: it wrote once and has since stopped
  channel problem  warning: a handle in youtube_channels.csv that no longer
                   resolves, or a channel that failed on its last read

Coverage counts models with a NONZERO value. YouTube writes a zero row for
every car model-month the index scores and Google Trends writes 0 for "no
search volume", so a row count says nothing about whether anything was
measured.

Run: python3 data/pipelines/check_coverage.py
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import signal_lib as lib  # noqa: E402
import youtube_signals  # noqa: E402

# Freshness: Trends and YouTube run daily and stamp measured_at on what they
# write (YouTube rewrites its whole file, so three days means three runs in a
# row wrote nothing). The social composite has no timestamp; it carries the
# last complete month, so it is one month behind when healthy.
SIGNALS = [
    {"name": "Google Trends", "file": "google_trends.csv", "value": "trends_interest",
     "env": (), "min_models": 500, "max_age_days": 7},
    {"name": "YouTube", "file": "youtube_signals.csv", "value": "yt_view_share",
     "env": ("YOUTUBE_API_KEY",), "min_models": 100, "max_age_days": 3},
    {"name": "Reddit", "file": "reddit_signals.csv", "value": "reddit_posts",
     "env": ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET"), "min_models": 50,
     "max_age_days": 7},
    {"name": "Social composite", "file": "social_signals.csv", "value": "social_score",
     "env": (), "min_models": 500, "max_age_months": 2},
]

CHANNEL_MISCONFIGURED = ("not_found", "name_mismatch")
CHANNEL_FAILED = ("error", "stopped", "truncated")


def configured(name, env):
    """True when the secret is set. The workflow passes HAVE_<NAME>=true|false
    so the secret itself never reaches this step; a local run can just export
    the variable."""
    return bool((env.get(name) or "").strip()) or env.get("HAVE_" + name) == "true"


def _number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return 0.0


def _parse_iso(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def measure(path, value):
    """Rows, models with a nonzero value, newest month and newest measured_at."""
    rows = lib.read_rows(path)
    models, latest_month, latest_at = set(), "", None
    for r in rows:
        if _number(r.get(value)) > 0:
            models.add((r.get("manufacturer", ""), r.get("model", "")))
        latest_month = max(latest_month, (r.get("month") or "").strip())
        at = _parse_iso(r.get("measured_at")) if r.get("measured_at") else None
        if at and (latest_at is None or at > latest_at):
            latest_at = at
    return {"exists": os.path.exists(path), "rows": len(rows), "models": len(models),
            "month": latest_month, "measured_at": latest_at}


def months_between(label, now):
    try:
        year, month = (int(x) for x in label.split("-"))
    except ValueError:
        return None
    return (now.year - year) * 12 + now.month - month


def check_signal(s, info, env, now):
    """(level, message) for one signal; level is ok, warning or error."""
    summary = (f"{s['name']}: {info['models']:,} models with a nonzero {s['value']}"
               f" in {info['rows']:,} rows"
               + (f", newest month {info['month']}" if info["month"] else ""))
    missing = [v for v in s["env"] if not configured(v, env)]
    if missing:
        return "warning", (f"{summary}. NOT CONFIGURED: set {' and '.join(missing)} in "
                           "Settings > Secrets and variables > Actions. Until then this "
                           "collector exits at once and its weight is renormalized away.")
    if info["models"] < s["min_models"]:
        why = (f", although {' and '.join(s['env'])} {'are' if len(s['env']) > 1 else 'is'} set"
               if s["env"] else "")
        return "error", f"{summary}. Fewer than {s['min_models']} models{why}."
    if "max_age_days" in s:
        at = info["measured_at"]
        if at is None:
            return "error", f"{summary}. No measured_at on any row."
        days = (now - at).total_seconds() / 86400
        if days > s["max_age_days"]:
            return "error", (f"{summary}. Last written {at:%Y-%m-%d}, {days:.0f} days ago; "
                             "this collector has stopped.")
    if "max_age_months" in s:
        age = months_between(info["month"], now)
        if age is None or age > s["max_age_months"]:
            return "error", f"{summary}. Newest month is too old; this collector has stopped."
    return "ok", summary


def channel_problems(channels_path, state_path):
    """Warnings for channels in youtube_channels.csv whose last read failed."""
    state = {r.get("handle"): r for r in lib.read_rows(state_path)}
    out = []
    for ch in youtube_signals.load_channels(channels_path):
        r = state.get(ch["handle"])
        if r is None:
            out.append(f"YouTube channel {ch['handle']} has not been read yet.")
        elif r.get("status") in CHANNEL_MISCONFIGURED:
            out.append(f"YouTube channel {ch['handle']} ({ch['name']}): {r['status']}, "
                       f"{r.get('note') or 'no detail'}. Fix the handle in "
                       "data/youtube_channels.csv.")
        elif r.get("status") in CHANNEL_FAILED:
            out.append(f"YouTube channel {ch['handle']}: {r['status']} on "
                       f"{(r.get('measured_at') or '')[:10]}, {r.get('note') or 'no detail'}.")
    return out


def check(data_dir=lib.DATA_DIR, env=None, now=None, signals=SIGNALS):
    """[(level, message)] for every signal, then any YouTube channel warnings."""
    env = os.environ if env is None else env
    now = now or datetime.now(timezone.utc)
    results = []
    for s in signals:
        info = measure(os.path.join(data_dir, s["file"]), s["value"])
        results.append(check_signal(s, info, env, now))
        if s["name"] == "YouTube" and all(configured(v, env) for v in s["env"]):
            results.extend(("warning", m) for m in channel_problems(
                os.path.join(data_dir, "youtube_channels.csv"),
                os.path.join(data_dir, "youtube_channels_state.csv")))
    return results


def main():
    results = check()
    actions = os.environ.get("GITHUB_ACTIONS") == "true"
    print("Signal collector coverage\n")
    for level, msg in results:
        if actions and level != "ok":
            print(f"::{level}::{msg}")
        print(f"{level.upper():<9}{msg}")
    errors = sum(1 for level, _ in results if level == "error")
    warnings = sum(1 for level, _ in results if level == "warning")
    print(f"\n{errors} failing, {warnings} warnings")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("### Signal coverage\n\n| | |\n|---|---|\n")
            for level, msg in results:
                mark = {"ok": "ok", "warning": "warning", "error": "**FAIL**"}[level]
                f.write(f"| {mark} | {msg.replace('|', '/')} |\n")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
