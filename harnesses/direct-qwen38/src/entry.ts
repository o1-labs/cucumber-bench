import { readInput, generateVia, respond } from '../../lib.js';

const { publicCase: c, proxyUrl, token, models } = await readInput();
try {
  const documents = (c.docs ?? []).map((doc) => JSON.stringify({ file_path: doc.title, text: doc.text })).join('\n');
  const prompt = [c.instructions, c.input, documents, 'Retrieved snippets (JSON array):'].join('\n\n');
  // Omit temperature so the proxy supplies the recorded benchmark default.
  const output = await generateVia(proxyUrl, token, models.main)(prompt);
  respond({ output });
} catch (error) {
  respond({ error: String(error instanceof Error ? error.message : error) });
}
