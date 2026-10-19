// Scripted developer workflow. No LLM or autonomous agent is launched here.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'src/cli.mjs');
const file = name => path.join(root, 'examples', name);
const demos = path.join(root, '.demo'); fs.mkdirSync(demos, { recursive: true });
const workspace = fs.mkdtempSync(path.join(demos, 'run-'));
const catalog = path.join(workspace, 'catalog');
const source = file('reconcile.forma');
const tool = 'reconcile_orders';
const steps = [];

function command(label, args, expectedError) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (expectedError) {
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    const error = JSON.parse(result.stderr).diagnostic;
    assert.equal(error.code, expectedError, `${label}: ${result.stderr}`);
    steps.push({ step: label, status: 'expected-rejection', code: error.code });
    return error;
  }
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  steps.push({ step: label, status: 'passed' });
  return JSON.parse(result.stdout);
}
function write(name, data) { const target = path.join(workspace, name); fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n'); return target; }

const orderShape = command('inspect-orders-csv', ['csv-inspect', '--input', file('orders.csv')]);
const paymentShape = command('inspect-payments-csv', ['csv-inspect', '--input', file('payments.csv')]);
const orders = command('typed-order-import', ['csv-import', source, '--record', 'Order', '--input', file('orders.csv')]);
const payments = command('typed-payment-import', ['csv-import', source, '--record', 'Payment', '--input', file('payments.csv')]);
const input = write('input.json', { input: { orders, payments } });
command('static-check', ['check', source]);
const tests = command('baseline-acceptance', ['test', source, '--cases', file('reconcile.cases.json')]);
const built = command('register', ['register', source, '--cases', file('reconcile.cases.json'), '--catalog', catalog]);
const found = command('discover-in-new-process', ['find', '--input-type', 'Input', '--output-type', 'Report', '--catalog', catalog]);
assert.equal(found.tools[0].revision, built.revision);
const first = command('reuse-in-new-process', ['call', '--tool', tool, '--input', input, '--revision', built.revision, '--catalog', catalog]);
const counts = Object.fromEntries(Object.entries(first.output).map(([k, rows]) => [k, rows.length]));
assert.deepEqual(counts, { matched: 1, unpaid: 1, unmatched: 1, discrepancies: 1, ambiguous: 1 });
write('reconciliation-report.json', first.output);

const badPatch = write('invalid.patch.json', [{ op: 'replace_body', function: 'amounts_equal', body: '{ "yes" }' }]);
command('reject-invalid-type', ['propose', '--tool', tool, '--base', built.revision, '--patch', badPatch, '--catalog', catalog], 'E_TYPE');
command('new-requirement-fails-on-old-code', ['test', source, '--cases', file('tolerance.cases.json')], 'E_TEST');
const proposal = command('propose-one-function-change', ['propose', '--tool', tool, '--base', built.revision, '--patch', file('tolerance.patch.json'), '--cases', file('tolerance.cases.json'), '--catalog', catalog]);
assert.equal(proposal.report.total, 20);
command('accept-checked-revision', ['accept', '--candidate', proposal.candidate, '--expected-base', built.revision, '--catalog', catalog]);
const extra = JSON.parse(fs.readFileSync(file('tolerance.cases.json'), 'utf8'));
const changedInput = write('new-requirement-input.json', extra[0].args);
const current = command('new-revision-meets-requirement', ['call', '--tool', tool, '--input', changedInput, '--catalog', catalog]);
assert.deepEqual(current.output, extra[0].expect);
const old = command('old-revision-keeps-old-behavior', ['call', '--tool', tool, '--input', changedInput, '--revision', built.revision, '--catalog', catalog]);
assert.equal(old.output.discrepancies.length, 1);
command('reject-stale-acceptance', ['accept', '--candidate', proposal.candidate, '--expected-base', built.revision, '--catalog', catalog], 'E_CONFLICT');

const report = {
  engine: 'forma-prototype/0.1.0', node: process.version, platform: process.platform, architecture: process.arch,
  mode: 'scripted CLI workflow; no LLM calls or spawned AI agents',
  csv: { orders: orderShape.rowCount, payments: paymentShape.rowCount },
  baselineCases: tests.passed, revisedCases: proposal.report.passed,
  initialCounts: counts, revisions: { initial: built.revision, revised: proposal.revision },
  changedFunctions: proposal.touched, freshProcessReuse: true, oldRevisionPreserved: true,
  llmTokenSavings: 'not measured', steps
};
write('demo-report.json', report);
process.stdout.write(JSON.stringify({ ...report, resultsDirectory: workspace }, null, 2) + '\n');
