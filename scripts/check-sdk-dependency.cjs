#!/usr/bin/env node
'use strict'

const MAINTAINED_PACKAGE = '@likenttt/garmin-connect'
const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)'
const PINNED_GIT = /^git\+https:\/\/github\.com\/Likenttt\/garmin-connect(?:\.git)?#[0-9a-fA-F]{40}$/
const PINNED_ALIAS = new RegExp(`^npm:@likenttt/garmin-connect@(${VERSION})$`)
const OWN_REPOSITORY = /^(?:(?:git\+)?https:\/\/github\.com\/|git@github\.com:)Likenttt\/garmin-connect(?:\.git)?$/

/** Pure release gate. Never loads credentials, contacts a registry or calls SDK methods. */
function validateSdkDependency({ manifest, sdkPackage, GarminConnect, methods, lockfile } = {}) {
  const errors = []
  const dependency = manifest?.dependencies?.['garmin-connect']
  const git = typeof dependency === 'string' && PINNED_GIT.test(dependency)
  const alias = typeof dependency === 'string' ? PINNED_ALIAS.exec(dependency) : null
  if (!git && !alias) errors.push('DEPENDENCY_MUST_PIN_OWN_GIT_SHA_OR_EXACT_SCOPED_NPM_VERSION')
  if (sdkPackage?.name !== MAINTAINED_PACKAGE) errors.push('SDK_PACKAGE_NAME_MISMATCH')
  const repository = typeof sdkPackage?.repository === 'string'
    ? sdkPackage.repository : sdkPackage?.repository?.url
  if (typeof repository !== 'string' || !OWN_REPOSITORY.test(repository)) {
    errors.push('SDK_REPOSITORY_MISMATCH')
  }
  if (alias && sdkPackage?.version !== alias[1]) errors.push('SDK_ALIAS_VERSION_MISMATCH')
  // A same-version Git package may be reused when only the manifest changes.
  // Validate source checkouts' lockfiles while allowing installed tarballs,
  // which deliberately do not ship package-lock.json, to use identity checks.
  if (alias && lockfile !== undefined) {
    if (lockfile?.packages?.['']?.dependencies?.['garmin-connect'] !== dependency) {
      errors.push('SDK_LOCK_SPEC_MISMATCH')
    }
    const locked = lockfile?.packages?.['node_modules/garmin-connect']
    if (locked?.name !== MAINTAINED_PACKAGE || locked?.version !== alias[1]) {
      errors.push('SDK_LOCK_PACKAGE_MISMATCH')
    }
    const tarball = `https://registry.npmjs.org/@likenttt/garmin-connect/-/garmin-connect-${alias[1]}.tgz`
    if (locked?.resolved !== tarball) errors.push('SDK_LOCK_REGISTRY_RESOLUTION_MISMATCH')
  }
  const catalogValid = Array.isArray(methods) && methods.length === 13
    && new Set(methods).size === 13
    && methods.every(method => typeof method === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method))
  if (!catalogValid) errors.push('HEALTH_METHOD_CATALOG_INVALID')
  let missingMethodCount = 0
  if (catalogValid) {
    for (const method of methods) {
      if (typeof GarminConnect?.prototype?.[method] !== 'function') missingMethodCount += 1
    }
    if (missingMethodCount > 0) errors.push('SDK_HEALTH_METHODS_MISSING')
  }
  return {
    ok: errors.length === 0,
    dependencySource: git ? 'maintained-git-sha' : alias ? 'maintained-npm-exact' : 'unsupported',
    methodCount: catalogValid ? methods.length : 0,
    missingMethodCount,
    errors,
  }
}

module.exports = { validateSdkDependency }

if (require.main === module) {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const manifest = require('../package.json')
    const sdkPackage = require('garmin-connect/package.json')
    const { GarminConnect } = require('garmin-connect')
    const { SDK_HEALTH_METHODS } = require('../lib/health-tools.js')
    const lockPath = path.join(__dirname, '../package-lock.json')
    const lockfile = fs.existsSync(lockPath)
      ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : undefined
    const result = validateSdkDependency({
      manifest, sdkPackage, GarminConnect, lockfile,
      methods: SDK_HEALTH_METHODS,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch {
    // Module loader messages may contain local paths. Emit only a fixed code.
    process.stdout.write(JSON.stringify({
      ok: false, dependencySource: 'unknown', methodCount: 0, missingMethodCount: 0,
      errors: ['SDK_DEPENDENCY_CHECK_LOAD_FAILED'],
    }) + '\n')
    process.exitCode = 1
  }
}
