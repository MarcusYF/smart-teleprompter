// No pipelines: one failing scenario fails the command. Live Jev is opt-in.
import { spawnSync } from 'node:child_process';
const extra = process.argv.slice(2);
for (const lang of ['en', 'zh']) {
  for (const scenario of ['read', 'adlib', 'skip', 'pause']) {
    const r = spawnSync(process.execPath, ['test/native-e2e.mjs', '--lang', lang, '--scenario', scenario, '--rate', '1.5', ...extra], { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) process.exit(r.status || 1);
  }
}
