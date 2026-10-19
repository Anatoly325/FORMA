export const VERSION = 'forma-prototype/0.1.0';

export class FormaError extends Error {
  constructor(code, message, at = {}, details = {}) {
    super(message);
    this.diagnostic = { code, message, ...details };
    if (at.id) this.diagnostic.node = at.id;
    if (at.loc) this.diagnostic.location = at.loc;
  }
}
export function fail(code, message, at, details) {
  throw new FormaError(code, message, at, details);
}
export function diagnostic(error) {
  return error instanceof FormaError ? error.diagnostic : {
    code: 'E_HOST', message: error.message || String(error)
  };
}
export function json(value) {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
}
export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
