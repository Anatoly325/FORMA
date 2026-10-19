import { fail } from './diagnostic.mjs';
import { builtinNames } from './checker.mjs';

export class RecordValue {
  constructor(name, fields) { this.name = name; this.fields = fields; }
}
export const DEFAULT_LIMITS = Object.freeze({ fuel: 1000000, callDepth: 96, evaluationDepth: 256, listLength: 10000, textLength: 65536, integerBits: 4096, dataDepth: 64, dataNodes: 100000 });

export class Runtime {
  constructor(checker, limits = {}) {
    this.checker = checker; this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key, n] of Object.entries(this.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(n) || n < 1 || n > DEFAULT_LIMITS[key]) fail('E_LIMIT_CONFIG', 'Limits must be positive integers no greater than the profile defaults.', {}, { key, maximum: DEFAULT_LIMITS[key] });
    }
    this.remaining = this.limits.fuel; this.depth = 0; this.evalDepth = 0;
  }
  tick(at, amount = 1) {
    this.remaining -= amount;
    if (this.remaining < 0) fail('E_FUEL', 'Execution budget exhausted.', at, { limit: this.limits.fuel });
  }
  guard(value, at) {
    if (typeof value === 'bigint' && value.toString(2).replace('-', '').length > this.limits.integerBits) fail('E_INT_LIMIT', 'Integer exceeds the execution profile limit.', at, { limit: this.limits.integerBits });
    if (typeof value === 'string' && (value.length > this.limits.textLength || !value.isWellFormed())) fail('E_TEXT_LIMIT', 'Text must be well-formed Unicode within the profile limit.', at, { limit: this.limits.textLength });
    if (Array.isArray(value) && value.length > this.limits.listLength) fail('E_LIST_LIMIT', 'List exceeds the execution profile limit.', at, { limit: this.limits.listLength });
    return value;
  }
  equal(a, b, at) {
    this.tick(at);
    if (typeof a !== typeof b) return false;
    if (a === null || typeof a !== 'object') return a === b;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => this.equal(v, b[i], at));
    if (a instanceof RecordValue) return b instanceof RecordValue && a.name === b.name && Object.keys(a.fields).every(k => this.equal(a.fields[k], b.fields[k], at));
    fail('E_VALUE', 'Non-data value in comparison.', at);
  }
  invoke(fn, args, at = {}) {
    this.tick(at);
    if (++this.depth > this.limits.callDepth) { this.depth--; fail('E_DEPTH', 'Call depth limit exceeded.', at, { limit: this.limits.callDepth }); }
    try {
      if (fn.kind === 'closure') {
        const env = new Map(fn.env); fn.node.params.forEach((p, i) => env.set(p, args[i]));
        return this.evaluate(fn.node.body, env);
      }
      const def = this.checker.functions.get(fn.name);
      if (!def) fail('E_NAME', `Unknown function: ${fn.name}.`, at);
      const env = new Map(def.params.map((p, i) => [p.name, args[i]]));
      for (let i = 0; i < def.requires.length; i++) {
        const p = def.requires[i];
        if (!this.evaluate(p, env)) fail('E_PRECONDITION', 'Precondition failed.', p, { function: def.name, requirement: `requires/${i}`, evidence: 'guarded' });
      }
      const result = this.evaluate(def.body, env); env.set('result', result);
      for (let i = 0; i < def.ensures.length; i++) {
        const p = def.ensures[i];
        if (!this.evaluate(p, env)) fail('E_POSTCONDITION', 'Postcondition failed.', p, { function: def.name, requirement: `ensures/${i}`, evidence: 'guarded' });
      }
      return result;
    } finally { this.depth--; }
  }
  evaluate(n, env) {
    this.tick(n);
    if (++this.evalDepth > this.limits.evaluationDepth) { this.evalDepth--; fail('E_DEPTH', 'Evaluation nesting limit exceeded.', n); }
    try {
    let value;
    switch (n.kind) {
      case 'literal': value = n.type === 'Int' ? BigInt(n.value) : n.value; break;
      case 'variable': value = env.has(n.name) ? env.get(n.name) : { kind: 'function', name: n.name }; break;
      case 'list': value = n.items.map(x => this.evaluate(x, env)); break;
      case 'construct': value = new RecordValue(n.name, Object.fromEntries(n.fields.map(f => [f.name, this.evaluate(f.value, env)]))); break;
      case 'field': value = this.evaluate(n.value, env).fields[n.name]; break;
      case 'index': {
        const xs = this.evaluate(n.value, env), index = this.evaluate(n.index, env);
        if (index < 0n || index >= BigInt(xs.length)) fail('E_BOUNDS', 'List index out of bounds.', n, { index: index.toString(), length: xs.length });
        value = xs[Number(index)]; break;
      }
      case 'unary': { const x = this.evaluate(n.value, env); value = n.op === '!' ? !x : -x; break; }
      case 'binary': {
        const a = this.evaluate(n.left, env);
        if (n.op === '&&') { value = a && this.evaluate(n.right, env); break; }
        if (n.op === '||') { value = a || this.evaluate(n.right, env); break; }
        const b = this.evaluate(n.right, env);
        switch (n.op) {
          case '+': value = a + b; break;
          case '-': value = a - b; break;
          case '*': value = a * b; break;
          case '/': case '%':
            if (b === 0n) fail('E_DIV_ZERO', 'Division by zero.', n);
            value = n.op === '/' ? a / b : a % b; break;
          case '<': value = a < b; break;
          case '<=': value = a <= b; break;
          case '>': value = a > b; break;
          case '>=': value = a >= b; break;
          case '==': value = this.equal(a, b, n); break;
          case '!=': value = !this.equal(a, b, n); break;
        }
        break;
      }
      case 'if': value = this.evaluate(this.evaluate(n.condition, env) ? n.then : n.otherwise, env); break;
      case 'block': {
        const inner = new Map(env);
        n.bindings.forEach(b => inner.set(b.name, this.evaluate(b.value, inner)));
        value = this.evaluate(n.value, inner); break;
      }
      case 'lambda': value = { kind: 'closure', node: n, env: new Map(env) }; break;
      case 'call': {
        if (n.callee.kind === 'variable' && builtinNames.has(n.callee.name)) value = this.builtin(n.callee.name, n.args.map(a => this.evaluate(a, env)), n);
        else { const fn = this.evaluate(n.callee, env); value = this.invoke(fn, n.args.map(a => this.evaluate(a, env)), n); }
        break;
      }
      default: fail('E_AST', `Unknown expression: ${n.kind}.`, n);
    }
    return this.guard(value, n);
    } finally { this.evalDepth--; }
  }
  builtin(name, args, at) {
    const [a, b, c] = args;
    const call = (fn, values) => this.invoke(fn, values, at);
    const sized = n => { if (n > this.limits.listLength) fail('E_LIST_LIMIT', 'List exceeds the execution profile limit.', at); };
    switch (name) {
      case 'len': this.tick(at, typeof a === 'string' ? a.length : 1); return BigInt(typeof a === 'string' ? [...a].length : a.length);
      case 'map': return a.map(x => call(b, [x]));
      case 'filter': return a.filter(x => call(b, [x]));
      case 'flat_map': {
        const out = [];
        for (const x of a) { const xs = call(b, [x]); sized(out.length + xs.length); this.tick(at, xs.length); out.push(...xs); }
        return out;
      }
      case 'all': return a.every(x => call(b, [x]));
      case 'any': return a.some(x => call(b, [x]));
      case 'fold': return a.reduce((acc, x) => call(c, [acc, x]), b);
      case 'concat': sized(a.length + b.length); this.tick(at, a.length + b.length); return a.concat(b);
      case 'unique': {
        const out = [];
        for (const x of a) if (!out.some(y => this.equal(x, y, at))) out.push(x);
        return out;
      }
      case 'contains': return a.some(x => this.equal(x, b, at));
      case 'sum': return a.reduce((acc, x) => { this.tick(at); return this.guard(acc + x, at); }, 0n);
      case 'range':
        if (a < 0n || a > BigInt(this.limits.listLength)) fail('E_RANGE', 'range requires 0 <= size <= list limit.', at);
        this.tick(at, Number(a)); return Array.from({ length: Number(a) }, (_, i) => BigInt(i));
      case 'abs': return a < 0n ? -a : a;
      case 'text': return String(a);
      case 'trim': this.tick(at, a.length); return a.trim();
      case 'split': this.tick(at, a.length + b.length); return b === '' ? [...a] : a.split(b);
      case 'join': {
        const size = a.reduce((n, x) => n + x.length, 0) + Math.max(0, a.length - 1) * b.length;
        if (size > this.limits.textLength) fail('E_TEXT_LIMIT', 'Joined text exceeds the profile limit.', at);
        this.tick(at, size); return a.join(b);
      }
      default: fail('E_NAME', `Unknown builtin: ${name}.`, at);
    }
  }
  stats() { return { fuelUsed: this.limits.fuel - this.remaining, fuelLimit: this.limits.fuel }; }
}
