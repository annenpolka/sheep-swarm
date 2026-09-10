import {quote} from './pricing.mjs';
import {label} from './label.mjs';
export function summary(units) { return `${quote(units)} ${label(units)}`; }
