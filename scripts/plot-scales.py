"""Render the measured pilot results. Requires matplotlib; does not call models."""
import json
import statistics
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source = Path(sys.argv[1] if len(sys.argv) > 1 else ".sheep/scaling-v1/summary.json")
target = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/results/scaling-v1.svg")
rows = [row for row in json.loads(source.read_text())["rows"] if not row["pilot"]]
ns = [8, 16, 32]
fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), layout="constrained")
fig.set_facecolor("#fbfcfe")

for label, color, select in [
    ("Fixed work: 32 consumers, C=N", "#1766a6", lambda row, n: row["size"] == 32 and row["concurrency"] == n),
    ("Scaled work: 2N consumers, C=N", "#b57016", lambda row, n: row["size"] == 2*n and row["concurrency"] == n),
    ("Fixed concurrency: 32 consumers, C=8", "#537663", lambda row, n: row["size"] == 32 and row["concurrency"] == 8),
]:
    values = [[row["durationMs"]/1000 for row in rows if row["workers"] == n and row["fault"] == "none" and select(row, n)] for n in ns]
    centers = [statistics.mean(value) for value in values]
    errors = [[center-min(value) for center, value in zip(centers, values)], [max(value)-center for center, value in zip(centers, values)]]
    axes[0].errorbar(ns, centers, yerr=errors, marker="o", capsize=4, color=color, label=label, linewidth=1.8)
axes[0].set(title="Elapsed time: observed means and ranges", xlabel="Registered workers N", ylabel="Seconds", xticks=ns, ylim=(0, 95))
axes[0].legend(loc="lower right", fontsize=8, frameon=False)
axes[0].text(0.03, 0.97, "N=16 includes an adapter error in one trial.\nTwo trials per point; C=8 controls at N=16/32: one.", transform=axes[0].transAxes, va="top", fontsize=8, color="#444444")

faults = [next(row for row in rows if row["workers"] == n and row["fault"] == "rounded-guidance") for n in ns]
adapter = [sum(item["recoveredTransportMisclassified"] for item in row["usageRestorations"]) for row in faults]
semantic = [row["failedWorkerAttempts"]-count for row, count in zip(faults, adapter)]
positions = range(3)
axes[1].bar(positions, semantic, color="#cc6b53", label="Fixed oracle rejects rounded values")
axes[1].bar(positions, adapter, bottom=semantic, color="#858d9a", label="Adapter rejects recovered transport")
for index, row in enumerate(faults):
    axes[1].text(index, row["failedWorkerAttempts"]+0.8, str(row["failedWorkerAttempts"]), ha="center", fontsize=10)
axes[1].set(title="Extra worker attempts with incorrect guidance", xlabel="Registered workers N (C=N)", ylabel="Extra calls beyond 40 committed targets",
            xticks=list(positions), xticklabels=ns, ylim=(0, 46))
axes[1].legend(loc="upper left", fontsize=8, frameon=False)
for axis in axes:
    axis.spines[["top", "right"]].set_visible(False)
    axis.grid(axis="y", alpha=0.15)
    axis.set_axisbelow(True)
fig.suptitle("Luna swarm: an initial synthetic scale experiment", fontsize=14)
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, metadata={"Description": "Exploratory measurements; ranges are not confidence intervals. Original failed attempts remain included."})
if target.suffix == ".svg":
    target.write_text("\n".join(line.rstrip() for line in target.read_text().splitlines()) + "\n")
fig.savefig(target.with_suffix(".png"), dpi=170)
print(f"Rendered {target}; matplotlib {matplotlib.__version__}")
