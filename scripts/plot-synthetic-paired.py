"""Plot accepted paired times and quality counts from the audited report."""
import argparse
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

parser = argparse.ArgumentParser()
parser.add_argument('report')
parser.add_argument('output_prefix')
args = parser.parse_args()
report = json.loads(Path(args.report).read_text())
summary = report['summary']['overall']
rows = {}
for row in report['rows']:
    if not row['evidenceErrors']:
        rows.setdefault(row['id'], {})[row['method']] = row
pairs = [(r['single'], r['sheep']) for r in rows.values()
         if set(r) == {'single', 'sheep'} and all(v['success'] for v in r.values())]
assert len(pairs) == summary['bothSuccess']
families = sorted({c['family'] for c in report['profile']['cases']})
colors = {f: plt.get_cmap('tab10')(i) for i, f in enumerate(families)}
markers = {4: 'o', 8: 's', 16: '^', 32: 'D'}
plt.rcParams.update({'font.size': 10, 'axes.spines.top': False, 'axes.spines.right': False,
                     'svg.fonttype': 'none'})
fig = plt.figure(figsize=(12, 7.8), layout='constrained')
grid = fig.add_gridspec(2, 2, height_ratios=[4, 1.15], width_ratios=[1.35, 1])
ax = fig.add_subplot(grid[0, 0])
values = [r['elapsedMs'] / 1000 for pair in pairs for r in pair]
lo, hi = (min(values) * .75, max(values) * 1.3) if values else (1, 100)
assert lo > 0 and math.isfinite(hi)
ax.plot([lo, hi], [lo, hi], '--', color='#89919b', linewidth=1, zorder=0)
for single, sheep in pairs:
    ax.scatter(single['elapsedMs'] / 1000, sheep['elapsedMs'] / 1000,
               color=colors[single['family']], marker=markers[single['targetCount']],
               s=65, alpha=.75, edgecolors='white', linewidths=.5)
ax.set(xscale='log', yscale='log', xlim=(lo, hi), ylim=(lo, hi),
       xlabel='Single completion (seconds, log scale)', ylabel='Sheep completion (seconds, log scale)',
       title=f'Both accepted: {len(pairs)} paired tasks')
ax.set_aspect('equal', adjustable='box')
ax.grid(True, which='both', alpha=.12)
ax.text(.03, .95, 'Single faster', transform=ax.transAxes, va='top', color='#475569')
ax.text(.97, .03, 'Sheep faster', transform=ax.transAxes, ha='right', color='#475569')
quality = fig.add_subplot(grid[0, 1])
counts = [summary[k] for k in ['bothSuccess', 'singleOnlySuccess', 'sheepOnlySuccess', 'neitherSuccess']]
bars = quality.bar(['Both\naccepted', 'Single\nonly', 'Sheep\nonly', 'Neither\naccepted'], counts,
                   color=['#6b859e', '#2563eb', '#d97706', '#ad6363'], width=.65)
quality.bar_label(bars, padding=4)
quality.set(ylim=(0, max(counts + [1]) * 1.18), ylabel='Paired tasks',
            title=f'Quality: {summary["completedPairs"]}/{summary["plannedPairs"]} comparable pairs')
quality.grid(axis='y', alpha=.15)
quality.set_axisbelow(True)
legend = fig.add_subplot(grid[1, :]); legend.axis('off')
family_legend = legend.legend(handles=[Line2D([], [], marker='o', color=colors[f], linestyle='', label=f) for f in families],
                             title='Family', loc='upper left', ncol=4, frameon=False)
legend.add_artist(family_legend)
legend.legend(handles=[Line2D([], [], marker=m, color='#475569', linestyle='', label=str(n)) for n, m in markers.items()],
              title='Targets', loc='upper right', ncol=4, frameon=False)
status = 'COMPLETE' if report['complete'] else 'PARTIAL'
fig.suptitle(f'DeepSeek Flash thinking enabled | Single N1/C1 vs Sheep N16/C4 | {status}', fontsize=15)
fig.supxlabel('One trial per variant. Dev only; no chain topology. No task deadline. '
              'Invalid evidence is excluded from comparisons.', fontsize=9, color='#475569')
for suffix in ['svg', 'png']:
    fig.savefig(args.output_prefix + '.' + suffix, dpi=170, facecolor='white')
    if suffix == 'svg':
        svg_path = Path(args.output_prefix + '.svg')
        svg_path.write_text('\n'.join(line.rstrip() for line in svg_path.read_text().splitlines()) + '\n')
plt.close(fig)
