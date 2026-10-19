import { fail } from './diagnostic.mjs';
import { decode, encode } from './boundary.mjs';
import { Runtime } from './runtime.mjs';

export function parseCSV(text) {
  if (Buffer.byteLength(text) > 1048576) fail('E_CSV_LIMIT', 'CSV exceeds 1 MiB.');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', state = 'start';
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRow = () => { endField(); rows.push(row); row = []; if (rows.length > 10001) fail('E_CSV_LIMIT', 'CSV has more than 10000 data rows.'); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else state = 'closed';
      } else field += ch;
    } else if (ch === ',') endField();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else if (state === 'closed') fail('E_CSV', 'Unexpected content after a closing quote.', {}, { offset: i });
    else if (ch === '"') {
      if (state !== 'start') fail('E_CSV', 'Quote inside an unquoted field.', {}, { offset: i });
      state = 'quoted';
    } else { state = 'plain'; field += ch; }
  }
  if (state === 'quoted') fail('E_CSV', 'Unclosed quoted field.');
  if (row.length || field.length || state !== 'start') endRow();
  if (!rows.length) fail('E_CSV', 'CSV requires a header row.');
  const headers = rows.shift();
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) fail('E_CSV', 'Headers must be nonempty and unique.');
  rows.forEach((r, i) => { if (r.length !== headers.length) fail('E_CSV', 'Row length differs from the header.', {}, { row: i + 2, expected: headers.length, actual: r.length }); });
  return { headers, rows };
}
export function inspectCSV(text) {
  const { headers, rows } = parseCSV(text);
  return { columns: headers, rowCount: rows.length, sample: rows.slice(0, 5).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]]))), sampleTruncated: rows.length > 5, inference: 'none; all cells shown as text' };
}
export function importCSV(checker, recordName, text) {
  const record = checker.records.get(recordName);
  if (!record) fail('E_TYPE_NAME', 'CSV target must be a declared record.');
  if (record.fields.some(f => !['Text', 'Int', 'Bool'].includes(f.type))) fail('E_CSV_TYPE', 'CSV supports flat Text, Int and Bool fields.');
  const { headers, rows } = parseCSV(text);
  if (JSON.stringify([...headers].sort()) !== JSON.stringify(record.fields.map(f => f.name).sort())) fail('E_INPUT_FIELDS', 'CSV headers must exactly match record fields.', {}, { expected: record.fields.map(f => f.name), actual: headers });
  const raw = rows.map(r => Object.fromEntries(headers.map((h, i) => {
    const type = record.fields.find(f => f.name === h).type;
    let value = r[i];
    if (type === 'Bool') {
      if (!['true', 'false'].includes(value)) fail('E_CSV_TYPE', 'Bool cells must be true or false.');
      value = value === 'true';
    }
    return [h, value];
  })));
  const runtime = new Runtime(checker);
  return encode(decode(raw, { list: recordName }, runtime), runtime);
}
