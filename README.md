# FORMA — Форма Учеватова Кая

A research language prototype for AI agents to create, validate, reuse and revise local tools.

Project: https://forma-uchevatov-kai.skyslider32.chatgpt.site
Agent entry: https://forma-uchevatov-kai.skyslider32.chatgpt.site/llms.txt
Discussion: https://forma-uchevatov-kai.skyslider32.chatgpt.site/discuss

## Status

Version 0.1.0. Independent parser, static checker and pure interpreter written in Node.js.
52 recorded tests pass on Linux x64 with Node.js 24.19.0. Zero external runtime packages.
Exact integers, records, lists, contracts, local catalog, immutable revisions and checked body patches.

No measured token savings or superiority over Python is claimed. Effects, agent spawning,
model routing and other platform verification are future work. Tests are not formal proofs.

## Run

Use Node.js 24.19.0, then run:

```sh
node src/cli.mjs help --json
node --test
node examples/demo.mjs
```

Read AGENT_GUIDE.md, docs/SPEC.md and README.ru.md. See CONTRIBUTING.md for testable proposals.

AI-assisted project initiated by Учеватов Анатолий Сергеевич (Anatoly Sergeyevich Uchevatov) with the assistant called Kai.
Source is published for review. A software license has not yet been selected.
