<#
.SYNOPSIS
通过官方 DSH 插件管理器安装或更新 session-manager-custom。

.DESCRIPTION
该脚本支持两种 bundle 目录布局：
- 嵌套布局：仓库中包含 @dsh-local/session-manager-custom。
- 独立布局：仓库根目录本身就是 bundle 根目录。

安装前会迁移旧的手动 web/cordis.patch.yml 注册；旧配置会先备份，
成功后默认删除临时备份（除非使用 -KeepBackup）。回收站和备份区不会被处理。
交互运行时，成功或失败后都会等待按 Enter；自动化或管道执行请使用 -NoPause，
也可以设置环境变量 DSH_NONINTERACTIVE=1。

.PARAMETER ProfileName
DSH profile 名称，默认 web。

.PARAMETER KeepBackup
保留迁移前的 cordis.patch.yml 备份。

.PARAMETER NoPause
脚本结束后不等待按 Enter。

.NOTES
支持平台：Windows。
PowerShell 运行版本基线：
- 最低版本：Windows PowerShell 5.1。
- 已验证版本：Windows PowerShell 5.1.26100.9168、Windows 上的 PowerShell 7.6.5（pwsh）。
#>
#Requires -Version 5.1

param(
  [string]$ProfileName = 'web',
  [switch]$KeepBackup,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-DshHome {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    return $env:DSH_HOME
  }
  return Join-Path $HOME '.dsh'
}

# 只在脚本所属仓库根目录和其内部嵌套 bundle 中查找，不向父目录越界探测。
function Resolve-BundleRoot {
  $scriptDir = $PSScriptRoot
  $root = Split-Path -Parent $scriptDir
  $candidates = @(
    $root,
    (Join-Path $root '@dsh-local\session-manager-custom')
  )

  foreach ($candidate in $candidates) {
    $manifest = Join-Path $candidate 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { continue }

    try {
      $package = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      continue
    }

    $bundle = $package.dsh
    if ($null -eq $bundle -or $null -eq $bundle.bundle) { continue }
    $patchRelative = [string]$bundle.bundle.patch
    if ([string]::IsNullOrWhiteSpace($patchRelative)) { continue }

    $patchPath = Join-Path $candidate $patchRelative
    if (Test-Path -LiteralPath $patchPath) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw '找不到可作为 DSH bundle 安装的插件根目录。请确认 install.ps1 与插件文件保持原有目录结构。'
}

# 识别旧 web/cordis.patch.yml 中由本插件使用的手动注册项。
function Test-LegacyRegistration {
  param([string]$PatchPath)

  if (-not (Test-Path -LiteralPath $PatchPath)) { return $false }
  $content = Get-Content -LiteralPath $PatchPath -Raw -Encoding UTF8
  return $content -match '(?m)^\s*-\s*id:\s*session-manager-custom\s*(?:#.*)?$'
}

# 先备份完整 patch，再按顶层 insert 块移除本插件旧注册；返回备份路径供成功后清理。
function Remove-LegacyRegistration {
  param(
    [string]$ProfileDir,
    [string]$PatchPath
  )

  if (-not (Test-LegacyRegistration -PatchPath $PatchPath)) { return $null }

  $backupDir = Join-Path $ProfileDir '.dsh-local-install-backup'
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupName = 'cordis.patch.' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.yml'
  $backupPath = Join-Path $backupDir $backupName
  Copy-Item -LiteralPath $PatchPath -Destination $backupPath -Force

  $lines = @(Get-Content -LiteralPath $PatchPath -Encoding UTF8)
  $result = New-Object System.Collections.Generic.List[string]
  $index = 0

  while ($index -lt $lines.Count) {
    $line = $lines[$index]
    $trimmed = $line.Trim()

    if ($trimmed -match '^- insert\s*:' -and $line -match '^-\s') {
      $blockStart = $index
      $blockEnd = $index + 1

      while ($blockEnd -lt $lines.Count -and -not ($lines[$blockEnd] -match '^-\s')) {
        $blockEnd++
      }

      $block = @($lines[$blockStart..($blockEnd - 1)])
      $blockText = $block -join "`n"
      $hasLegacyId = $blockText -match '(?m)^\s*-\s*id:\s*session-manager-custom\s*(?:#.*)?$'

      if (-not $hasLegacyId) {
        foreach ($item in $block) { $result.Add($item) }
      }

      $index = $blockEnd
      continue
    }

    $result.Add($line)
    $index++
  }

  $remaining = $result -join "`n"
  if (-not ($remaining -match '(?m)^\s*-\s')) {
    Set-Content -LiteralPath $PatchPath -Value '[]' -Encoding UTF8
  } else {
    Set-Content -LiteralPath $PatchPath -Value ($remaining.TrimEnd() + "`n") -Encoding UTF8
  }

  return $backupPath
}

# 安装成功后按 -KeepBackup 决定是否删除本次迁移产生的临时备份。
function Remove-TemporaryBackup {
  param([string]$BackupPath)

  if (-not $KeepBackup -and -not [string]::IsNullOrWhiteSpace($BackupPath) -and (Test-Path -LiteralPath $BackupPath)) {
    Remove-Item -LiteralPath $BackupPath -Force
    $backupDir = Split-Path -Parent $BackupPath
    $remaining = @(Get-ChildItem -LiteralPath $backupDir -Force -ErrorAction SilentlyContinue)
    if ($remaining.Count -eq 0) {
      Remove-Item -LiteralPath $backupDir -Force
    }
  }
}

# 仅在可交互控制台中等待输入，自动化环境和重定向输入不会停住流程。
function Wait-ForExit {
  if ($NoPause -or $env:DSH_NONINTERACTIVE -eq '1') { return }
  if ($Host.Name -notlike '*ConsoleHost*') { return }

  try {
    if ([Console]::IsInputRedirected) { return }
  } catch {
    return
  }

  Read-Host '按 Enter 关闭。'
}

try {
  $dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $dshCommand) {
    throw '找不到 dsh 命令；请先安装 DeepSeek Harness。'
  }

  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpmCommand) {
    throw 'dsh plugin 需要 pnpm；请安装并配置 pnpm 后重试。'
  }

  $bundleRoot = Resolve-BundleRoot
  $dshHomePath = Get-DshHome
  $profileDir = Join-Path (Join-Path $dshHomePath 'profiles') $ProfileName
  $profilePatch = Join-Path $profileDir 'cordis.patch.yml'
  $cacheDir = Join-Path $profileDir '.dsh-local-install'
  $backupPath = $null

  New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
  Get-ChildItem -LiteralPath $cacheDir -Filter '*.tgz' -File -ErrorAction SilentlyContinue | Remove-Item -Force

  Write-Host "检测到 DSH profile: $profileDir"
  Write-Host "插件 bundle 根目录: $bundleRoot"
  Write-Host "安装缓存目录: $cacheDir"

  if (Test-LegacyRegistration -PatchPath $profilePatch) {
    Write-Host '检测到旧的手动 cordis.patch.yml 注册，先备份并移除该注册。'
    $backupPath = Remove-LegacyRegistration -ProfileDir $profileDir -PatchPath $profilePatch
  }

  Write-Host '正在打包插件并安装到 DSH profile...'
  Push-Location $bundleRoot
  try {
    & pnpm pack --pack-destination $cacheDir | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm pack 失败，退出码: $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  $tarball = Get-ChildItem -LiteralPath $cacheDir -Filter '*.tgz' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($null -eq $tarball) {
    throw 'pnpm pack 完成后没有找到插件 tarball。'
  }

  Write-Host "插件 tarball: $($tarball.FullName)"

  $profileManifest = Join-Path $profileDir 'package.json'
  $hasExistingRegistration = $false
  if (Test-Path -LiteralPath $profileManifest) {
    $profile = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $dependencies = $profile.dependencies
    if ($null -ne $dependencies) {
      foreach ($property in $dependencies.PSObject.Properties) {
        if ($property.Name -eq '@dsh-local/session-manager-custom') {
          $hasExistingRegistration = $true
          break
        }
      }
    }
  }

  if ($hasExistingRegistration) {
    Write-Host '检测到旧的标准注册，先移除旧 package 和 lock 条目。'
    & dsh plugin --profile $ProfileName remove '@dsh-local/session-manager-custom'
    if ($LASTEXITCODE -ne 0) {
      throw "移除旧插件注册失败，退出码: $LASTEXITCODE"
    }
    Write-Host '旧注册已移除。'
  }

  Write-Host '正在使用官方 dsh plugin 从 tarball 安装/更新插件...'
  & dsh plugin --profile $ProfileName add $tarball.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin 安装失败，退出码: $LASTEXITCODE"
  }

  $profileManifest = Join-Path $profileDir 'package.json'
  if (Test-Path -LiteralPath $profileManifest) {
    $profile = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $dependencies = $profile.dependencies
    $bundles = $profile.dsh.profile.bundles

    if ($null -eq $dependencies.'@dsh-local/session-manager-custom' -or $bundles -notcontains '@dsh-local/session-manager-custom') {
      throw '安装命令已完成，但 profile 中未找到标准 bundle 注册，请检查 dsh plugin 输出。'
    }
  }

  Remove-TemporaryBackup -BackupPath $backupPath

  $legacyParent = Join-Path $dshHomePath 'profiles\node_modules\@dsh-local\session-manager-custom'
  if (Test-Path -LiteralPath $legacyParent) {
    Write-Warning "旧的父级手动插件目录仍存在: $legacyParent"
    Write-Warning '新安装验证成功后，可按需删除该目录；回收站和备份区目录不受影响。'
  }

  Write-Host "已通过标准 DSH bundle 注册安装/更新插件到 profile: $ProfileName"
  Write-Host '请重启 DSH 并刷新 Web 页面。'

  Wait-ForExit
} catch {
  Write-Host "ERROR: $_" -ForegroundColor Red
  Wait-ForExit
  throw
}
