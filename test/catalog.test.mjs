import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Catalog, readText, readJSON } from '../src/catalog.mjs';
import { compile } from '../src/checker.mjs';
import { verify } from '../src/verification.mjs';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const source = readText(path.join(examples, 'reconcile.forma'));
const cases = readJSON(path.join(examples, 'reconcile.cases.json'));
const extra = readJSON(path.join(examples, 'tolerance.cases.json'));
const patch = readJSON(path.join(examples, 'tolerance.patch.json'));
const tool = 'reconcile_orders';
const reject = (code, fn) => assert.throws(fn, e => e.diagnostic?.code === code);
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forma-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Catalog(path.join(dir, 'catalog'));
}

test('reconciliation acceptance suite: all 19 cases', () => {
  const report = verify(compile(source), tool, cases);
  assert.equal(report.total, 19); assert.equal(report.passed, 19); assert.equal(report.ok, true); assert.equal(report.proof, false);
});
test('register, discover by interface and reuse in a fresh process', t => {
  const catalog = temporary(t), built = catalog.register(source, tool, cases);
  assert.equal(catalog.find('reconcile', 'Input', 'Report').length, 1);
  assert.equal(catalog.find('', 'Int').length, 0);
  const args = path.join(path.dirname(catalog.directory), 'input.json'); fs.writeFileSync(args, JSON.stringify(cases[1].args));
  const processResult = spawnSync(process.execPath, [cli, 'call', '--catalog', catalog.directory, '--tool', tool, '--input', args, '--revision', built.revision], { encoding: 'utf8' });
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.deepEqual(JSON.parse(processResult.stdout).output, cases[1].expect);
  assert.equal(catalog.describe(tool).acceptanceCases, 19);
  reject('E_EXISTS', () => catalog.register(source, tool, cases));
});
test('body replacement preserves old revision and requires explicit acceptance', t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  const proposal = catalog.propose(tool, base, patch, extra);
  assert.deepEqual(proposal.touched, ['amounts_equal']);
  assert.equal(proposal.report.total, 20);
  assert.equal(catalog.head(tool), base);
  reject('E_UNACCEPTED', () => catalog.call(tool, extra[0].args, proposal.revision));
  const oldProgram = catalog.artifact(base).payload.program;
  const newProgram = catalog.artifact(proposal.revision).payload.program;
  for (let i = 0; i < oldProgram.definitions.length; i++) {
    if (oldProgram.definitions[i].name !== 'amounts_equal') assert.deepEqual(oldProgram.definitions[i], newProgram.definitions[i]);
  }
  catalog.accept(proposal.candidate, base);
  assert.deepEqual(catalog.call(tool, extra[0].args).output, extra[0].expect);
  assert.equal(catalog.call(tool, extra[0].args, base).output.discrepancies.length, 1);
  reject('E_CONFLICT', () => catalog.accept(proposal.candidate, base));
});
test('invalid types or failing baseline cases cannot change the accepted head', t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  reject('E_TYPE', () => catalog.propose(tool, base, [{ op: 'replace_body', function: 'amounts_equal', body: '{ "yes" }' }]));
  reject('E_TEST', () => catalog.propose(tool, base, [{ op: 'replace_body', function: 'amounts_equal', body: '{ true }' }]));
  reject('E_PATCH', () => catalog.propose(tool, base, [{ op: 'remove_tests' }]));
  reject('E_NO_CHANGE', () => catalog.propose(tool, base, [{ op: 'replace_body', function: 'amounts_equal', body: '{ expected == paid }' }]));
  assert.equal(catalog.head(tool), base);
});
test('failed registration does not create a callable tool', t => {
  const catalog = temporary(t), broken = structuredClone(cases);
  broken[1].expect.matched = [];
  reject('E_TEST', () => catalog.register(source, tool, broken));
  assert.deepEqual(catalog.find(), []);
});
test('competing candidates do not silently overwrite each other', t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  const a = catalog.propose(tool, base, patch, extra);
  const b = catalog.propose(tool, base, [{ op: 'replace_body', function: 'amounts_equal', body: '{ abs(expected - paid) <= 2 }' }], extra);
  catalog.accept(a.candidate, base);
  reject('E_CONFLICT', () => catalog.accept(b.candidate, base));
  assert.equal(catalog.head(tool), a.revision);
});
test('two independent writer processes cannot both accept the same base', async t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  const a = catalog.propose(tool, base, patch, extra);
  const b = catalog.propose(tool, base, [{ op: 'replace_body', function: 'amounts_equal', body: '{ abs(expected - paid) <= 2 }' }], extra);
  const exec = promisify(execFile);
  const outputs = await Promise.allSettled([a, b].map(candidate => exec(process.execPath, [cli, 'accept', '--catalog', catalog.directory, '--candidate', candidate.candidate, '--expected-base', base])));
  assert.equal(outputs.filter(r => r.status === 'fulfilled').length, 1);
  const error = outputs.find(r => r.status === 'rejected').reason;
  assert.ok(['E_BUSY', 'E_CONFLICT'].includes(JSON.parse(error.stderr).diagnostic.code));
});
test('artifact corruption is detected before execution', t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  const file = path.join(catalog.directory, 'artifacts', `${base}.json`);
  const data = readJSON(file); data.payload.tool = 'renamed'; fs.writeFileSync(file, JSON.stringify(data));
  reject('E_INTEGRITY', () => catalog.call(tool, cases[1].args));
});
test('accept rechecks stored cases and blocks removal of the baseline', t => {
  const catalog = temporary(t), base = catalog.register(source, tool, cases).revision;
  const payload = catalog.artifact(base).payload;
  payload.cases = payload.cases.slice(0, 1);
  const revision = catalog.saveObject('artifacts', payload);
  const candidate = catalog.saveObject('candidates', { engine: payload.engine, tool, base, revision, touched: [] });
  reject('E_CASES', () => catalog.accept(candidate, base));
  assert.equal(catalog.head(tool), base);
});
