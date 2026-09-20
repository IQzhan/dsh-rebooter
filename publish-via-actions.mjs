/**
 * publish-via-actions.mjs — dispatch publish.yml and watch until it ends.
 *
 * usage: node publish-via-actions.mjs 1.0.1
 *
 * Needs `gh` logged in, a clean push of main, and the npm Trusted Publisher
 * already set for this repository. Exit 0 success, 1 failure, 2 timeout.
 */
import { spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const version = process.argv[2]
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '')) {
  console.error('usage: node publish-via-actions.mjs <version>')
  process.exit(1)
}

const TIMEOUT_MS = Number(process.env.DSH_PUBLISH_TIMEOUT_MS) || 20 * 60 * 1000
const POLL_MS = 10_000
const shell = process.platform === 'win32'

function gh(args, options = {}) {
  const run = spawnSync('gh', args, {
    encoding: 'utf8',
    shell,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || '').trim() || `gh ${args.join(' ')}`
    throw new Error(detail)
  }
  return (run.stdout || '').trim()
}

function npmViewVersion() {
  const run = spawnSync('npm', ['view', 'dsh-rebooter', 'version'], {
    encoding: 'utf8',
    shell,
  })
  return run.status === 0 ? (run.stdout || '').trim() : ''
}

const started = Date.now()
gh(['workflow', 'run', 'publish.yml', '-f', `version=${version}`])
console.log(`triggered publish.yml for ${version}`)

let runId
for (let i = 0; i < 30; i++) {
  await sleep(2000)
  const rows = JSON.parse(gh([
    'run', 'list', '--workflow', 'publish.yml', '--limit', '8',
    '--json', 'databaseId,status,createdAt,event',
  ]))
  const match = rows.find((row) => (
    row.event === 'workflow_dispatch'
    && new Date(row.createdAt).getTime() >= started - 15_000
  ))
  if (match) {
    runId = String(match.databaseId)
    break
  }
}
if (!runId) {
  console.error('could not find the new workflow run')
  process.exit(1)
}

const url = JSON.parse(gh(['run', 'view', runId, '--json', 'url'])).url
console.log(`watching ${url}`)

while (Date.now() - started < TIMEOUT_MS) {
  const view = JSON.parse(gh(['run', 'view', runId, '--json', 'status,conclusion,url']))
  const stamp = new Date().toISOString()
  console.log(`${stamp}  ${view.status}${view.conclusion ? ` / ${view.conclusion}` : ''}`)
  if (view.status !== 'completed') {
    await sleep(POLL_MS)
    continue
  }
  if (view.conclusion === 'success') {
    for (let i = 0; i < 18; i++) {
      const published = npmViewVersion()
      if (published === version) {
        console.log(`published dsh-rebooter@${version}`)
        process.exit(0)
      }
      await sleep(5000)
    }
    console.error(`Actions succeeded but npm does not yet show ${version}`)
    process.exit(1)
  }
  console.error(`failed: ${view.conclusion}\n${view.url}`)
  try { gh(['run', 'view', runId, '--log-failed'], { inherit: true }) } catch { /* already printed */ }
  process.exit(1)
}

console.error(`timed out after ${Math.round(TIMEOUT_MS / 1000)}s\n${url}`)
process.exit(2)
