import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
function cli(...args) { return spawnSync(process.execPath, ['src/cli.mjs', ...args], { cwd: root, encoding: 'utf8' }); }
test('CLI exposes versioned machine-readable help and inspection', () => {
  const help = cli('help', '--json'); assert.equal(help.status, 0); assert.equal(typeof JSON.parse(help.stdout).commands.propose, 'string');
  const info = cli('inspect', 'examples/reconcile.forma', '--symbol', 'classify');
  assert.equal(info.status, 0, info.stderr); assert.deepEqual(JSON.parse(info.stdout).dependencies, ['amounts_equal']);
});
test('CLI pure probe runs existing helpers without a new artifact', () => {
  const result = cli('probe', 'examples/core.forma', '--expr', 'factorial(20)');
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).value, '2432902008176640000');
});
test('CLI rejects unknown flags and surfaces errors on stderr with nonzero status', () => {
  const result = cli('check', 'examples/core.forma', '--imaginary', 'yes');
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).diagnostic.code, 'E_CLI');
  const fuel = cli('probe', 'examples/core.forma', '--expr', 'factorial(20)', '--fuel', '5');
  assert.equal(fuel.status, 1); assert.equal(JSON.parse(fuel.stderr).diagnostic.code, 'E_FUEL');
});
