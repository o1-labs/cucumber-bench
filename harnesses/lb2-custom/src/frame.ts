// the pure part of the frame step: reading the frame model's answer (what the question requires,
// the terms to look for)
export { parseFrame, type Frame };

type Frame = { constraints: string[]; terms: string[] };

const SECTIONS = ['constraints', 'terms'] as const;

// the two sections of the frame answer, one item per line, bullets and numbering removed; a
// missing section is empty
function parseFrame(answer: string): Frame {
  let frame: Frame = { constraints: [], terms: [] };
  let section: (typeof SECTIONS)[number] | undefined;
  for (let raw of answer.split('\n')) {
    let line = raw.trim().replace(/^[-*•]\s*|^\d+[.)]\s*/, '').replace(/^\*\*|\*\*$/g, '');
    if (!line) continue;
    let head = line.match(/^(constraints|terms)\s*:\s*(.*)$/i);
    if (head) {
      section = head[1].toLowerCase() as (typeof SECTIONS)[number];
      line = head[2].trim();
      if (!line) continue;
    }
    if (section) frame[section].push(line);
  }
  return frame;
}
