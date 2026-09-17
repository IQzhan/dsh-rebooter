// Shared plumbing for the suites: where scratch data goes, and where DSH lives.
//
// Scratch data lives INSIDE the checkout (`.tmp/`), never the system temp
// directory. The harness home is RESOLVED (`DSH_HOME`, else `~/.dsh`).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(fileURLToPath(import.meta.url))
export const SCRATCH = join(ROOT, '.tmp')

export function scratch(prefix) {
  mkdirSync(SCRATCH, { recursive: true })
  return mkdtempSync(join(SCRATCH, prefix))
}

export function cleanup(path) {
  if (path === undefined) return
  rmSync(path, { recursive: true, force: true })
}

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
