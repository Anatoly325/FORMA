import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, importCSV, inspectCSV } from '../src/csv.mjs';
import { compile } from '../src/checker.mjs';

const reject = (code, fn) => assert.throws(fn, e => e.diagnostic?.code === code);
test('CSV preserves quotes, commas, multiline cells and CRLF', () => {
  assert.deepEqual(parseCSV('\ufeffa,b\r\n"x,y","say ""hi""\nnext"\r\n').rows, [['x,y', 'say "hi"\nnext']]);
  assert.deepEqual(parseCSV('a,b\nx,').rows, [['x', '']]);
});
test('CSV inspection is explicitly a sample, without guessed types', () => {
  const info = inspectCSV('a\n1\n2\n3\n4\n5\n6\n');
  assert.equal(info.rowCount, 6); assert.equal(info.sample.length, 5); assert.equal(info.sampleTruncated, true);
});
test('CSV import uses declared types with exact Int values', () => {
  const c = compile('record R { n: Int, ok: Bool, label: Text }');
  assert.deepEqual(importCSV(c, 'R', 'label,n,ok\nexample,900719925474099312345,true\n'), [{ label: 'example', n: '900719925474099312345', ok: true }]);
  reject('E_INPUT', () => importCSV(c, 'R', 'n,ok,label\n1.5,true,x'));
  reject('E_CSV_TYPE', () => importCSV(c, 'R', 'n,ok,label\n1,yes,x'));
  reject('E_INPUT_FIELDS', () => importCSV(c, 'R', 'n,ok\n1,true'));
});
for (const text of ['a,a\n1,2', 'a,b\n1', 'a\n"open', 'a\nx"y', 'a\n"x"trailing']) {
  test(`malformed CSV is rejected: ${JSON.stringify(text)}`, () => reject('E_CSV', () => parseCSV(text)));
}
