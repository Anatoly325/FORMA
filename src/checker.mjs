import { fail, stable } from './diagnostic.mjs';
import { parse, semantic } from './parser.mjs';

export const primitives = new Set(['Int', 'Text', 'Bool', 'Unit']);
export const builtinNames = new Set(['len', 'map', 'filter', 'flat_map', 'all', 'any', 'fold', 'concat', 'unique', 'contains', 'sum', 'range', 'abs', 'text', 'split', 'join', 'trim']);
export const list = t => ({ list: t });
export const fnType = (params, returns) => ({ fn: { params, returns } });
export const equalType = (a, b) => stable(a) === stable(b);
const equatable = t => !t?.fn && (!t?.list || equatable(t.list));
export function typeName(t) {
  if (typeof t === 'string') return t;
  if (t?.list) return `List<${typeName(t.list)}>`;
  if (t?.fn) return `(${t.fn.params.map(typeName).join(', ')}) -> ${typeName(t.fn.returns)}`;
  return '?';
}

export class Checker {
  constructor(program) {
    this.program = program; this.records = new Map(); this.functions = new Map(); this.types = new Map();
  }
  expect(actual, expected, at) {
    if (!equalType(actual, expected)) fail('E_TYPE', 'Type mismatch.', at, { expected: typeName(expected), actual: typeName(actual) });
    return actual;
  }
  validType(t, at) {
    if (typeof t === 'string' && (primitives.has(t) || this.records.has(t))) return;
    if (t?.list) { this.validType(t.list, at); return; }
    fail('E_TYPE_NAME', 'Unknown type.', at, { actual: typeName(t) });
  }
  unique(names, at) {
    const seen = new Set();
    for (const name of names) { if (seen.has(name)) fail('E_DUPLICATE', `Duplicate name: ${name}.`, at); seen.add(name); }
  }
  binding(name, env, at) {
    if (name === 'result' || env.has(name) || this.functions.has(name) || builtinNames.has(name)) fail('E_SHADOW', `Binding ${name} shadows an existing or reserved name.`, at);
    if (!/^[a-z_]/.test(name)) fail('E_NAME', 'Local and function names start with a lowercase letter or underscore.', at);
  }
  check() {
    this.unique(this.program.definitions.map(d => d.name), this.program);
    for (const d of this.program.definitions) {
      if (primitives.has(d.name) || d.name === 'List' || builtinNames.has(d.name) || d.name === 'result') fail('E_NAME', `Reserved name: ${d.name}.`, d);
      if (d.kind === 'record') {
        if (!/^[A-Z]/.test(d.name)) fail('E_NAME', 'Record names start with an uppercase letter.', d);
        this.records.set(d.name, d);
      } else {
        if (!/^[a-z_]/.test(d.name)) fail('E_NAME', 'Function names start with a lowercase letter or underscore.', d);
        this.functions.set(d.name, d);
      }
    }
    for (const d of this.records.values()) {
      this.unique(d.fields.map(f => f.name), d);
      d.fields.forEach(f => this.validType(f.type, d));
    }
    for (const d of this.functions.values()) {
      this.unique(d.params.map(p => p.name), d);
      d.params.forEach(p => this.validType(p.type, d)); this.validType(d.returns, d);
      const env = new Map();
      for (const p of d.params) { this.binding(p.name, env, d); env.set(p.name, p.type); }
      for (const predicate of d.requires) this.infer(predicate, env, 'Bool');
      this.infer(d.body, env, d.returns);
      const post = new Map(env); post.set('result', d.returns);
      for (const predicate of d.ensures) this.infer(predicate, post, 'Bool');
    }
    return this;
  }
  infer(n, env, expected) {
    let t;
    switch (n.kind) {
      case 'literal': t = n.type; break;
      case 'variable': {
        if (env.has(n.name)) t = env.get(n.name);
        else if (this.functions.has(n.name)) {
          const f = this.functions.get(n.name); t = fnType(f.params.map(p => p.type), f.returns);
        } else fail('E_NAME', `Unknown value: ${n.name}.`, n, { hint: 'Inspect the module or use help --json for available builtins.' });
        break;
      }
      case 'list': {
        const element = expected?.list || (n.items.length ? this.infer(n.items[0], env) : undefined);
        if (!element) fail('E_INFER', 'Empty list needs a List<T> context or a let annotation.', n);
        for (const item of n.items) this.infer(item, env, element);
        t = list(element); break;
      }
      case 'construct': {
        const record = this.records.get(n.name);
        if (!record) fail('E_TYPE_NAME', `Unknown record: ${n.name}.`, n);
        this.unique(n.fields.map(f => f.name), n);
        const actual = n.fields.map(f => f.name).sort(), wanted = record.fields.map(f => f.name).sort();
        if (stable(actual) !== stable(wanted)) fail('E_FIELDS', 'Record fields do not match its definition.', n, { expected: wanted, actual });
        for (const f of n.fields) this.infer(f.value, env, record.fields.find(x => x.name === f.name).type);
        t = n.name; break;
      }
      case 'field': {
        const receiver = this.infer(n.value, env), field = this.records.get(receiver)?.fields.find(f => f.name === n.name);
        if (!field) fail('E_FIELD', 'Unknown field on this type.', n, { receiver: typeName(receiver), field: n.name });
        t = field.type; break;
      }
      case 'index': {
        const receiver = this.infer(n.value, env); this.infer(n.index, env, 'Int');
        if (!receiver?.list) fail('E_TYPE', 'Indexing requires a list.', n, { actual: typeName(receiver) });
        t = receiver.list; break;
      }
      case 'unary': t = n.op === '!' ? 'Bool' : 'Int'; this.infer(n.value, env, t); break;
      case 'binary': {
        if (['&&', '||'].includes(n.op)) { this.infer(n.left, env, 'Bool'); this.infer(n.right, env, 'Bool'); t = 'Bool'; }
        else if (['==', '!='].includes(n.op)) {
          const a = this.infer(n.left, env); if (!equatable(a)) fail('E_TYPE', 'Functions cannot be compared.', n);
          this.infer(n.right, env, a); t = 'Bool';
        } else {
          this.infer(n.left, env, 'Int'); this.infer(n.right, env, 'Int');
          t = ['<', '<=', '>', '>='].includes(n.op) ? 'Bool' : 'Int';
        }
        break;
      }
      case 'if': {
        this.infer(n.condition, env, 'Bool'); t = this.infer(n.then, env, expected); this.infer(n.otherwise, env, t); break;
      }
      case 'block': {
        const inner = new Map(env);
        for (const b of n.bindings) {
          this.binding(b.name, inner, b);
          if (b.annotation) this.validType(b.annotation, b);
          const valueType = this.infer(b.value, inner, b.annotation || undefined);
          inner.set(b.name, valueType);
        }
        t = this.infer(n.value, inner, expected); break;
      }
      case 'lambda': {
        if (!expected?.fn) fail('E_INFER', 'A lambda needs a function context, such as map, filter or fold.', n);
        this.arity(n.params.length, expected.fn.params.length, n);
        const inner = new Map(env);
        n.params.forEach((name, i) => { this.binding(name, inner, n); inner.set(name, expected.fn.params[i]); });
        const returns = this.infer(n.body, inner, expected.fn.returns);
        t = fnType(expected.fn.params, returns); break;
      }
      case 'call': {
        if (n.callee.kind === 'variable' && builtinNames.has(n.callee.name)) t = this.builtin(n.callee.name, n.args, env, n);
        else {
          const callee = this.infer(n.callee, env);
          if (!callee?.fn) fail('E_TYPE', 'Value is not callable.', n, { actual: typeName(callee) });
          this.arity(n.args.length, callee.fn.params.length, n);
          n.args.forEach((a, i) => this.infer(a, env, callee.fn.params[i])); t = callee.fn.returns;
        }
        break;
      }
      default: fail('E_AST', `Unknown expression: ${n.kind}.`, n);
    }
    // Callback result inference uses undefined only internally, never in source types.
    if (expected?.fn && expected.fn.returns === undefined) {
      if (!t?.fn) fail('E_TYPE', 'Expected a callback.', n);
      this.arity(t.fn.params.length, expected.fn.params.length, n);
      t.fn.params.forEach((p, i) => this.expect(p, expected.fn.params[i], n));
    } else if (expected !== undefined) this.expect(t, expected, n);
    this.types.set(n.id, t); return t;
  }
  arity(actual, expected, at) { if (actual !== expected) fail('E_ARITY', 'Wrong number of arguments.', at, { expected, actual }); }
  builtin(name, args, env, at) {
    const arities = { len: 1, map: 2, filter: 2, flat_map: 2, all: 2, any: 2, fold: 3, concat: 2, unique: 1, contains: 2, sum: 1, range: 1, abs: 1, text: 1, split: 2, join: 2, trim: 1 };
    this.arity(args.length, arities[name], at);
    const infer = (i, expected) => this.infer(args[i], env, expected);
    if (name === 'range' || name === 'abs') { infer(0, 'Int'); return name === 'range' ? list('Int') : 'Int'; }
    if (name === 'sum') { infer(0, list('Int')); return 'Int'; }
    if (name === 'text') {
      const t = infer(0); if (!['Int', 'Bool', 'Text'].includes(t)) fail('E_TYPE', 'text accepts Int, Bool or Text.', at); return 'Text';
    }
    if (name === 'trim') { infer(0, 'Text'); return 'Text'; }
    if (name === 'split') { infer(0, 'Text'); infer(1, 'Text'); return list('Text'); }
    if (name === 'join') { infer(0, list('Text')); infer(1, 'Text'); return 'Text'; }
    const first = infer(0);
    if (name === 'len' && first === 'Text') return 'Int';
    if (!first?.list) fail('E_TYPE', `${name} requires a list.`, at, { actual: typeName(first) });
    if (name === 'len') return 'Int';
    if (name === 'unique' || name === 'contains') {
      if (!equatable(first.list)) fail('E_TYPE', 'Functions cannot be compared.', at);
      if (name === 'contains') { infer(1, first.list); return 'Bool'; }
      return first;
    }
    if (name === 'concat') { infer(1, first); return first; }
    if (name === 'fold') {
      const initial = infer(1); infer(2, fnType([initial, first.list], initial)); return initial;
    }
    const returns = ['filter', 'all', 'any'].includes(name) ? 'Bool' : undefined;
    const callback = infer(1, fnType([first.list], returns));
    if (name === 'filter') return first;
    if (name === 'all' || name === 'any') return 'Bool';
    if (name === 'flat_map') {
      if (!callback.fn.returns?.list) fail('E_TYPE', 'flat_map callback must return a list.', at);
      return callback.fn.returns;
    }
    return list(callback.fn.returns);
  }
}

export function compile(source) { return new Checker(parse(source)).check(); }
export function checkProgram(program) { return new Checker(program).check(); }
export function inspect(checker, name) {
  const def = checker.functions.get(name) || checker.records.get(name);
  if (!def) fail('E_NAME', `Unknown definition: ${name}.`);
  const dependencies = new Set();
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (v.kind === 'variable' && checker.functions.has(v.name)) dependencies.add(v.name);
    Object.values(v).forEach(x => Array.isArray(x) ? x.forEach(walk) : walk(x));
  };
  walk(def);
  return { symbol: name, node: def.id, definition: semantic(def), dependencies: [...dependencies].sort(), truncated: false };
}
