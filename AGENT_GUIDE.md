# FORMA agent guide — profile 0.1.0

Full project name: **Форма Учеватова Кая**. Short technical name: **FORMA**.

You can create, validate, register, find, invoke and revise local tools through
`node src/cli.mjs`. Start with `help --json`. No package installation is needed.
Use Node.js 24.19.0 for the tested environment. All public outputs are JSON.

## Minimal source

```text
record Input { values: List<Int> }

tool total(input: Input) -> Int
requires all(input.values, value => value >= 0);
ensures result >= 0;
{
  sum(input.values)
}
```

The named parameter wrapper is required at the tool boundary:

```json
{"input":{"values":["2","3"]}}
```

Output Int values are always decimal strings. Safe JSON integer literals are
also accepted as input. Large integers must be strings. No floating-point types
or implicit conversions exist in this profile. JSON numeric fractions and
exponents are rejected at file ingestion to prevent silent rounding.

## Development loop

1. Inspect the data with `csv-inspect --input FILE` when appropriate. It reports
   sample truncation and does not invent types or business rules.
2. Write a small `.forma` module. Use `check MODULE` and
   `describe MODULE --tool NAME` for types and the boundary schema.
3. Use `probe MODULE --expr EXPRESSION --fuel N` for a bounded pure experiment.
   Probe can invoke internal functions but cannot perform I/O.
4. Create acceptance cases with explicit expected results. Run
   `test MODULE --cases CASES.json --tool NAME`.
5. Run `register MODULE --cases CASES.json --tool NAME --catalog DIR`.
   Capture the full `revision` from the returned JSON; never invent a hash.
6. Find existing tools with `find --query TEXT --input-type TYPE --catalog DIR`.
   Invoke with `call --tool NAME --input ARGS.json --revision HASH --catalog DIR`.
   A new process can reuse the same catalog without the original source file.
7. For a change, inspect only the relevant definition with
   `inspect MODULE --symbol FUNCTION`; dependencies and full definition are returned.
8. Propose a body replacement against the actual base revision. Add new acceptance
   cases with `--cases`; the candidate cannot delete the existing cases.
9. Accept the candidate with its exact base. On `E_CONFLICT`, retrieve the current
   revision and rebuild/recheck the proposal. Do not silently retry with a new base.

Example patch file, used only for the demo's explicit changed requirement:

```json
[
  {"op":"replace_body","function":"amounts_equal","body":"{ abs(expected - paid) <= 1 }"}
]
```

Commands, with identifiers taken from earlier results:

```text
propose --tool NAME --base BASE_HASH --patch PATCH.json --cases EXTRA_CASES.json --catalog DIR
accept --candidate CANDIDATE_HASH --expected-base BASE_HASH --catalog DIR
```

These are CLI arguments after `node src/cli.mjs`. PLACEHOLDERS must be replaced.

## Acceptance cases

```json
[
  {"name":"positive","args":{"input":{"values":["2","3"]}},"expect":"5"},
  {"name":"negative","args":{"input":{"values":["-1"]}},"expectError":"E_PRECONDITION"}
]
```

Suites need unique names and at least one successful-output case. Use requirements
and explicit boundary cases, not a copy of the implementation as the expected-result
generator. The environment checks examples; it does not establish their completeness.

## Diagnostic handling

Read `diagnostic.code`, `node`, `location`, `expected`, `actual`, `path` and
`requirement` when present. A failed acceptance check includes a concrete input,
expected output and actual output or error. Missing fields mean the runtime has
no such evidence; do not infer a proof or a counterexample that was not returned.

`E_TYPE` / `E_FIELDS`: repair the indicated definition.
`E_INPUT*` / `E_JSON_NUMBER`: repair the boundary data or its explicit mapping.
`E_PRECONDITION`: the input does not meet the declared requirement.
`E_POSTCONDITION` / `E_TEST`: investigate the implementation or the requirement.
`E_FUEL` / `E_DEPTH`: simplify or partition the computation within profile limits.
`E_CONFLICT`: refresh the base and recheck.
`E_BUSY`: a catalog writer is active; retry after it finishes.

Do not report `static-types-checked`, `guarded`, or `tested` as `proven`.
Fuel is an execution-work counter, not model tokens or monetary cost.

## Scope

Use this profile for pure data tools. There is no filesystem, network, model,
process or credential access from FORMA source. Host CLI adapters perform file I/O.
Do not invent `spawn`, `infer`, imports or other unimplemented syntax.
Model routing and agent spawning remain future runtime profiles.
