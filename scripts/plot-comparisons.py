"""Plot the four-method experiment; matplotlib is only needed for this report."""
import json
import statistics
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

source = Path(sys.argv[1] if len(sys.argv) > 1 else ".sheep/comparison-v2/summary.json")
target = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/results/comparison-v2.svg")
report = json.loads(source.read_text())
if not report["complete"] or len(report["rows"]) != 12:
    raise ValueError("The planned comparison has not completed")
methods = ["single-upper", "manager-local", "sheep-fixed", "sheep-full"]
labels = ["Single upper", "Manager local", "Sheep fixed", "Sheep full\n(static discovery)"]
fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), layout="constrained")
for axis, field, title, ylabel in [
    (axes[0], lambda row: row["budget"]["observedTokens"]/1000, "Observed CLI input + output", "Thousand tokens"),
    (axes[1], lambda row: row["times"]["elapsedMs"]/1000, "Elapsed time", "Seconds"),
]:
    for fault, offset, color, name in [("none", -0.19, "#477997", "Normal: mean of two trials"),
                                      ("rounded-guidance", 0.19, "#c27a55", "Incorrect guidance: one trial")]:
        samples = [[field(row) for row in report["rows"] if row["method"] == method and row["fault"] == fault] for method in methods]
        centers = [statistics.mean(sample) for sample in samples]
        error = [[center-min(sample) for center, sample in zip(centers, samples)],
                 [max(sample)-center for center, sample in zip(centers, samples)]]
        bars = axis.bar(np.arange(4)+offset, centers, width=0.36, yerr=error, capsize=3, color=color, label=name)
        failed = [any(not row["success"] for row in report["rows"] if row["method"] == method and row["fault"] == fault) for method in methods]
        for bar, failure in zip(bars, failed):
            if failure:
                bar.set_hatch("///")
        axis.bar_label(bars, labels=[("FAIL\n" if failure else "")+f"{value:.1f}" for failure, value in zip(failed, centers)], fontsize=8, padding=3)
    axis.set(title=title, ylabel=ylabel, xticks=range(4), xticklabels=labels)
    axis.tick_params(axis="x", labelsize=8)
    axis.spines[["top", "right"]].set_visible(False)
    axis.grid(axis="y", alpha=0.15)
    axis.set_axisbelow(True)
    axis.set_ylim(0, axis.get_ylim()[1]*1.2)
    axis.legend(fontsize=8, frameon=False, loc="upper left")
fig.suptitle("A separate synthetic task: same acceptance checks and token cap", fontsize=14)
target.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(target, metadata={"Description": "All roles and retries included. Tokens are not currency cost. Two normal trials and one incorrect-guidance trial per method."})
if target.suffix == ".svg":
    target.write_text("\n".join(line.rstrip() for line in target.read_text().splitlines()) + "\n")
fig.savefig(target.with_suffix(".png"), dpi=170)
print(f"Rendered {target}; matplotlib {matplotlib.__version__}")
