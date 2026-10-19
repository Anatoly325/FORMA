#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { VERSION, diagnostic, fail, json } from './diagnostic.mjs';
import { compile, inspect, typeName } from './checker.mjs';
import { parseBody, assignIds } from './parser.mjs';
import { run, describe, encode } from './boundary.mjs';
import { Runtime, DEFAULT_LIMITS } from './runtime.mjs';
import { Catalog, readText, readJSON } from './catalog.mjs';
import { verify } from './verification.mjs';
import { inspectCSV, importCSV } from './csv.mjs';

const HELP = {
  engine: VERSION,
  commands: {
    check: 'check MODULE.forma',
    describe: 'describe MODULE.forma [--tool NAME]',
    inspect: 'inspect MODULE.forma --symbol NAME',
    run: 'run MODULE.forma --input ARGS.json [--tool NAME] [--fuel N]',
    probe: 'probe MODULE.forma --expr EXPRESSION [--fuel N]',
    test: 'test MODULE.forma --cases CASES.json [--tool NAME]',
    register: 'register MODULE.forma --cases CASES.json [--tool NAME] [--catalog DIR]',
    find: 'find [--query SUBSTRING] [--input-type TYPE] [--output-type TYPE] [--catalog DIR]',
    call: 'call --tool NAME --input ARGS.json [--revision SHA256] [--fuel N] [--catalog DIR]',
    'tool-describe': 'tool-describe --tool NAME [--revision SHA256] [--catalog DIR]',
    propose: 'propose --tool NAME --base SHA256 --patch PATCH.json [--cases EXTRA.json] [--catalog DIR]',
    accept: 'accept --candidate SHA256 --expected-base SHA256 [--catalog DIR]',
    'csv-inspect': 'csv-inspect --input DATA.csv',
    'csv-import': 'csv-import MODULE.forma --record TYPE --input DATA.csv',
    help: 'help [--json]'
  },
  builtins: [
    'len(List<T> | Text) -> Int', 'map(List<T>, (T)->U) -> List<U>',
    'filter(List<T>, (T)->Bool) -> List<T>', 'flat_map(List<T>, (T)->List<U>) -> List<U>',
    'all(List<T>, (T)->Bool) -> Bool', 'any(List<T>, (T)->Bool) -> Bool',
    'fold(List<T>, U, (U,T)->U) -> U', 'concat(List<T>, List<T>) -> List<T>',
    'unique(List<T>) -> List<T>', 'contains(List<T>, T) -> Bool',
    'sum(List<Int>) -> Int', 'range(Int) -> List<Int>', 'abs(Int) -> Int',
    'text(Int | Bool | Text) -> Text', 'split(Text, Text) -> List<Text>',
    'join(List<Text>, Text) -> Text', 'trim(Text) -> Text'
  ],
  limits: DEFAULT_LIMITS,
  effects: [],
  implemented: ['independent parser', 'static types', 'pure interpreter', 'runtime contracts', 'JSON/CSV boundaries', 'local versioned tools', 'checked body replacement'],
  deferred: ['formal proofs', 'Option/Result and match', 'modules/FFI', 'Wasm backend', 'HTTP/GPU', 'LLM calls', 'model routing', 'agent spawning'],
  examples: ['examples/reconcile.forma', 'examples/core.forma'],
  contract: 'stdout is JSON; diagnostics are JSON on stderr; nonzero exit means failure'
};

const optionsByCommand = {
  help: ['json'], check: [], describe: ['tool'], inspect: ['symbol'],
  run: ['tool', 'input', 'fuel'], probe: ['expr', 'fuel'], test: ['tool', 'cases'],
  register: ['tool', 'cases', 'catalog'], find: ['query', 'input-type', 'output-type', 'catalog'],
  call: ['tool', 'input', 'revision', 'fuel', 'catalog'], 'tool-describe': ['tool', 'revision', 'catalog'],
  propose: ['tool', 'base', 'patch', 'cases', 'catalog'], accept: ['candidate', 'expected-base', 'catalog'],
  'csv-inspect': ['input'], 'csv-import': ['record', 'input']
};
function argumentsOf(argv) {
  const [command = 'help', ...rest] = argv;
  if (!Object.hasOwn(optionsByCommand, command)) fail('E_CLI', 'Unknown command. Run help --json.', {}, { command });
  const options = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith('--')) { positional.push(item); continue; }
    const name = item.slice(2);
    if (!optionsByCommand[command].includes(name) || Object.hasOwn(options, name)) fail('E_CLI', 'Unknown or duplicate option.', {}, { option: item });
    if (name === 'json') { options[name] = true; continue; }
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) fail('E_CLI', 'Option requires a value.', {}, { option: item });
    options[name] = rest[++i];
  }
  const moduleCommands = ['check', 'describe', 'inspect', 'run', 'probe', 'test', 'register', 'csv-import'];
  if (positional.length !== (moduleCommands.includes(command) ? 1 : 0)) fail('E_CLI', 'Incorrect positional arguments.', {}, { usage: HELP.commands[command] });
  return { command, options, file: positional[0] };
}
export function main(argv) {
  const { command, options: o, file } = argumentsOf(argv);
  const need = key => { if (!o[key]) fail('E_CLI', `Missing --${key}.`, {}, { usage: HELP.commands[command] }); return o[key]; };
  const checker = file ? compile(readText(file, 262144)) : null;
  const tool = () => {
    if (o.tool) return o.tool;
    const names = [...checker.functions.values()].filter(f => f.exported).map(f => f.name);
    if (names.length !== 1) fail('E_CLI', 'Choose --tool when a module does not export exactly one tool.', {}, { tools: names });
    return names[0];
  };
  const limits = () => o.fuel === undefined ? {} : { fuel: /^\d+$/.test(o.fuel) ? Number(o.fuel) : NaN };
  const catalog = () => new Catalog(o.catalog);
  switch (command) {
    case 'help': return HELP;
    case 'check': return { ok: true, engine: VERSION, functions: checker.functions.size, records: checker.records.size, tools: [...checker.functions.values()].filter(f => f.exported).map(f => f.name), evidence: 'static-types-checked', proof: false };
    case 'describe': return describe(checker, tool());
    case 'inspect': return inspect(checker, need('symbol'));
    case 'run': return run(checker, tool(), readJSON(need('input')), limits());
    case 'test': return verify(checker, tool(), readJSON(need('cases')));
    case 'register': return catalog().register(readText(file, 262144), tool(), readJSON(need('cases')));
    case 'find': return { tools: catalog().find(o.query, o['input-type'], o['output-type']), truncated: false };
    case 'call': return catalog().call(need('tool'), readJSON(need('input')), o.revision, limits());
    case 'tool-describe': return catalog().describe(need('tool'), o.revision);
    case 'propose': return catalog().propose(need('tool'), need('base'), readJSON(need('patch')), o.cases ? readJSON(o.cases) : []);
    case 'accept': return catalog().accept(need('candidate'), need('expected-base'));
    case 'csv-inspect': return inspectCSV(readText(need('input'), 1048576));
    case 'csv-import': return importCSV(checker, need('record'), readText(need('input'), 1048576));
    case 'probe': {
      const body = parseBody(`{ ${need('expr')} }`);
      assignIds({ definitions: [{ kind: 'function', name: '__probe', body }] });
      const type = checker.infer(body, new Map());
      const runtime = new Runtime(checker, limits());
      const value = encode(runtime.evaluate(body, new Map()), runtime);
      return { type: typeName(type), value, ...runtime.stats() };
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = main(process.argv.slice(2));
    if (result?.ok === false) { process.stderr.write(json({ ok: false, diagnostic: { code: 'E_TEST', message: 'Acceptance cases failed.', report: result } }) + '\n'); process.exitCode = 1; }
    else process.stdout.write(json(result) + '\n');
  } catch (error) {
    process.stderr.write(json({ ok: false, diagnostic: diagnostic(error) }) + '\n'); process.exitCode = 1;
  }
}
