import { spawnSync } from 'node:child_process'

for (const step of ['build-rebooter.mjs', 'run-tests.mjs']) {
  const run = spawnSync(process.execPath, [step], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
