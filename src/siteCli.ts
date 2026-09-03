import assert from 'node:assert/strict';
import { publishSite } from './site.js';

// usage: npm run site -- runs/<runId> [runs/<runId> ...]
// builds docs/ from the runs named. npm run store does this for the pinned runs on its own;
// this command is for a custom list.
let runDirs = process.argv.slice(2);
assert(runDirs.length > 0, 'usage: npm run site -- runs/<runId> [runs/<runId> ...]');
await publishSite(runDirs);
