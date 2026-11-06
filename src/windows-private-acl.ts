import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import type { AuthDiagnosticCode } from './auth-diagnostics'
import { PublicToolError } from './utils/errors'

// Windows PowerShell 5.1 can spend tens of seconds on its first launch on a
// cold hosted runner (for example while endpoint protection scans the process).
// Keep the ACL subprocess bounded while allowing that one-time startup cost.
const WINDOWS_COMMAND_TIMEOUT_MS = 60_000
const WINDOWS_COMMAND_MAX_BUFFER_BYTES = 64 * 1024
const WINDOWS_ACL_ERROR = 'Garmin session token file could not be written'

type WindowsAclOperation =
  | 'prepare-directory'
  | 'secure-file'
  | 'verify-file'

type WindowsAclDiagnosticCode = Extract<AuthDiagnosticCode,
  | 'windows_system_root_invalid'
  | 'windows_target_invalid'
  | 'windows_powershell_unavailable'
  | 'windows_acl_timeout'
  | 'windows_acl_rejected'
>

class WindowsPrivateAclError extends PublicToolError {
  constructor(readonly authDiagnosticCode: WindowsAclDiagnosticCode) {
    super(WINDOWS_ACL_ERROR)
  }
}

export interface WindowsAclCommandOptions {
  encoding: 'utf8'
  env: Record<string, string | undefined>
  maxBuffer: number
  shell: false
  timeout: number
  windowsHide: true
}

export interface WindowsAclCommandResult {
  stdout: string
  stderr: string
}

export type WindowsAclCommandRunner = (
  file: string,
  args: readonly string[],
  options: WindowsAclCommandOptions,
) => Promise<WindowsAclCommandResult>

export interface WindowsPrivateAclDependencies {
  run?: WindowsAclCommandRunner
  systemRoot?: string
}

export interface WindowsPrivateAcl {
  /** Create atomically with an exact DACL, or read-only verify if it exists. */
  prepareDirectory(path: string): Promise<void>
  /** Replace the DACL of an existing empty file, then verify it exactly. */
  secureFile(path: string): Promise<void>
  /** Read-only verification of an existing regular file's exact DACL. */
  verifyFile(path: string): Promise<void>
}

/**
 * The script is static and passed with -EncodedCommand. Dynamic operation and
 * target values travel only through the child environment, never through a
 * shell or executable code. Windows PowerShell 5.1 is selected deliberately:
 * its .NET Framework Directory.CreateDirectory(String, DirectorySecurity)
 * overload applies the DACL atomically at directory creation.
 */
const WINDOWS_EXACT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail-Acl {
  throw 'ACL validation failed'
}

$operation = [Environment]::GetEnvironmentVariable('GARMIN_ACL_OPERATION', 'Process')
$target = [Environment]::GetEnvironmentVariable('GARMIN_ACL_TARGET', 'Process')
if ([String]::IsNullOrWhiteSpace($operation) -or [String]::IsNullOrWhiteSpace($target)) {
  Fail-Acl
}

$fullPath = [IO.Path]::GetFullPath($target)
$script:currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $script:currentSid -or $script:currentSid.Value -cnotmatch '^S-[0-9]+(?:-[0-9]+){2,15}$') {
  Fail-Acl
}

function Get-LongestTrustedUserRoot([string] $path) {
  $trustedRoots = @(
    [Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile),
    [Environment]::GetFolderPath([System.Environment+SpecialFolder]::ApplicationData),
    [Environment]::GetFolderPath([System.Environment+SpecialFolder]::LocalApplicationData)
  )
  $best = $null
  foreach ($candidate in $trustedRoots) {
    if ([String]::IsNullOrWhiteSpace($candidate)) { continue }
    $root = [IO.Path]::GetFullPath($candidate).TrimEnd([char[]] @(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    ))
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    if (
      $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
      ($null -eq $best -or $root.Length -gt $best.Length)
    ) {
      $best = $root
    }
  }
  if ($null -eq $best) { Fail-Acl }
  return $best
}

function Assert-NoReparseChain([string] $path) {
  $root = [IO.Path]::GetPathRoot($path)
  if ([String]::IsNullOrEmpty($root)) { Fail-Acl }
  $current = $root
  $relative = $path.Substring($root.Length)
  foreach ($part in ($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })) {
    $current = [IO.Path]::Combine($current, $part)
    try {
      $attributes = [IO.File]::GetAttributes($current)
    } catch [IO.FileNotFoundException] {
      continue
    } catch [IO.DirectoryNotFoundException] {
      continue
    }
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail-Acl
    }
  }
}

function New-ExactDirectorySecurity {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($script:currentSid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
    $script:currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void] $security.AddAccessRule($rule)
  return $security
}

function New-ExactFileSecurity {
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner($script:currentSid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
    $script:currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void] $security.AddAccessRule($rule)
  return $security
}

function Assert-ExactSecurity([string] $path, [bool] $directory) {
  Assert-NoReparseChain $path
  if ($directory) {
    if (-not [IO.Directory]::Exists($path)) { Fail-Acl }
    $security = [IO.Directory]::GetAccessControl(
      $path,
      ([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
    )
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    if (-not [IO.File]::Exists($path)) { Fail-Acl }
    $security = [IO.File]::GetAccessControl(
      $path,
      ([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)
    )
    $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }

  $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
  if ($owner.Value -cne $script:currentSid.Value) { Fail-Acl }
  if (-not $security.AreAccessRulesProtected) { Fail-Acl }
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1) { Fail-Acl }
  $rule = $rules[0]
  if ($rule.IsInherited) { Fail-Acl }
  if ($rule.IdentityReference.Value -cne $script:currentSid.Value) { Fail-Acl }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { Fail-Acl }
  if ([int] $rule.FileSystemRights -ne [int] [System.Security.AccessControl.FileSystemRights]::FullControl) { Fail-Acl }
  if ([int] $rule.InheritanceFlags -ne [int] $expectedInheritance) { Fail-Acl }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { Fail-Acl }
}

function Assert-ExactPrivateDirectoryChain([string] $directoryPath, [bool] $createMissing) {
  $trustedRoot = Get-LongestTrustedUserRoot $directoryPath
  Assert-NoReparseChain $trustedRoot
  if (-not [IO.Directory]::Exists($trustedRoot)) { Fail-Acl }

  $relative = $directoryPath.Substring($trustedRoot.Length).TrimStart([char[]] @(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  ))
  $components = @($relative -split '[\\/]' | Where-Object { $_.Length -gt 0 })
  # The special-folder root itself normally has Windows-managed SYSTEM/admin
  # ACEs. Require at least one app-owned exact-private directory below it.
  if ($components.Count -lt 1) { Fail-Acl }

  $current = $trustedRoot
  foreach ($component in $components) {
    $current = [IO.Path]::Combine($current, $component)
    Assert-NoReparseChain $current
    if ([IO.Directory]::Exists($current)) {
      # Existing components are read-only verified, never rewritten.
      Assert-ExactSecurity $current $true
    } elseif ([IO.File]::Exists($current) -or -not $createMissing) {
      Fail-Acl
    } else {
      # Create one component at a time so no ordinary/shared intermediate can
      # appear between the trusted special-folder root and the session parent.
      [void] [IO.Directory]::CreateDirectory($current, (New-ExactDirectorySecurity))
      Assert-ExactSecurity $current $true
    }
  }
}

switch ($operation) {
  'prepare-directory' {
    Assert-ExactPrivateDirectoryChain $fullPath $true
  }
  'secure-file' {
    Assert-ExactPrivateDirectoryChain ([IO.Path]::GetDirectoryName($fullPath)) $false
    Assert-NoReparseChain $fullPath
    if (-not [IO.File]::Exists($fullPath)) { Fail-Acl }
    [IO.File]::SetAccessControl($fullPath, (New-ExactFileSecurity))
    Assert-ExactSecurity $fullPath $false
  }
  'verify-file' {
    Assert-ExactPrivateDirectoryChain ([IO.Path]::GetDirectoryName($fullPath)) $false
    Assert-ExactSecurity $fullPath $false
  }
  default {
    Fail-Acl
  }
}
`

const ENCODED_WINDOWS_EXACT_ACL_SCRIPT = Buffer
  .from(WINDOWS_EXACT_ACL_SCRIPT, 'utf16le')
  .toString('base64')

export async function createWindowsPrivateAcl(
  dependencies: WindowsPrivateAclDependencies = {},
): Promise<WindowsPrivateAcl> {
  try {
    const systemRoot = validatedSystemRoot(
      dependencies.systemRoot ?? process.env.SystemRoot,
    )
    const powershell = win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const run = dependencies.run ?? runWindowsCommand
    const invoke = async (operation: WindowsAclOperation, path: string): Promise<void> => {
      try {
        const target = validatedWindowsTarget(path)
        const result = await run(powershell, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          ENCODED_WINDOWS_EXACT_ACL_SCRIPT,
        ], windowsCommandOptions(systemRoot, operation, target))
        if (
          Buffer.byteLength(result.stdout, 'utf8') > WINDOWS_COMMAND_MAX_BUFFER_BYTES
          || Buffer.byteLength(result.stderr, 'utf8') > WINDOWS_COMMAND_MAX_BUFFER_BYTES
        ) {
          throw windowsAclError('windows_acl_rejected')
        }
      } catch (error) {
        if (error instanceof WindowsPrivateAclError) throw error
        throw windowsAclError(windowsCommandFailureCode(error))
      }
    }

    return {
      prepareDirectory: path => invoke('prepare-directory', path),
      secureFile: path => invoke('secure-file', path),
      verifyFile: path => invoke('verify-file', path),
    }
  } catch (error) {
    if (error instanceof WindowsPrivateAclError) throw error
    throw windowsAclError('windows_acl_rejected')
  }
}

function windowsCommandOptions(
  systemRoot: string,
  operation: WindowsAclOperation,
  target: string,
): WindowsAclCommandOptions {
  return {
    encoding: 'utf8',
    env: {
      GARMIN_ACL_OPERATION: operation,
      GARMIN_ACL_TARGET: target,
      SystemRoot: systemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      WINDIR: systemRoot,
    },
    maxBuffer: WINDOWS_COMMAND_MAX_BUFFER_BYTES,
    shell: false,
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  }
}

function validatedSystemRoot(value: string | undefined): string {
  if (
    !value
    || !/^[A-Za-z]:\\/.test(value)
    || /[\0\r\n]/.test(value)
    || value.split(/[\\/]/).some(part => part === '.' || part === '..')
  ) {
    throw windowsAclError('windows_system_root_invalid')
  }
  return win32.normalize(value)
}

function validatedWindowsTarget(value: string): string {
  if (
    !/^[A-Za-z]:\\/.test(value)
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, 'utf16le') > 32_000
  ) {
    throw windowsAclError('windows_target_invalid')
  }
  const normalized = win32.normalize(value)
  if (normalized !== value) throw windowsAclError('windows_target_invalid')
  return normalized
}

const runWindowsCommand: WindowsAclCommandRunner = (
  file,
  args,
  options,
) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) {
      reject(error)
      return
    }
    resolve({ stdout, stderr })
  })
})

function windowsAclError(code: WindowsAclDiagnosticCode): PublicToolError {
  return new WindowsPrivateAclError(code)
}

function windowsCommandFailureCode(error: unknown): WindowsAclDiagnosticCode {
  try {
    if (typeof error !== 'object' || error === null) return 'windows_acl_rejected'
    const candidate = error as {
      code?: unknown
      killed?: unknown
      signal?: unknown
    }
    if (candidate.code === 'ENOENT') return 'windows_powershell_unavailable'
    if (
      candidate.code === 'ETIMEDOUT'
      || candidate.killed === true
      || candidate.signal === 'SIGTERM'
    ) {
      return 'windows_acl_timeout'
    }
  } catch {
    // Only fixed codes cross this boundary.
  }
  return 'windows_acl_rejected'
}
