import { schedules } from "./schedules.ts";
import { simulate } from "./write-skew.ts";

console.log(JSON.stringify({
  scope: "finite-reference-model-only",
  scenarios: schedules.map((schedule) => ({
    schedule,
    writeSetOnly: simulate(schedule, "write-set"),
    allObservedReads: simulate(schedule, "read-set"),
  })),
  summary: {
    schedules: schedules.length,
    writeSetOnlyViolations: schedules.filter((s) => !simulate(s, "write-set").invariant).length,
    allObservedReadsViolations: schedules.filter((s) => !simulate(s, "read-set").invariant).length,
  },
}, null, 2));
