import { fail } from './diagnostic.mjs';
import { typeName } from './checker.mjs';
import { RecordValue, Runtime } from './runtime.mjs';

export const INTEGER_PATTERN = '^(0|-?[1-9][0-9]*)$';
const integer = new RegExp(INTEGER_PATTERN);
export function decode(value, type, runtime, path = '$', state = { nodes: 0, depth: 0 }) {
  if (++state.nodes > runtime.limits.dataNodes || state.depth > runtime.limits.dataDepth) fail('E_DATA_LIMIT', 'Input structure exceeds the execution profile.', {}, { path });
  runtime.tick({});
  const bad = () => fail('E_INPUT', 'Input does not match the declared type.', {}, { path, expected: typeName(type), actual: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value });
  let result;
  if (type === 'Int') {
    if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
    else if (typeof value === 'string' && value.length <= 1235 && integer.test(value)) result = BigInt(value);
    else { bad(); }
  } else if (type === 'Text') { if (typeof value !== 'string') bad(); result = value; }
  else if (type === 'Bool') { if (typeof value !== 'boolean') bad(); result = value; }
  else if (type === 'Unit') { if (value !== null) bad(); result = null; }
  else {
    state.depth++;
    try {
      if (type?.list) {
        if (!Array.isArray(value)) bad(); runtime.guard(value, {});
        result = value.map((v, i) => decode(v, type.list, runtime, `${path}[${i}]`, state));
      } else {
        const record = runtime.checker.records.get(type);
        if (!record || !value || typeof value !== 'object' || Array.isArray(value)) bad();
        const expected = record.fields.map(f => f.name).sort(), actual = Object.keys(value).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('E_INPUT_FIELDS', 'Input record fields do not match.', {}, { path, expected, actual });
        result = new RecordValue(type, Object.fromEntries(record.fields.map(f => [f.name, decode(value[f.name], f.type, runtime, `${path}.${f.name}`, state)])));
      }
    } finally { state.depth--; }
  }
  return runtime.guard(result, {});
}
export function encode(value, runtime, state = { nodes: 0, depth: 0 }) {
  if (++state.nodes > runtime.limits.dataNodes || state.depth > runtime.limits.dataDepth) fail('E_DATA_LIMIT', 'Output structure exceeds the execution profile.');
  runtime.tick({});
  if (typeof value === 'bigint') return value.toString();
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  state.depth++;
  try {
    if (Array.isArray(value)) return value.map(x => encode(x, runtime, state));
    if (value instanceof RecordValue) return Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, encode(v, runtime, state)]));
    fail('E_OUTPUT', 'Only declared data types can cross the tool boundary.');
  } finally { state.depth--; }
}
export function run(checker, name, input, limits = {}) {
  const def = checker.functions.get(name);
  if (!def?.exported) fail('E_TOOL', `Unknown exported tool: ${name}.`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('E_INPUT', 'Arguments must be an object keyed by parameter names.');
  const expected = def.params.map(p => p.name).sort(), actual = Object.keys(input).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('E_INPUT_FIELDS', 'Tool arguments do not match.', def, { expected, actual });
  const runtime = new Runtime(checker, limits);
  const args = def.params.map(p => decode(input[p.name], p.type, runtime, `$.${p.name}`));
  const output = encode(runtime.invoke({ name }, args, def), runtime);
  return { output, ...runtime.stats(), evidence: { staticTypes: 'checked', contracts: 'guarded', correctness: 'unknown' } };
}
export function schema(checker, type, mode = 'input') {
  const definitions = {};
  const visit = t => {
    if (t === 'Int') return mode === 'output' ? { type: 'string', pattern: INTEGER_PATTERN } : { anyOf: [{ type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, { type: 'string', pattern: INTEGER_PATTERN }] };
    if (t === 'Text') return { type: 'string' };
    if (t === 'Bool') return { type: 'boolean' };
    if (t === 'Unit') return { type: 'null' };
    if (t?.list) return { type: 'array', items: visit(t.list) };
    if (!Object.hasOwn(definitions, t)) {
      Object.defineProperty(definitions, t, { value: {}, writable: true, enumerable: true, configurable: true });
      const fields = checker.records.get(t).fields;
      definitions[t] = { type: 'object', properties: Object.fromEntries(fields.map(f => [f.name, visit(f.type)])), required: fields.map(f => f.name), additionalProperties: false };
    }
    return { $ref: `#/$defs/${t}` };
  };
  const root = visit(type);
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...root, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) };
}
export function describe(checker, name) {
  const def = checker.functions.get(name);
  if (!def?.exported) fail('E_TOOL', `Unknown exported tool: ${name}.`);
  // Build one synthetic record so all parameter references share the same $defs.
  let synthetic = 'FormaArguments';
  while (checker.records.has(synthetic)) synthetic += '_';
  checker.records.set(synthetic, { fields: def.params });
  let inputSchema;
  try { inputSchema = schema(checker, synthetic); } finally { checker.records.delete(synthetic); }
  return { name, params: def.params, returns: def.returns, effects: [], inputSchema, outputSchema: schema(checker, def.returns, 'output'), contracts: { requires: def.requires.length, ensures: def.ensures.length, mode: 'runtime' }, integerEncoding: 'Output Int values are decimal strings; input also accepts safe JSON integers.' };
}
