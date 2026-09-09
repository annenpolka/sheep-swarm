import type { Action } from "./write-skew.ts";

// Frozen exhaustive schedules for A-read<A-commit and B-read<B-commit.
export const schedules = [
  ["A:read", "A:commit", "B:read", "B:commit"],
  ["A:read", "B:read", "A:commit", "B:commit"],
  ["A:read", "B:read", "B:commit", "A:commit"],
  ["B:read", "B:commit", "A:read", "A:commit"],
  ["B:read", "A:read", "B:commit", "A:commit"],
  ["B:read", "A:read", "A:commit", "B:commit"],
] as const satisfies readonly (readonly Action[])[];
