import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loadHarnesses } from './manifests.js';

// usage: npm run sandbox:build
// builds the shared base image, then one image per harness that has its own dockerfile
function build(dockerfile: string, image: string) {
  console.log(`building ${image} from ${dockerfile}`);
  let r = spawnSync('docker', ['build', '-f', dockerfile, '-t', image, '.'], { stdio: 'inherit' });
  assert(r.status === 0, `docker build failed for ${image}`);
}

build('harnesses/Dockerfile', 'cucumber-harness-base');
for (let h of await loadHarnesses('harnesses')) {
  if (h.dockerfile) build(join(h.dir, h.dockerfile), h.image);
}
