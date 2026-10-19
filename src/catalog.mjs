import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { VERSION, fail, stable, json } from './diagnostic.mjs';
import { compile, checkProgram, typeName } from './checker.mjs';
import { semantic, assignIds, parseBody } from './parser.mjs';
import { describe, run } from './boundary.mjs';
import { requireVerified } from './verification.mjs';

export const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const idPattern = /^[0-9a-f]{64}$/;
export function readText(file, max = 4194304) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) fail('E_FILE_LIMIT', 'Expected a regular file within the size limit.', {}, { file, maximumBytes: max });
  return fs.readFileSync(file, 'utf8');
}
export function parseJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value === 'number') {
      if (!context?.source) fail('E_HOST_VERSION', 'A Node.js version supporting JSON source context is required.');
      if (!/^-?(0|[1-9][0-9]*)$/.test(context.source) || !Number.isSafeInteger(value)) {
        fail('E_JSON_NUMBER', 'JSON numbers must be safe decimal integer literals. Encode large Int values as decimal strings.');
      }
    }
    return value;
  });
}
export function readJSON(file) {
  try { return parseJSON(readText(file)); }
  catch (e) { if (e instanceof SyntaxError) fail('E_JSON', 'Invalid JSON file.', {}, { file }); throw e; }
}
function writeAtomic(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, json(data) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export class Catalog {
  constructor(directory = '.forma') { this.directory = path.resolve(directory); }
  init() {
    fs.mkdirSync(path.join(this.directory, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(this.directory, 'candidates'), { recursive: true });
  }
  index() {
    const file = path.join(this.directory, 'index.json');
    const index = fs.existsSync(file) ? readJSON(file) : { engine: VERSION, heads: {}, accepted: {} };
    if (index.engine !== VERSION) fail('E_VERSION', 'Catalog engine version is not supported.', {}, { expected: VERSION, actual: index.engine });
    return index;
  }
  locked(action) {
    this.init(); const lock = path.join(this.directory, '.lock');
    try { fs.mkdirSync(lock); }
    catch (e) { if (e.code === 'EEXIST') fail('E_BUSY', 'Catalog is locked by another writer. Retry after it finishes.'); throw e; }
    try { return action(); } finally { fs.rmdirSync(lock); }
  }
  saveObject(kind, payload) {
    const id = digest(payload), file = path.join(this.directory, kind, `${id}.json`);
    if (fs.existsSync(file)) this.loadObject(kind, id);
    else writeAtomic(file, { id, payload });
    return id;
  }
  loadObject(kind, id) {
    if (typeof id !== 'string' || !idPattern.test(id)) fail('E_REVISION', 'Revision must be a full SHA-256 identifier.');
    const file = path.join(this.directory, kind, `${id}.json`);
    if (!fs.existsSync(file)) fail('E_REVISION', 'Requested revision or candidate does not exist.', {}, { id });
    const envelope = readJSON(file);
    if (envelope.id !== id || digest(envelope.payload) !== id) fail('E_INTEGRITY', 'Stored artifact content does not match its identifier.', {}, { id });
    return envelope.payload;
  }
  artifact(revision, tool) {
    const payload = this.loadObject('artifacts', revision);
    if (payload.engine !== VERSION) fail('E_VERSION', 'Artifact engine version is not supported.');
    if (tool && payload.tool !== tool) fail('E_TOOL', 'Artifact belongs to another tool.');
    return { payload, checker: checkProgram(assignIds(structuredClone(payload.program))) };
  }
  head(tool) {
    const heads = this.index().heads;
    if (!Object.hasOwn(heads, tool)) fail('E_TOOL', `Tool not registered: ${tool}.`);
    return heads[tool];
  }
  register(source, tool, cases) {
    const checker = compile(source), report = requireVerified(checker, tool, cases);
    const payload = { engine: VERSION, tool, program: semantic(checker.program), cases };
    return this.locked(() => {
      const index = this.index();
      if (Object.hasOwn(index.heads, tool)) fail('E_EXISTS', 'Tool already exists; propose a change against its revision.', {}, { tool });
      const revision = this.saveObject('artifacts', payload);
      index.heads = { ...index.heads, [tool]: revision };
      index.accepted = { ...index.accepted, [tool]: [revision] };
      writeAtomic(path.join(this.directory, 'index.json'), index);
      return { tool, revision, report, interface: describe(checker, tool) };
    });
  }
  propose(tool, base, operations, extraCases = []) {
    // A stale-base proposal may be inspected, but cannot be accepted over a newer head.
    this.head(tool);
    if (!this.index().accepted[tool]?.includes(base)) fail('E_UNACCEPTED', 'Proposal base must be an accepted revision of this tool.');
    const { payload } = this.artifact(base, tool);
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail('E_PATCH', 'Supply 1 to 100 replace_body operations.');
    if (!Array.isArray(extraCases)) fail('E_CASES', 'Additional cases must be an array.');
    const program = structuredClone(payload.program), touched = new Set();
    for (const op of operations) {
      if (!op || Object.keys(op).sort().join(',') !== 'body,function,op' || op.op !== 'replace_body' || typeof op.body !== 'string' || typeof op.function !== 'string') fail('E_PATCH', 'Only {op: replace_body, function, body} is supported.');
      if (touched.has(op.function)) fail('E_PATCH', 'A function may be replaced only once per proposal.');
      const def = program.definitions.find(d => d.kind === 'function' && d.name === op.function);
      if (!def) fail('E_NAME', `Unknown function: ${op.function}.`);
      def.body = semantic(parseBody(op.body)); touched.add(op.function);
    }
    const checker = checkProgram(assignIds(program)), cases = [...payload.cases, ...extraCases];
    const report = requireVerified(checker, tool, cases);
    const nextPayload = { engine: VERSION, tool, program: semantic(program), cases };
    if (digest(nextPayload) === base) fail('E_NO_CHANGE', 'Proposal does not change the program or acceptance cases.');
    return this.locked(() => {
      const revision = this.saveObject('artifacts', nextPayload);
      const candidate = this.saveObject('candidates', { engine: VERSION, tool, base, revision, touched: [...touched].sort() });
      return { candidate, tool, base, revision, touched: [...touched].sort(), report, accepted: false };
    });
  }
  accept(candidate, expectedBase) {
    return this.locked(() => {
      const proposal = this.loadObject('candidates', candidate);
      if (proposal.engine !== VERSION) fail('E_VERSION', 'Candidate engine version is not supported.');
      if (proposal.base !== expectedBase) fail('E_CONFLICT', 'Candidate base differs from expected base.', {}, { expected: expectedBase, actual: proposal.base });
      const index = this.index(), actual = index.heads[proposal.tool];
      if (actual !== expectedBase) fail('E_CONFLICT', 'Accepted revision changed; rebase and check again.', {}, { expected: expectedBase, actual });
      const { payload, checker } = this.artifact(proposal.revision, proposal.tool);
      const base = this.artifact(expectedBase, proposal.tool).payload;
      // Recheck immutable baseline cases, even if a candidate file was constructed outside this API.
      if (stable(payload.cases.slice(0, base.cases.length)) !== stable(base.cases)) fail('E_CASES', 'Candidate may not remove or alter baseline cases.');
      const report = requireVerified(checker, proposal.tool, payload.cases);
      index.heads = { ...index.heads, [proposal.tool]: proposal.revision };
      index.accepted = { ...index.accepted, [proposal.tool]: [...new Set([...index.accepted[proposal.tool], proposal.revision])] };
      writeAtomic(path.join(this.directory, 'index.json'), index);
      return { tool: proposal.tool, previous: expectedBase, revision: proposal.revision, accepted: true, report };
    });
  }
  call(tool, args, revision = this.head(tool), limits = {}) {
    this.head(tool);
    if (!this.index().accepted[tool]?.includes(revision)) fail('E_UNACCEPTED', 'Tool call requires an accepted revision.');
    const { checker } = this.artifact(revision, tool);
    return { tool, revision, ...run(checker, tool, args, limits) };
  }
  describe(tool, revision = this.head(tool)) {
    const { payload, checker } = this.artifact(revision, tool);
    return { revision, ...describe(checker, tool), acceptanceCases: payload.cases.length, evidence: 'tested', proof: false };
  }
  find(query = '', inputType, outputType) {
    return Object.entries(this.index().heads).map(([tool, revision]) => {
      const { checker } = this.artifact(revision, tool), def = checker.functions.get(tool);
      return { tool, revision, params: def.params, returns: typeName(def.returns), effects: [] };
    }).filter(t => t.tool.toLowerCase().includes(query.toLowerCase()) && (!inputType || t.params.some(p => typeName(p.type) === inputType)) && (!outputType || t.returns === outputType));
  }
}
