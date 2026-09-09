/** A finite reference model, independent of the future production kernel. */
export type Worker = "A" | "B";
export type Action = `${Worker}:${"read" | "commit"}`;
export type CheckMode = "write-set" | "read-set";
type Key = "x" | "y";
type State = Record<Key, number>;

export interface TraceStep {
  readonly action: Action;
  readonly outcome: "read" | "committed" | "not-needed" | "stale";
  readonly value: Readonly<State>;
}

export function simulate(schedule: readonly Action[], mode: CheckMode) {
  const value: State = { x: 1, y: 1 };
  const revision: State = { x: 0, y: 0 };
  const proposals: Partial<Record<Worker, { base: State; wantsWrite: boolean }>> = {};
  const trace: TraceStep[] = [];

  for (const action of schedule) {
    const who: Worker = action.startsWith("A:") ? "A" : "B";
    const own: Key = who === "A" ? "x" : "y";
    const other: Key = own === "x" ? "y" : "x";
    let outcome: TraceStep["outcome"];
    if (action.endsWith(":read")) {
      proposals[who] = { base: { ...revision }, wantsWrite: value[other] === 1 };
      outcome = "read";
    } else {
      const proposal = proposals[who];
      if (!proposal) throw new Error(`Commit without read: ${action}`);
      const checked: readonly Key[] = mode === "read-set" ? ["x", "y"] : [own];
      if (!proposal.wantsWrite) {
        outcome = "not-needed";
      } else if (!checked.every((key) => revision[key] === proposal.base[key])) {
        outcome = "stale";
      } else {
        value[own] = 0;
        revision[own] += 1;
        outcome = "committed";
      }
    }
    trace.push({ action, outcome, value: { ...value } });
  }
  return { final: { ...value }, invariant: value.x + value.y >= 1, trace };
}
