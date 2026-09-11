"""Paired completion ratios by target count; equivalent aliases are not comparisons."""
import json
import math
import sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

report = json.loads(Path(sys.argv[1]).read_text())
prefix = sys.argv[2]
methods = ['packet-all', 'packet-8', 'packet-4', 'packet-2', 'packet-1']
sizes = ['4', '8', '16', '32']
fig, axes = plt.subplots(1, 2, figsize=(12, 5.3), layout='constrained')
for ax, reference in zip(axes, ['legacy-single', 'packet-all']):
    values = np.full((len(sizes), len(methods)), np.nan)
    annotations = {}
    for i, size in enumerate(sizes):
        for j, method in enumerate(methods):
            pair = report['summary']['targetCount'].get(size, {}).get('pairs', {}).get(reference, {}).get(method)
            if pair and pair['medianReferenceOverMethod'] is not None:
                ratio = pair['medianReferenceOverMethod']
                values[i, j] = math.log2(ratio)
                annotations[i, j] = f'{ratio:.2f}x\nn={pair["bothSuccess"]}'
    cmap = plt.get_cmap('RdYlBu').copy()
    cmap.set_bad('#e5e7eb')
    im = ax.imshow(values, cmap=cmap, vmin=-2, vmax=2, aspect='auto')
    for i in range(len(sizes)):
        for j in range(len(methods)):
            ax.text(j, i, annotations.get((i, j), '--'), ha='center', va='center', fontsize=10)
    ax.set_xticks(range(len(methods)), [x.replace('packet-', '') for x in methods])
    ax.set_yticks(range(len(sizes)), sizes)
    ax.set(xlabel='Packet size', ylabel='Targets', title=f'Reference: {reference}')
cbar = fig.colorbar(im, ax=axes, shrink=.8, ticks=[-2, -1, 0, 1, 2])
cbar.ax.set_yticklabels(['0.25x', '0.5x', '1x', '2x', '4x'])
cbar.set_label('Reference time / packet time (color clipped at 0.25x and 4x)')
status = 'COMPLETE' if report['complete'] else 'PARTIAL'
fig.suptitle(f'DeepSeek Flash thinking | dev packet sweep | {status}\n'
             f'{report["completedRuns"]}/{report["plannedRuns"]} physical runs; one trial per condition', fontsize=14)
fig.supxlabel('Both accepted pairs only. Red: reference faster; blue: packet faster. '
              'Gray: no distinct accepted pair.\nEquivalent aliases excluded. n is paired tasks; family variants are correlated. No task deadline.', fontsize=9)
for suffix in ['png', 'svg']:
    path = Path(prefix + '.' + suffix)
    fig.savefig(path, dpi=170, facecolor='white')
    if suffix == 'svg':
        path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
plt.close(fig)
