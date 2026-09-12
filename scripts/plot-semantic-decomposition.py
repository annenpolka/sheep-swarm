"""Plot the frozen semantic pilot; failures have elapsed time but no completion."""
import json, sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
report = json.load(open(sys.argv[1]))
cases = sorted(report['profile']['cases'], key=lambda c: (c['targetCount'], c['family']))
rows = {(r['id'], r['method']): r for r in report['rows']}
colors = {'single':'#555b65', 'fixed-all':'#2875b9', 'planned':'#c25a20'}
fig, axes = plt.subplots(1, 2, figsize=(13, 11), gridspec_kw={'width_ratios':[1.6,1]}, sharey=True)
for i, c in enumerate(cases):
    y = len(cases)-1-i
    for j, (method, color) in enumerate(colors.items()):
        r = rows[(c['id'], method)]
        axes[0].scatter(r['elapsedMs']/1000, y+(j-1)*.19, color=color, marker='o' if r['success'] else 'x', s=32)
    r = rows[(c['id'],'planned')]
    axes[1].barh(y, c['targetCount'], color='#e3e7eb', height=.62)
    axes[1].barh(y, r['plannedWritableCount'] or 0, color=colors['planned'], height=.38)
    axes[1].scatter(r['changedTargetCount'], y, color='#17222c', marker='|', s=90)
    if r['proposedPacketCount'] is not None:
        axes[1].text(c['targetCount']+.7, y, str(r['proposedPacketCount']), va='center', fontsize=8)
axes[0].set_yticks(range(len(cases)), [f"{c['targetCount']:2d}  {c['id'].replace('syn-','')}" for c in reversed(cases)])
axes[0].set_xlabel('Elapsed seconds (planner and retries included)')
axes[0].set_title('Completion time; x = failed / unavailable')
axes[0].legend(handles=[Line2D([0],[0],marker='o',linestyle='',color=color,label=m) for m,color in colors.items()],loc='upper right')
axes[1].set_xlabel('Target files')
axes[1].set_title('Planned writable scope; number = proposed packets')
axes[1].set_xlim(0,37)
axes[1].legend(handles=[Line2D([0],[0],lw=6,color='#e3e7eb',label='All targets'),Line2D([0],[0],lw=6,color=colors['planned'],label='Writable'),Line2D([0],[0],marker='|',linestyle='',color='#17222c',label='Actually changed')],loc='upper right')
for ax in axes:
    ax.grid(axis='x',alpha=.18); ax.set_axisbelow(True)
    ax.spines[['top','right']].set_visible(False)
fig.suptitle('DeepSeek Flash: semantic decomposition, 24 frozen dev tasks', fontsize=15)
fig.text(.02,.015,'Single / fixed-all / planned, thinking enabled, upper 0. One repetition. Exploratory dev comparison; independent audit excluded.',fontsize=9)
fig.tight_layout(rect=(0,.035,1,.965))
for ext in ['png','svg']:fig.savefig(sys.argv[2]+'.'+ext,dpi=150)

# Matplotlib emits line-end spaces inside SVG paths; keep repository diffs clean.
svg = Path(sys.argv[2]+'.svg')
svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
