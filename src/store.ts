import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

export { slimResults };

// results.jsonl for the pinned archive: every record without modelRequests and without the
// trace's input copies (source, transformedSource). those duplicate the public cases the
// repo already holds and are the bulk of a run. streamed line by line: a full-suite run is
// hundreds of megabytes, more than one string can hold. returns the record count
async function slimResults(src: string, dest: string): Promise<number> {
  let out = createWriteStream(dest);
  let count = 0;
  for await (let line of createInterface({ input: createReadStream(src), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let r = JSON.parse(line);
    delete r.run.modelRequests;
    if (r.run.trace) {
      delete r.run.trace.source;
      delete r.run.trace.transformedSource;
    }
    if (!out.write(JSON.stringify(r) + '\n')) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    count++;
  }
  await new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });
  return count;
}
