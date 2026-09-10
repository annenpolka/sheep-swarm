import {quote} from './pricing.mjs';
import {label} from './label.mjs';
export function summary(units) {
  const total=quote(units);
  return total===null?null:{units,total,label:label(units)};
}
