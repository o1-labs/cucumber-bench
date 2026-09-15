// results.jsonl, one record per line, read and written as a stream: a full run's file is larger
// than the longest string node can hold
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

export { readJsonl, writeJsonl };

async function readJsonl<T = any>(path: string): Promise<T[]> {
  let records: T[] = [];
  let lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (let line of lines) if (line.trim()) records.push(JSON.parse(line));
  return records;
}

function writeJsonl(path: string, records: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = createWriteStream(path);
    out.on('error', reject);
    out.on('finish', resolve);
    for (let r of records) out.write(JSON.stringify(r) + '\n');
    out.end();
  });
}
