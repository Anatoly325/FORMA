import { fail } from './diagnostic.mjs';

const keywords = new Set(['record', 'fn', 'tool', 'let', 'if', 'else', 'true', 'false', 'unit', 'requires', 'ensures']);
export function lex(source) {
  if (Buffer.byteLength(source) > 262144) fail('E_SOURCE_LIMIT', 'Source exceeds 256 KiB.');
  const tokens = [];
  let pos = 0, line = 1, column = 1;
  const move = s => { for (const c of s) { if (c === '\n') { line++; column = 1; } else column++; } pos += s.length; };
  while (pos < source.length) {
    const tail = source.slice(pos);
    const skip = /^(?:\s+|\/\/[^\n]*)/.exec(tail);
    if (skip) { move(skip[0]); continue; }
    const loc = { line, column };
    let text, kind;
    if (tail[0] === '"') {
      text = /^"(?:[^"\\\n\r]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(tail)?.[0];
      if (!text) fail('E_LEX', 'Invalid string; use JSON string escapes.', { loc });
      try { JSON.parse(text); } catch { fail('E_LEX', 'Invalid control character or escape in a string.', { loc }); }
      kind = 'string';
    } else if ((text = /^[0-9]+/.exec(tail)?.[0])) {
      if (text.length > 1234) fail('E_SOURCE_LIMIT', 'Integer literal exceeds the prototype limit.', { loc });
      kind = 'int';
    } else if ((text = /^[A-Za-z_][A-Za-z0-9_]*/.exec(tail)?.[0])) {
      kind = keywords.has(text) ? text : 'name';
    } else if ((text = /^(?:->|=>|==|!=|<=|>=|&&|\|\||[{}()[\],:;.+*/%<>!=\-])/.exec(tail)?.[0])) {
      kind = text;
    } else fail('E_LEX', 'Unexpected character.', { loc }, { actual: tail[0] });
    tokens.push({ kind, text, loc });
    if (tokens.length > 40000) fail('E_SOURCE_LIMIT', 'Too many source tokens.');
    move(text);
  }
  tokens.push({ kind: 'eof', text: '', loc: { line, column } });
  return tokens;
}

const precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
export class Parser {
  constructor(source) { this.tokens = lex(source); this.pos = 0; this.depth = 0; }
  peek(offset = 0) { return this.tokens[this.pos + offset] || this.tokens.at(-1); }
  at(kind) { return this.peek().kind === kind; }
  take() { return this.tokens[this.pos++]; }
  eat(kind) { if (this.at(kind)) return this.take(); }
  need(kind) {
    if (!this.at(kind)) fail('E_PARSE', `Expected ${kind}.`, this.peek(), { expected: kind, actual: this.peek().kind });
    return this.take();
  }
  node(kind, token, fields = {}) { return { kind, loc: token.loc, ...fields }; }
  type() {
    if (++this.depth > 64) fail('E_SOURCE_LIMIT', 'Type nesting exceeds 64.', this.peek());
    try {
      const name = this.need('name').text;
      if (name === 'List') { this.need('<'); const element = this.type(); this.need('>'); return { list: element }; }
      return name;
    } finally { this.depth--; }
  }
  separated(end, item) {
    const out = [];
    while (!this.at(end)) {
      out.push(item());
      if (!this.eat(',')) break;
    }
    this.need(end); return out;
  }
  program() {
    const definitions = [];
    while (!this.at('eof')) {
      const token = this.take();
      if (token.kind === 'record') {
        const name = this.need('name').text;
        this.need('{');
        const fields = this.separated('}', () => { const name = this.need('name').text; this.need(':'); return { name, type: this.type() }; });
        definitions.push(this.node('record', token, { name, fields }));
      } else if (token.kind === 'fn' || token.kind === 'tool') {
        const name = this.need('name').text;
        this.need('(');
        const params = this.separated(')', () => { const name = this.need('name').text; this.need(':'); return { name, type: this.type() }; });
        this.need('->'); const returns = this.type();
        const requires = [], ensures = [];
        while (this.at('requires') || this.at('ensures')) {
          const target = this.take().kind === 'requires' ? requires : ensures;
          target.push(this.expression()); this.need(';');
        }
        definitions.push(this.node('function', token, { name, exported: token.kind === 'tool', params, returns, requires, ensures, body: this.block() }));
      } else fail('E_PARSE', 'Expected record, fn or tool.', token, { actual: token.kind });
    }
    return assignIds({ kind: 'program', definitions });
  }
  block() {
    const token = this.need('{'), bindings = [];
    while (this.eat('let')) {
      const name = this.need('name');
      const annotation = this.eat(':') ? this.type() : null;
      this.need('='); const value = this.expression(); this.need(';');
      bindings.push(this.node('binding', name, { name: name.text, annotation, value }));
    }
    const value = this.expression();
    this.need('}');
    return this.node('block', token, { bindings, value });
  }
  expression(min = 0) {
    if (++this.depth > 128) fail('E_SOURCE_LIMIT', 'Expression nesting exceeds 128.', this.peek());
    try {
      let left = this.prefix();
      while (true) {
        const token = this.peek();
        if (this.eat('(')) {
          const args = this.separated(')', () => this.expression());
          left = this.node('call', token, { callee: left, args }); continue;
        }
        if (this.eat('.')) { left = this.node('field', token, { value: left, name: this.need('name').text }); continue; }
        if (this.eat('[')) { const index = this.expression(); this.need(']'); left = this.node('index', token, { value: left, index }); continue; }
        const p = precedence[token.kind];
        if (p === undefined || p < min) break;
        this.take(); left = this.node('binary', token, { op: token.kind, left, right: this.expression(p + 1) });
      }
      return left;
    } finally { this.depth--; }
  }
  prefix() {
    const token = this.take();
    if (token.kind === 'int') return this.node('literal', token, { type: 'Int', value: BigInt(token.text).toString() });
    if (token.kind === 'string') return this.node('literal', token, { type: 'Text', value: JSON.parse(token.text) });
    if (token.kind === 'true' || token.kind === 'false') return this.node('literal', token, { type: 'Bool', value: token.kind === 'true' });
    if (token.kind === 'unit') return this.node('literal', token, { type: 'Unit', value: null });
    if (token.kind === '-' || token.kind === '!') return this.node('unary', token, { op: token.kind, value: this.expression(7) });
    if (token.kind === 'if') {
      const condition = this.expression(); const then = this.block(); this.need('else');
      const otherwise = this.at('if') ? this.expression() : this.block();
      return this.node('if', token, { condition, then, otherwise });
    }
    if (token.kind === '[') return this.node('list', token, { items: this.separated(']', () => this.expression()) });
    if (token.kind === '{') { this.pos--; return this.block(); }
    if (token.kind === '(') {
      const start = this.pos;
      const names = [];
      while (this.at('name')) { names.push(this.take().text); if (!this.eat(',')) break; }
      if (this.eat(')') && this.eat('=>')) return this.node('lambda', token, { params: names, body: this.expression() });
      this.pos = start;
      const value = this.expression(); this.need(')'); return value;
    }
    if (token.kind === 'name') {
      if (this.eat('=>')) return this.node('lambda', token, { params: [token.text], body: this.expression() });
      // Uppercase record constructors keep `if flag { ... }` unambiguous.
      if (/^[A-Z]/.test(token.text) && this.eat('{')) {
        const fields = this.separated('}', () => { const name = this.need('name').text; this.need(':'); return { name, value: this.expression() }; });
        return this.node('construct', token, { name: token.text, fields });
      }
      return this.node('variable', token, { name: token.text });
    }
    fail('E_PARSE', 'Expected an expression.', token, { actual: token.kind });
  }
}

export function assignIds(program) {
  const pending = program.definitions.map(d => [d, `${d.kind === 'function' ? 'fn' : 'type'}:${d.name}`, 0]);
  while (pending.length) {
    const [value, path, depth] = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (depth > 256) fail('E_SOURCE_LIMIT', 'Syntax tree depth exceeds 256.', value);
    if (value.kind) value.id = path;
    for (const [k, v] of Object.entries(value)) {
      if (['loc', 'id'].includes(k)) continue;
      if (Array.isArray(v)) v.forEach((x, i) => pending.push([x, `${path}/${k}/${i}`, depth + 1]));
      else if (v && typeof v === 'object') pending.push([v, `${path}/${k}`, depth + 1]);
    }
  }
  return program;
}
export function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['loc', 'id'].includes(k)).map(([k, v]) => [k, semantic(v)]));
  return value;
}
export function parse(source) { return new Parser(source).program(); }
export function parseBody(source) {
  const p = new Parser(source); const body = p.block(); p.need('eof');
  assignIds({ definitions: [{ kind: 'function', name: '__fragment', body }] });
  return body;
}
