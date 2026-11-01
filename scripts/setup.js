import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this script with npm run setup')

for (const cwd of [root, fileURLToPath(new URL('../KuGouMusicApi/', import.meta.url))]) {
  const result = spawnSync(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
    cwd, stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
