import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/checker.mjs';
import { run, describe } from '../src/boundary.mjs';
import { diagnostic } from '../src/diagnostic.mjs';
import { parse, semantic } from '../src/parser.mjs';
import { digest, parseJSON } from '../src/catalog.mjs';

const reject = (code, fn) => assert.throws(fn, e => diagnostic(e).code === code);
const execute = (source, args = {}, limits) => run(compile(source), 'main', args, limits).output;

test('recursion and exact integers beyond IEEE-754', () => {
  const source = 'fn fact(n: Int) -> Int { if n == 0 { 1 } else { n * fact(n - 1) } } tool main(n: Int) -> Int { fact(n) }';
  assert.equal(execute(source, { n: 20 }), '2432902008176640000');
  assert.equal(execute('tool main(n: Int) -> Int { n + 1 }', { n: '900719925474099312345' }), '900719925474099312346');
});
test('division truncates toward zero; remainder follows dividend', () => {
  assert.deepEqual(execute('tool main() -> List<Int> { [-7 / 3, -7 % 3, 7 / -3] }'), ['-2', '-1', '-2']);
});
test('immutable bindings, annotated empty lists and nested record equality', () => {
  assert.equal(execute('record R { xs: List<Int> } tool main() -> Bool { let xs: List<Int> = []; R { xs: xs } == R { xs: [] } }'), true);
});
test('list mapping, filtering, flat_map and folds', () => {
  assert.equal(execute('tool main() -> Int { let xs = flat_map(range(4), n => [n, n]); fold(filter(xs, x => x > 1), 0, (acc, value) => acc + value) }'), '10');
});
test('named callbacks are checked and callable', () => {
  assert.deepEqual(execute('fn twice(n: Int) -> Int { n * 2 } tool main() -> List<Int> { map([1,2], twice) }'), ['2', '4']);
  reject('E_TYPE', () => compile('fn wrong(s: Text) -> Int { 1 } tool main() -> List<Int> { map([1], wrong) }'));
  reject('E_ARITY', () => compile('fn wrong(a: Int, b: Int) -> Int { a } tool main() -> List<Int> { map([1], wrong) }'));
});
test('Text uses Unicode code points for len and split-empty', () => {
  assert.equal(execute('tool main() -> Int { len("😀a") }'), '2');
  assert.equal(execute('tool main() -> Text { join(split(trim(" 😀a "), ""), "|") }'), '😀|a');
  reject('E_TEXT_LIMIT', () => execute('tool main() -> Text { "\\ud800" }'));
});
test('short-circuit operators and branch laziness', () => {
  assert.equal(execute('tool main() -> Bool { false && 1 / 0 == 2 || true }'), true);
  assert.equal(execute('tool main() -> Int { if true { 1 } else { 1 / 0 } }'), '1');
});
test('preconditions and postconditions run, with structured requirement ids', () => {
  reject('E_PRECONDITION', () => execute('tool main(n: Int) -> Int requires n >= 0; { n }', { n: -1 }));
  try { execute('tool main() -> Int ensures result > 0; { 0 }'); assert.fail(); }
  catch (e) { assert.equal(e.diagnostic.code, 'E_POSTCONDITION'); assert.equal(e.diagnostic.requirement, 'ensures/0'); assert.match(e.diagnostic.node, /^fn:main\/ensures/); }
});
test('division, bounds and resource failures are explicit', () => {
  reject('E_DIV_ZERO', () => execute('tool main() -> Int { 1 / 0 }'));
  reject('E_BOUNDS', () => execute('tool main() -> Int { [1][-1] }'));
  reject('E_BOUNDS', () => execute('tool main() -> Int { [1][1] }'));
  reject('E_RANGE', () => execute('tool main() -> List<Int> { range(10001) }'));
  reject('E_INT_LIMIT', () => execute('tool main() -> Int { 255 * 255 }', {}, { integerBits: 8 }));
  reject('E_LIMIT_CONFIG', () => execute('tool main() -> Int { 1 }', {}, { fuel: -1 }));
});
test('nonterminating recursion stops on fuel or call depth', () => {
  const source = 'tool main() -> Int { main() }';
  reject('E_FUEL', () => execute(source, {}, { fuel: 20 }));
  reject('E_DEPTH', () => execute(source));
});
test('Unit is explicit, and JSON never coerces boolean to Int', () => {
  assert.equal(execute('tool main(x: Unit) -> Unit { x }', { x: null }), null);
  reject('E_INPUT', () => execute('tool main(x: Int) -> Int { x }', { x: true }));
  reject('E_INPUT', () => execute('tool main(x: Int) -> Int { x }', { x: 9007199254740992 }));
  reject('E_INPUT', () => execute('tool main(x: Int) -> Int { x }', { x: '01' }));
  reject('E_INPUT', () => execute('tool main(x: Int) -> Int { x }', { x: '-0' }));
});
test('JSON numeric lexemes cannot silently round into valid Int inputs', () => {
  reject('E_JSON_NUMBER', () => parseJSON('{"n":1.0000000000000001}'));
  reject('E_JSON_NUMBER', () => parseJSON('{"n":9007199254740992}'));
  reject('E_JSON_NUMBER', () => parseJSON('{"n":1e2}'));
  assert.deepEqual(parseJSON('{"n":"900719925474099312345"}'), { n: '900719925474099312345' });
  assert.deepEqual(parseJSON('{"n":100}'), { n: 100 });
});
test('strict JSON fields include prototype-like names without pollution', () => {
  const source = 'record R { __proto__: Text } tool main(r: R) -> R { r }';
  const input = JSON.parse('{"r":{"__proto__":"ordinary data"}}');
  assert.deepEqual(execute(source, input), input.r);
  reject('E_INPUT_FIELDS', () => execute('record R { n: Int } tool main(r: R) -> R { r }', { r: { n: 1, extra: 2 } }));
  assert.equal({}.polluted, undefined);
});
test('recursive record schemas use references and data depth is bounded', () => {
  const c = compile('record Node { children: List<Node> } tool main(n: Node) -> Node { n }');
  assert.equal(describe(c, 'main').outputSchema.$defs.Node.properties.children.items.$ref, '#/$defs/Node');
  let n = { children: [] }; for (let i = 0; i < 70; i++) n = { children: [n] };
  reject('E_DATA_LIMIT', () => run(c, 'main', { n }));
});
test('formatting and comments do not change the semantic digest', () => {
  assert.equal(digest(semantic(parse('tool main() -> Int { 1 }'))), digest(semantic(parse('// comment\n tool main( ) -> Int { 01 }'))));
});

const invalid = [
  ['mixed arithmetic', 'E_TYPE', 'tool main() -> Int { 1 + "2" }'],
  ['nominal record mismatch', 'E_TYPE', 'record A { n: Int } record B { n: Int } tool main() -> A { B { n: 1 } }'],
  ['inconsistent branches', 'E_TYPE', 'tool main() -> Int { if true { 1 } else { false } }'],
  ['missing constructor field', 'E_FIELDS', 'record A { n: Int } tool main() -> A { A {} }'],
  ['duplicate field', 'E_DUPLICATE', 'record A { n: Int, n: Int }'],
  ['unknown type', 'E_TYPE_NAME', 'tool main(n: Number) -> Int { 1 }'],
  ['unknown function', 'E_NAME', 'tool main() -> Int { imaginary(1) }'],
  ['wrong arity', 'E_ARITY', 'tool main() -> Int { abs(1, 2) }'],
  ['untyped empty list', 'E_INFER', 'tool main() -> Int { len([]) }'],
  ['reserved binding', 'E_SHADOW', 'tool main() -> Int { let result = 1; result }'],
  ['local shadow', 'E_SHADOW', 'tool main(n: Int) -> Int { let n = 1; n }'],
  ['bad predicate type', 'E_TYPE', 'tool main() -> Int requires 1; { 1 }'],
  ['function equality', 'E_TYPE', 'fn a() -> Int { 1 } tool main() -> Bool { [a] == [a] }'],
  ['no external effects', 'E_NAME', 'tool main() -> Text { http_get("https://example.com") }'],
  ['malformed source', 'E_PARSE', 'tool main() -> Int { 1'],
];
for (const [name, code, source] of invalid) test(`static rejection: ${name}`, () => reject(code, () => compile(source)));
test('syntax diagnostics identify source location', () => {
  reject('E_LEX', () => compile('tool main() -> Text { "raw\tcontrol" }'));
  try { compile('tool main() -> Int {\n @ }'); assert.fail(); }
  catch (e) { assert.equal(e.diagnostic.code, 'E_LEX'); assert.deepEqual(e.diagnostic.location, { line: 2, column: 2 }); }
});
test('deeply nested source is rejected before host stack exhaustion', () => {
  reject('E_SOURCE_LIMIT', () => compile(`tool main() -> Int { ${'('.repeat(200)}1${')'.repeat(200)} }`));
  reject('E_SOURCE_LIMIT', () => compile(`tool main(x: ${'List<'.repeat(100)}Int${'>'.repeat(100)}) -> Int { 1 }`));
  reject('E_SOURCE_LIMIT', () => compile(`tool main() -> Int { ${Array(1000).fill('1').join('+')} }`));
});
