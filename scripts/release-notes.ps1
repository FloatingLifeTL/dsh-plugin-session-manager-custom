<#
.SYNOPSIS
校验版本说明或提取 GitHub Release 正文。

.DESCRIPTION
脚本提供两种互斥模式：
- -Check：只校验版本说明文件的命名、目录层级和 H1。
- -Body：读取版本说明 Markdown，去掉 H1 和空行，输出 Release 正文。

该脚本不修改 Markdown 源文件，也不修改 GitHub Release 数据。

.PARAMETER Check
执行只读校验，默认在未指定模式时启用。

.PARAMETER Body
提取版本说明正文并输出到 stdout 或 -OutputPath 指定文件。

.PARAMETER Version
要处理的版本，例如 v0.5.2；省略时读取 package.json 的 version。

.PARAMETER OutputPath
可选输出文件；未指定时正文写入 stdout。

.EXAMPLE
.\scripts\release-notes.ps1 -Check
.\scripts\release-notes.ps1 -Body -Version v0.5.2

.NOTES
支持平台：Windows。
PowerShell 运行版本基线：
- 最低版本：Windows PowerShell 5.1。
- 已验证版本：Windows 上的 PowerShell 7.6.5（pwsh）。
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Body,
  [string]$Version = '',
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 脚本位于仓库的 scripts/ 目录，仓库根目录是它的上一级目录。
$root = Split-Path -Parent $PSScriptRoot

# 未指定模式时默认只做只读校验，避免误改发布内容。
if (-not ($Check -or $Body)) {
  $Check = $true
}

# 校验和正文提取是两个互斥流程，不能同时执行。
if ($Check -and $Body) {
  throw 'Choose exactly one mode: -Check or -Body.'
}

# 从 package.json 读取当前公开版本，所有校验都以它作为基准。
function Read-ManifestVersion {
  param([string]$Root)

  $path = Join-Path $Root 'package.json'
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing package.json: $path"
  }

  $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = [string]$manifest.version
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'package.json does not declare a version.'
  }

  return $version
}

# 校验版本说明的文件名、目录层级和 H1；不访问 GitHub。
function Assert-ReleaseNoteLayout {
  param([string]$Root)

  # 当前版本文件名由 package.json 的 version 生成，例如 v0.5.2.md。
  $version = Read-ManifestVersion -Root $Root
  $tag = "v$version"
  $releasesRoot = Join-Path $Root 'docs\releases'
  if (-not (Test-Path -LiteralPath $releasesRoot)) {
    throw "Missing release-note directory: $releasesRoot"
  }

  # 当前版本说明必须存在，且第一行必须是对应 Tag 的 H1。
  $latestPath = Join-Path $releasesRoot "$tag.md"
  if (-not (Test-Path -LiteralPath $latestPath)) {
    throw "Latest release note is missing: $latestPath"
  }

  $latestLines = @(Get-Content -LiteralPath $latestPath -Encoding UTF8)
  if ($latestLines.Count -eq 0 -or $latestLines[0] -ne "# $tag") {
    throw "Latest release note must start with '# $tag'."
  }

  # docs/releases/README.md 是规范说明，不是某个版本的 Release 正文。
  $topLevelFiles = @(Get-ChildItem -LiteralPath $releasesRoot -File -Force)
  $allowedTopLevelFiles = @('README.md', "$tag.md")
  foreach ($file in $topLevelFiles) {
    if ($allowedTopLevelFiles -notcontains $file.Name) {
      throw "Unexpected file in docs/releases: $($file.Name)"
    }
  }

  # 历史版本说明统一放在 history/，并且文件名必须与 Tag 对应。
  $historyRoot = Join-Path $releasesRoot 'history'
  if (-not (Test-Path -LiteralPath $historyRoot)) {
    throw "Missing historical release-note directory: $historyRoot"
  }

  foreach ($file in @(Get-ChildItem -LiteralPath $historyRoot -File -Force)) {
    if ($file.Extension -ne '.md') {
      throw "Unexpected historical release-note file: $($file.Name)"
    }
    if ($file.BaseName -notmatch '^v\d') {
      throw "Historical release note must use a tag filename: $($file.Name)"
    }

    # 历史版本文件的 H1 必须与其文件名中的 Tag 完全一致。
    $lines = @(Get-Content -LiteralPath $file.FullName -Encoding UTF8)
    if ($lines.Count -eq 0 -or $lines[0] -ne "# $($file.BaseName)") {
      throw "Historical release note must start with '# $($file.BaseName)': $($file.Name)"
    }
  }

  # history/ 下面只允许 Markdown 文件，避免混入其他维护产物。
  foreach ($file in @(Get-ChildItem -LiteralPath $historyRoot -Recurse -File -Force)) {
    if ($file.Extension -ne '.md') {
      throw "Unexpected file under docs/releases/history: $($file.FullName)"
    }
  }
}

# Markdown 文件保留 H1；GitHub Release 正文只使用 H1 之后的内容。
function Get-ReleaseBody {
  param([string]$Root, [string]$Version)

  # 无论用户传 v0.5.2 还是 0.5.2，统一成带 v 的 Tag。
  $tag = if ($Version.StartsWith('v', [System.StringComparison]::OrdinalIgnoreCase)) {
    $Version
  } else {
    "v$Version"
  }

  # 当前版本放在 docs/releases/，历史版本放在 history/。
  $latestPath = Join-Path $Root "docs\releases\$tag.md"
  $historyPath = Join-Path $Root "docs\releases\history\$tag.md"
  $path = if (Test-Path -LiteralPath $latestPath) {
    $latestPath
  } elseif (Test-Path -LiteralPath $historyPath) {
    $historyPath
  } else {
    throw "Release note is missing: $latestPath"
  }

  # 读取文件后只切一次，把 H1 与后面正文分开。
  $content = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
  $split = $content -split "`r?`n", 2
  $heading = if ($split.Count -gt 0) { $split[0] } else { '' }
  if ($heading -ne "# $tag") {
    throw "Release note must start with '# $tag'."
  }

  # 去掉 H1 之后的连续空行，保留正文本身。
  $body = if ($split.Count -gt 1) { $split[1] } else { '' }
  $body = [regex]::Replace($body, '^\r?\n+', '')
  if ([string]::IsNullOrWhiteSpace($body)) {
    throw "Release body is empty for $tag."
  }
  return $body
}

# -Check 模式：只输出校验结果，不访问远端。
if ($Check) {
  Assert-ReleaseNoteLayout -Root $root
  Write-Output "Release-note layout: OK (current $((Read-ManifestVersion -Root $root)))"
}

# -Body 模式：生成正文后写入文件或输出到 stdout。
if ($Body) {
  $version = if ([string]::IsNullOrWhiteSpace($Version)) {
    Read-ManifestVersion -Root $root
  } else {
    $Version
  }
  $releaseBody = Get-ReleaseBody -Root $root -Version $version

  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    [System.IO.File]::WriteAllText($OutputPath, $releaseBody, [System.Text.UTF8Encoding]::new($false))
  } else {
    Write-Output $releaseBody
  }
}
