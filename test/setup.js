import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

// Tests must never load the operator's .env, cookies or persisted account jobs.
for (const key of Object.keys(process.env)) {
  if (/^(METING_|ADMIN_|HTTP_|HTTPS_|SSL_)/.test(key)) delete process.env[key]
}
process.env.NODE_ENV = 'production'
process.env.LOG_LEVEL = 'silent'
process.env.DOTENV_CONFIG_QUIET = 'true'
const originalCwd = process.cwd()
const tempRoot = resolve(tmpdir())
const runtime = mkdtempSync(join(tempRoot, 'meting-test-'))
process.chdir(runtime)
process.once('exit', () => {
  if (dirname(runtime) === tempRoot && basename(runtime).startsWith('meting-test-')) {
    process.chdir(originalCwd)
    rmSync(runtime, { recursive: true, force: true })
  }
})
