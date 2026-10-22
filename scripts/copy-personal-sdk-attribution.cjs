const { copyFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const root = join(__dirname, '..')
mkdirSync(join(root, 'lib/vendor/connect-personal-api'), { recursive: true })
for (const file of ['LICENSE', 'NOTICE', 'provenance.json']) {
  copyFileSync(join(root, 'src/vendor/connect-personal-api', file), join(root, 'lib/vendor/connect-personal-api', file))
}
