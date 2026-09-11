import {assemble} from './common.ts';
import type {Built, Family, TaskMeta} from './common.ts';
import {f1} from './families/f1-scalars.ts';
import {f2} from './families/f2-collections.ts';
import {f3} from './families/f3-text.ts';
import {f4} from './families/f4-state.ts';

const families: readonly Family[] = [...f1, ...f2, ...f3, ...f4];
const variantsPerFamily = 16;

/** Each call returns fresh data; callers cannot mutate the generator's registry. */
export function listSyntheticTasks(): readonly TaskMeta[] {
  return families.flatMap((family, index) =>
    Array.from({length: variantsPerFamily}, (_, variant) => assemble(family, index, variant).metadata));
}

export function buildSyntheticTask(id: string): Built {
  const match = /^syn-(.+)-v(\d{2})$/.exec(id);
  const familyIndex = families.findIndex(f => f.name === match?.[1]);
  const variant = Number(match?.[2]);
  if (!match || familyIndex < 0 || !Number.isInteger(variant) || variant < 0 || variant >= variantsPerFamily) {
    throw new Error(`unknown synthetic task ID: ${id}`);
  }
  return assemble(families[familyIndex]!, familyIndex, variant);
}
