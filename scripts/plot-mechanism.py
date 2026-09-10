#!/usr/bin/env python3
"""Plot a sanitized mechanism summary; never read raw experiment transcripts.

Usage: python scripts/plot-mechanism.py SUMMARY.json OUTPUT.png [OUTPUT.svg]
Dots are individual runs. Red crosses are failed/incomplete runs, never successful speeds.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D


FAMILIES = ("static", "semantic", "staged")
FAMILY_LABELS = {"static": "Static changes", "semantic": "Semantic dependencies", "staged": "Staged updates"}
METHODS = ("sheep", "single-luna", "single-astra", "no-memory", "no-upper")
GREEN = "#16804a"
RED = "#c43f43"
INK = "#243444"
MUTED = "#58677a"


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def category(row):
    return (row["method"], row["workers"], row["concurrency"])


def category_order(key):
    return (METHODS.index(key[0]), key[1], key[2])


def category_label(key):
    method, workers, concurrency = key
    if method == "sheep":
        return f"Sheep N={workers}, C={concurrency}"
    if method == "single-luna":
        return "Single Luna (C=1)"
    if method == "single-astra":
        return "Single Astra (C=1)"
    if method == "no-memory":
        return f"No memory N={workers}, C={concurrency}"
    return f"No upper N={workers}, C={concurrency}"


def metric(row, name):
    if name == "time":
        duration = row.get("durationMs")
        return (duration / 1000, None, True) if finite(duration) else (None, None, False)
    interval = (row.get("accounting") or {}).get("codexCredits")
    if not isinstance(interval, dict) or not finite(interval.get("lower")):
        return None, None, False
    upper = interval.get("upper")
    return interval["lower"], upper if finite(upper) else None, interval.get("exact") is True


def short_reason(row):
    reason = row.get("completionReason")
    if reason in ("credit-admission-limit", "budget-admission-limit"):
        return "budget stop"
    if reason in ("call-limit", "attempt-limit"):
        return "attempt/call stop"
    if reason in ("final-quality-failed", "stage-quality-failure"):
        return "quality failed"
    if reason in ("context-boundary", "model-context-boundary"):
        return "boundary failed"
    return "failed/incomplete"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("png", type=Path)
    parser.add_argument("svg", type=Path, nargs="?")
    args = parser.parse_args()
    report = json.loads(args.input.read_text())
    comparison = report.get("kind") == "mechanism-registered-worker-comparison"
    if report.get("kind") not in ("mechanism-summary", "mechanism-registered-worker-comparison") or not isinstance(report.get("rows"), list):
        raise ValueError("Expected sanitized mechanism-summary JSON")
    rows = report["rows"]
    for row in rows:
        if row.get("family") not in FAMILIES or row.get("method") not in METHODS:
            raise ValueError("Unknown family or method")
        if not all(isinstance(row.get(key), int) and row[key] > 0 for key in ("workers", "concurrency")):
            raise ValueError("Expected positive N/C")
    omitted = sum(row.get("integrity") == "not-run" for row in rows)
    observed = [row for row in rows if row.get("integrity") != "not-run"]
    success_count = sum(row.get("success") is True and row.get("integrity") == "verified" for row in observed)
    groups = sorted({row["groups"] for row in rows if isinstance(row.get("groups"), int)})
    group_text = "/".join(map(str, groups)) if groups else "unknown"
    primary = report.get("mode") == "main"
    followup = report.get("mode") == "scaling-followup"
    shown_families = tuple(family for family in FAMILIES if any(row["family"] == family for row in observed)) or FAMILIES

    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 10, "axes.labelcolor": INK,
        "text.color": INK, "xtick.color": MUTED, "ytick.color": INK,
        "axes.edgecolor": "#cdd4dd", "savefig.facecolor": "white", "figure.facecolor": "white",
        "svg.fonttype": "none",
    })
    height = 3.0 + 2.8 * len(shown_families)
    fig, axes = plt.subplots(len(shown_families), 2, figsize=(14, height),
                             squeeze=False, gridspec_kw={"hspace": 0.42, "wspace": 0.48})
    fig.subplots_adjust(left=0.205, right=0.955, top=1 - 1.85 / height, bottom=1.40 / height)
    title = "Luna swarm: scaling follow-up" if followup else "Luna swarm: mechanism experiment" if primary else "Luna swarm: development pilot"
    fig.suptitle(title, x=0.04, y=1 - 0.22 / height, ha="left", fontsize=22, fontweight="bold")
    subtitle = (f"{success_count}/{len(observed)} selected Sheep runs passed | {group_text} domain(s), 6 operations/domain | C=8"
                if comparison else f"{success_count}/{len(observed)} recorded conditions passed | {group_text} domain(s), 6 operations/domain | Not-run conditions omitted: {omitted}")
    fig.text(0.04, 1 - 0.72 / height, subtitle, fontsize=11, color=MUTED)
    legend = [Line2D([], [], marker="o", linestyle="none", color=GREEN, markersize=7, label="Passed run"),
                        Line2D([], [], marker="x", linestyle="none", color=RED, markersize=8, markeredgewidth=2,
                               label="Failed / incomplete run (time until stop)")]
    fig.legend(handles=legend[:1] if comparison and success_count == len(observed) else legend,
               loc="upper left", bbox_to_anchor=(0.035, 1 - 1.02 / height), ncol=2, frameon=False, fontsize=10)
    axes[0, 0].set_title("Standard credit equivalent", loc="left", fontsize=13, pad=15, fontweight="bold")
    axes[0, 1].set_title("Elapsed seconds / time until stop", loc="left", fontsize=13, pad=15, fontweight="bold")

    for family_index, family in enumerate(shown_families):
        family_rows = [row for row in observed if row["family"] == family]
        categories = sorted({category(row) for row in family_rows}, key=category_order)
        if not categories:
            for ax in axes[family_index]:
                ax.text(0.5, 0.5, "No executed conditions", ha="center", va="center", transform=ax.transAxes, color=MUTED)
                ax.set_xticks([])
                ax.set_yticks([])
            axes[family_index, 0].set_ylabel(FAMILY_LABELS[family], labelpad=24, fontsize=12, fontweight="bold")
            continue
        counts = Counter(category(row) for row in family_rows)
        labels = [f"{category_label(key)}  [n={counts[key]}]" for key in categories]
        if comparison:
            labels = [f"{category_label(key)}  [Astra={next(row['upperCalls'] for row in family_rows if category(row) == key)}, n={counts[key]}]" for key in categories]
        for column, name in enumerate(("credit", "time")):
            ax = axes[family_index, column]
            ax.set_yticks(range(len(categories)), labels)
            ax.set_ylim(len(categories) - 0.5, -0.5)
            ax.tick_params(axis="y", length=0, pad=8, labelsize=9)
            ax.tick_params(axis="x", labelsize=9)
            ax.grid(axis="x", color="#e5e9ee", linewidth=0.8)
            ax.set_axisbelow(True)
            for side in ("top", "right", "left"):
                ax.spines[side].set_visible(False)
            ax.set_xlabel("Credits (conditional equivalent)" if name == "credit" else "Seconds", fontsize=9, labelpad=5)
            data_values = [metric(row, name)[0] for row in family_rows]
            bound_values = [metric(row, name)[1] for row in family_rows] if name == "credit" else []
            maximum = max([value for value in data_values + bound_values if finite(value)] or [1])
            ax.set_xlim(0, max(maximum * 1.5, 0.05 if name == "credit" else 1))
            for category_index, key in enumerate(categories):
                matches = sorted([row for row in family_rows if category(row) == key], key=lambda row: row.get("replicate", 0))
                for replicate_index, row in enumerate(matches):
                    # Fixed offsets display all replicates; there are no means, intervals or bootstrap claims.
                    offset = (replicate_index - (len(matches) - 1) / 2) * min(0.42, 0.70 / max(len(matches) - 1, 1))
                    y = category_index + offset
                    value, upper, exact = metric(row, name)
                    passed = row.get("success") is True and row.get("integrity") == "verified"
                    color = GREEN if passed else RED
                    if value is None:
                        ax.text(0.015, y, "value unknown", transform=ax.get_yaxis_transform(), va="center", fontsize=8, color=RED)
                        continue
                    ax.scatter([value], [y], s=45 if passed else 60, marker="o" if passed else "x",
                               color=color, linewidths=1.8, zorder=5)
                    prefix = ""
                    if name == "credit" and not exact:
                        if upper is None:
                            prefix = ">="
                        elif upper > value:
                            ax.hlines(y, value, upper, color=color, linewidth=1.2, zorder=3)
                            ax.plot([upper], [y], marker="|", color=color, markersize=7, zorder=3)
                    label = f"{prefix}{value:.3f}" if name == "credit" and value < 1 else f"{prefix}{value:.2f}"
                    if len(matches) > 1:
                        label += f" r{row.get('replicate', replicate_index + 1)}"
                    if not passed and len(matches) == 1:
                        label += f" ({short_reason(row)})"
                    ax.annotate(label, (value, y), xytext=(7, 0), textcoords="offset points", va="center", fontsize=7.7, color=color)
            if column == 0:
                family_heading = "Semantic\ndependencies" if family == "semantic" else FAMILY_LABELS[family]
                ax.text(-0.53, 1.035, family_heading, transform=ax.transAxes, fontsize=12, fontweight="bold", va="bottom")

    concurrency_text = "Sheep N=8/16/32 use C=8; single models use C=1." if primary or followup else "Pilot uses the N/C shown in each category; main Sheep controls use C=8 and single models C=1."
    replicate_counts = Counter((row["family"], category(row)) for row in observed)
    replicate_text = "One replicate per condition; no confidence intervals." if replicate_counts and set(replicate_counts.values()) == {1} else "Each point is one replicate; no confidence intervals."
    footnotes = [concurrency_text,
                 replicate_text + " Red times measure failure/stopping, not successful completion speed.",
                 "Credits use published Standard token rates and observed cache splits; they are not account debits. Cost ranges, if shown, are accounting bounds.",
                 "Not-run conditions have no points. Static/semantic have one stage; staged updates have three stages. Synthetic tasks do not establish emergence."]
    if comparison:
        footnotes = ["N=8 is from the original study; N=16/32 are from the authorized follow-up. Runtime and pricing hashes match.",
                     "One run per N, fixed C=8; timing and cache effects are uncontrolled. No confidence intervals.",
                     "Standard credit equivalents include lower Luna and upper Astra calls; actual account debits are not observed.",
                     "The stopped single-Luna trial and 26 unexecuted planned conditions are retained in the original study report."]
    for index, line in enumerate(footnotes):
        fig.text(0.04, (0.90 - index * 0.22) / height, line, fontsize=8.6, color=MUTED)
    args.png.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.png, dpi=170)
    if args.svg:
        args.svg.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(args.svg)
        args.svg.write_text("\n".join(line.rstrip() for line in args.svg.read_text().splitlines()) + "\n")
    plt.close(fig)
    print(json.dumps({"rows": len(rows), "observed": len(observed), "passed": success_count,
                      "not_run_omitted": omitted, "png": str(args.png), "svg": str(args.svg) if args.svg else None}))


if __name__ == "__main__":
    main()
