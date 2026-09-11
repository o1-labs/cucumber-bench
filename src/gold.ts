import assert from 'node:assert/strict';

export { fieldsOf };

// for a grader's gold(raw, id): the raw private case as a record of unknown fields, so the
// grader checks each field it reads and never trusts the json shape
function fieldsOf(raw: unknown, id: string, grader: string): { [field: string]: unknown } {
  assert(raw !== null && typeof raw === 'object' && !Array.isArray(raw), `${grader}: case ${id} has no gold object`);
  return raw as { [field: string]: unknown };
}
