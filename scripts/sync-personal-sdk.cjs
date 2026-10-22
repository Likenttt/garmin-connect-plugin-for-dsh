#!/usr/bin/env node
// Refresh the audited SDK source snapshot after its independent repository is committed.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

if (!process.argv[2]) throw new Error('Usage: node scripts/sync-personal-sdk.cjs /path/to/connect-personal-api-ts')
const source = path.resolve(process.argv[2])
const destination = path.join(__dirname, '../src/vendor/connect-personal-api')
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'LICENSE', 'NOTICE'], { cwd: source, encoding: 'utf8' }).trim()
if (dirty) throw new Error('Commit the SDK runtime and attribution files before refreshing its snapshot')
const names = ['client.ts', 'errors.ts', 'validation.ts', 'generated.ts', 'index.ts']
fs.mkdirSync(destination, { recursive: true })
const files = {}
for (const name of names) {
  const bytes = fs.readFileSync(path.join(source, 'src', name))
  fs.writeFileSync(path.join(destination, name), bytes)
  files[name] = crypto.createHash('sha256').update(bytes).digest('hex')
}
for (const name of ['LICENSE', 'NOTICE']) {
  fs.copyFileSync(path.join(source, name), path.join(destination, name))
}
fs.writeFileSync(path.join(destination, 'provenance.json'), JSON.stringify({
  repository: 'https://github.com/Likenttt/connect-personal-api-ts',
  commit,
  package: '@likenttt/connect-personal-api-ts',
  version: JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version,
  files,
}, null, 2) + '\n')
console.log(`Personal SDK source snapshot updated from ${commit}`)
