# Recorded conditional token costs

| Family | Run | Calls | API USD | Codex credit equivalent |
|:---|:---|---:|---:|---:|
| m5-preliminary | comparison-v1/manager-local-none-r1 | 13 | 0.540785 | 13.519633 |
| m5-preliminary | comparison-v1/sheep-fixed-none-r1 | 10 | 0.038442 | 0.961057 |
| m5-preliminary | comparison-v1/sheep-full-none-r1 | 10 | 0.026910 | 0.672761 |
| m5-preliminary | comparison-v1/sheep-full-none-r2 | 8 | 0.016426 | 0.410652 |
| m5-preliminary | comparison-v1/single-upper-none-r1 | 1 | 0.292710 | 7.317750 |
| m5-primary | comparison-v2/manager-local-none-r1 | 13 | 0.710984 | 17.774605 |
| m5-primary | comparison-v2/manager-local-none-r2 | 13 | 0.702132 | 17.553302 |
| m5-primary | comparison-v2/manager-local-rounded-guidance-r1 | 23 | 1.540047 | 38.501164 |
| m5-primary | comparison-v2/sheep-fixed-none-r1 | 10 | 0.021336 | 0.533400 |
| m5-primary | comparison-v2/sheep-fixed-none-r2 | 10 | 0.021887 | 0.547164 |
| m5-primary | comparison-v2/sheep-fixed-rounded-guidance-r1 | 15 | 0.260571 | 6.514278 |
| m5-primary | comparison-v2/sheep-full-none-r1 | 10 | 0.020964 | 0.524111 |
| m5-primary | comparison-v2/sheep-full-none-r2 | 10 | 0.015889 | 0.397234 |
| m5-primary | comparison-v2/sheep-full-rounded-guidance-r1 | 15 | 0.264285 | 6.607125 |
| m5-primary | comparison-v2/single-upper-none-r1 | 1 | 0.291320 | 7.283000 |
| m5-primary | comparison-v2/single-upper-none-r2 | 1 | 0.291320 | 7.283000 |
| m5-primary | comparison-v2/single-upper-rounded-guidance-r1 | 2 | 1.014360 | 25.359000 |
| m4-restart | durable-real-v1/after-commit | 5 | 0.006807 | 0.170180 |
| m4-restart | durable-real-v1/after-intervention | 9 | 0.094387 | 2.359676 |
| m3-pretrial | luna-16-stateful-pilot | 40 | 0.113439 | 2.835979 |
| m2-normal | luna-4-initial | 5 | 0.020336 | 0.508410 |
| m2-fault | luna-4-intervention | 10 | 0.275437 | 6.885918 |
| m5-manager-followup | manager-followup/manager-local-none-r1 | 13 | 0.568634 | 14.215860 |
| m5-manager-followup | manager-followup/manager-local-none-r2 | 13 | 0.567983 | 14.199576 |
| m5-manager-followup | manager-followup/manager-local-rounded-guidance-r1 | 22 | 1.178626 | 29.465640 |
| m3-primary | scaling-v1/n16-c16-s32-none-r1 | 41 | 0.052209 | 1.305219 |
| m3-primary | scaling-v1/n16-c16-s32-none-r2 | 45 | 0.290301 | 7.257536 |
| m3-primary | scaling-v1/n16-c16-s32-rounded-guidance-r1 | 57 | 0.325749 | 8.143731 |
| m3-primary | scaling-v1/n16-c8-s32-none-r1 | 40 | 0.049059 | 1.226481 |
| m3-primary | scaling-v1/n32-c32-s32-none-r1 | 40 | 0.080266 | 2.006660 |
| m3-primary | scaling-v1/n32-c32-s32-none-r2 | 40 | 0.061197 | 1.529925 |
| m3-primary | scaling-v1/n32-c32-s32-rounded-guidance-r1 | 80 | 0.585588 | 14.639706 |
| m3-primary | scaling-v1/n32-c32-s64-none-r1 | 80 | 0.122881 | 3.072013 |
| m3-primary | scaling-v1/n32-c32-s64-none-r2 | 80 | 0.111999 | 2.799974 |
| m3-primary | scaling-v1/n32-c8-s32-none-r1 | 40 | 0.046030 | 1.150751 |
| m3-primary | scaling-v1/n8-c8-s16-none-r1 | 20 | 0.033567 | 0.839173 |
| m3-primary | scaling-v1/n8-c8-s16-none-r2 | 20 | 0.030710 | 0.767750 |
| m3-primary | scaling-v1/n8-c8-s32-none-r1 | 40 | 0.058160 | 1.453995 |
| m3-primary | scaling-v1/n8-c8-s32-none-r2 | 40 | 0.047851 | 1.196271 |
| m3-primary | scaling-v1/n8-c8-s32-rounded-guidance-r1 | 49 | 0.311199 | 7.779974 |

- Standard speed; ordinary per-request context. Receipt turn totals are not individual API requests.
- API USD is hypothetical API pricing, not an invoice for ChatGPT-authenticated Codex.
- Codex credits are token-rate equivalents, not measured debit from the account's included usage or purchased credits.
- Input includes cached reads and cache writes; output includes reasoning. Components are not charged twice.
- Unknown usage or applicable prices produce bounds; a null upper bound is unknown, not unlimited actual cost.
- Tool charges, subscriptions, taxes, development calls, and human work are outside this estimate.
