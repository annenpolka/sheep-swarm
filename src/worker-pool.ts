export interface WorkerRead {
  readonly version: number;
  readonly evidenceEpoch: number;
}

/** Past observations, never an assertion that these notes or versions remain current. */
export interface WorkerMemory {
  readonly target: string;
  readonly note: string;
  readonly outcome: string;
  readonly reads: Readonly<Record<string, WorkerRead>>;
}

export interface WorkerJob {
  readonly target: string;
  readonly neighbors: readonly string[];
}

export interface WorkerAssignment {
  readonly workerId: string;
  readonly target: string;
  readonly memory: readonly WorkerMemory[];
}

export interface WorkerStats {
  readonly id: string;
  readonly assignments: number;
  readonly active: boolean;
  readonly activeTarget: string | null;
  readonly memory: readonly WorkerMemory[];
}

interface Individual {
  id: string;
  assignments: number;
  activeTarget: string | null;
  lastAssignment: number;
  memory: WorkerMemory[];
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

function validMemory(value: WorkerMemory): boolean {
  if (!value || !nonempty(value.target) || typeof value.note !== "string" || !nonempty(value.outcome)
    || typeof value.reads !== "object" || value.reads === null || Array.isArray(value.reads)) return false;
  return Object.entries(value.reads).every(([id, read]) => nonempty(id) && read !== null && typeof read === "object"
    && Number.isSafeInteger(read.version) && read.version >= 0
    && Number.isSafeInteger(read.evidenceEpoch) && read.evidenceEpoch >= 0);
}

/**
 * Stateful individual workers with bounded, private observation histories.
 * Least-used available individuals get first opportunity, preventing affinity from
 * starving the rest of the population. Among equal assignment counts, recent read
 * overlap wins, then the oldest assignment. No teams or artifact roles are fixed.
 */
export class WorkerPool {
  #workers: Individual[];
  #concurrency: number;
  #memoryLimit: number;
  #sequence = 0;

  constructor(options: { readonly workers: number; readonly concurrency: number; readonly memoryLimit?: number }) {
    positiveInteger(options.workers, "workers");
    positiveInteger(options.concurrency, "concurrency");
    if (options.concurrency > options.workers) throw new RangeError("concurrency must not exceed workers");
    const memoryLimit = options.memoryLimit ?? 4;
    if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 0) {
      throw new RangeError("memoryLimit must be a nonnegative integer");
    }
    this.#concurrency = options.concurrency;
    this.#memoryLimit = memoryLimit;
    this.#workers = Array.from({ length: options.workers }, (_, index) => ({
      id: `sheep-${index + 1}`, assignments: 0, activeTarget: null, lastAssignment: 0, memory: [],
    }));
  }

  assign(jobs: readonly WorkerJob[]): WorkerAssignment[] {
    // Validate the complete request before mutating any assignments.
    if (!Array.isArray(jobs) || jobs.some(job => !job || !nonempty(job.target)
      || !Array.isArray(job.neighbors) || !job.neighbors.every(nonempty))) {
      throw new TypeError("jobs must have a nonempty target and an array of nonempty neighbor ids");
    }
    const activeTargets = new Set(this.#workers.flatMap(worker => worker.activeTarget === null ? [] : [worker.activeTarget]));
    const capacity = this.#concurrency - activeTargets.size;
    const assignments: WorkerAssignment[] = [];
    for (const job of jobs) {
      if (assignments.length >= capacity) break;
      if (activeTargets.has(job.target)) continue;
      const neighborhood = new Set([job.target, ...job.neighbors]);
      const affinity = (worker: Individual): number => {
        const previouslyRead = new Set(worker.memory.flatMap(memory => Object.keys(memory.reads)));
        let overlap = 0;
        for (const id of neighborhood) if (previouslyRead.has(id)) overlap++;
        return overlap;
      };
      const available = this.#workers.filter(worker => worker.activeTarget === null);
      available.sort((left, right) => left.assignments - right.assignments
        || affinity(right) - affinity(left)
        || left.lastAssignment - right.lastAssignment);
      const worker = available[0];
      if (!worker) break;
      worker.activeTarget = job.target;
      worker.assignments++;
      worker.lastAssignment = ++this.#sequence;
      activeTargets.add(job.target);
      assignments.push({ workerId: worker.id, target: job.target, memory: structuredClone(worker.memory) });
    }
    return assignments;
  }

  /** A failed attempt also becomes history; its outcome and old read versions remain explicit. */
  finish(workerId: string, observation: WorkerMemory): void {
    const worker = this.#workers.find(item => item.id === workerId);
    if (!worker) throw new Error("unknown worker");
    if (!validMemory(observation)) throw new TypeError("invalid worker observation");
    if (worker.activeTarget === null || worker.activeTarget !== observation.target) {
      throw new Error("observation target does not match the worker's active assignment");
    }
    const memory: WorkerMemory = {
      target: observation.target,
      note: observation.note,
      outcome: observation.outcome,
      reads: Object.fromEntries(Object.entries(observation.reads).map(([id, read]) => [
        id, { version: read.version, evidenceEpoch: read.evidenceEpoch },
      ])),
    };
    if (this.#memoryLimit > 0) {
      worker.memory.push(memory);
      worker.memory = worker.memory.slice(-this.#memoryLimit);
    }
    worker.activeTarget = null;
  }

  stats(): WorkerStats[] {
    return this.#workers.map(worker => ({
      id: worker.id,
      assignments: worker.assignments,
      active: worker.activeTarget !== null,
      activeTarget: worker.activeTarget,
      memory: structuredClone(worker.memory),
    }));
  }
}
