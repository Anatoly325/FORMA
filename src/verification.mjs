import { diagnostic, fail, stable } from './diagnostic.mjs';
import { run, decode, encode } from './boundary.mjs';
import { Runtime } from './runtime.mjs';

export function validateCases(cases) {
  if (!Array.isArray(cases) || !cases.length || cases.length > 200) fail('E_CASES', 'Supply 1 to 200 explicit acceptance cases.');
  const names = new Set();
  for (const c of cases) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name || names.has(c.name) || !c.args || typeof c.args !== 'object' || Array.isArray(c.args)) fail('E_CASES', 'Cases require unique names and an args object.');
    names.add(c.name);
    if (Object.hasOwn(c, 'expect') === Object.hasOwn(c, 'expectError')) fail('E_CASES', 'Each case needs exactly one of expect or expectError.');
    if (Object.hasOwn(c, 'expectError') && (typeof c.expectError !== 'string' || !/^E_[A-Z_]+$/.test(c.expectError))) fail('E_CASES', 'expectError must be a diagnostic code.');
    if (Object.keys(c).some(k => !['name', 'args', 'expect', 'expectError'].includes(k))) fail('E_CASES', 'Unknown case property.');
  }
  if (!cases.some(c => Object.hasOwn(c, 'expect'))) fail('E_CASES', 'At least one successful-output case is required.');
}
export function verify(checker, tool, cases) {
  validateCases(cases);
  const def = checker.functions.get(tool);
  if (!def?.exported) fail('E_TOOL', `Unknown exported tool: ${tool}.`);
  const results = cases.map(c => {
    let expected;
    if (Object.hasOwn(c, 'expect')) {
      const runtime = new Runtime(checker);
      // Invalid expected data is a broken suite, not a passing negative test.
      expected = encode(decode(c.expect, def.returns, runtime, '$.expect'), runtime);
    }
    let actual, error;
    try { actual = run(checker, tool, c.args); } catch (e) { error = diagnostic(e); }
    const ok = Object.hasOwn(c, 'expectError') ? error?.code === c.expectError : !error && stable(actual.output) === stable(expected);
    return { name: c.name, ok, ...(actual ? { fuelUsed: actual.fuelUsed } : {}), ...(!ok ? { counterexample: { args: c.args, expected: Object.hasOwn(c, 'expectError') ? { error: c.expectError } : expected, actual: error ? { error } : actual.output } } : {}) };
  });
  return { ok: results.every(r => r.ok), passed: results.filter(r => r.ok).length, total: results.length, evidence: 'tested', proof: false, cases: results };
}
export function requireVerified(checker, tool, cases) {
  const report = verify(checker, tool, cases);
  if (!report.ok) fail('E_TEST', 'Acceptance cases failed; the accepted revision was not changed.', {}, { report });
  return report;
}
