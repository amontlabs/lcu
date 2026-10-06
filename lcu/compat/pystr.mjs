// str() / repr() of the JSON-model values (pyjson: dict -> Map, int -> BigInt, float -> PyFloat) for the places
// where Python interpolates an arbitrary JSON value into a message (f"... {value}").
import { isInt, PyFloat, reprFloat } from './pyjson.mjs';
import { reprStr } from './pyerr.mjs';

/** str(value) for the f-strings that interpolate JSON-model values. */
export function py_str(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (isInt(v)) return String(v);
  if (v instanceof PyFloat) return reprFloat(v.value);
  if (typeof v === 'number') return reprFloat(v);
  if (Array.isArray(v)) return `[${v.map(py_repr).join(', ')}]`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${py_repr(k)}: ${py_repr(x)}`).join(', ')}}`;
  return String(v);
}

export function py_repr(v) {
  return typeof v === 'string' ? reprStr(v) : py_str(v);
}

/** type(value).__name__ for the JSON/TOML value models (int may be a Number or BigInt; float is a PyFloat). */
export function py_type_name(v) {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'bigint' || typeof v === 'number') return typeof v === 'number' && !Number.isInteger(v) ? 'float' : 'int';
  if (v instanceof PyFloat) return 'float';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map || Object.getPrototypeOf(v) === Object.prototype) return 'dict';
  return v?.constructor?.name ?? 'object';
}

/** The AttributeError Python raises for `value.get(...)` on something that is not a dict. */
export class PyAttributeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AttributeError';
  }
}

export function attribute_error_get(v) {
  return new PyAttributeError(`'${py_type_name(v)}' object has no attribute 'get'`);
}
