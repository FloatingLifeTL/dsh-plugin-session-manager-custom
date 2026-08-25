<#
.SYNOPSIS
 通过官方 DSH 插件管理器卸载 session-manager-custom，并清理插件运行时生成的数据目录。

.DESCRIPTION
 本脚本是可脱离 Git 仓库和已安装插件目录独立运行的卸载工具。稳定 package name、
 备份区目录名和回收站目录名由脚本自身声明，不读取插件仓库的 package.json、
 cordis.patch.yml、$PSScriptRoot 或其他仓库文件。

 脚本只读取目标 DSH profile 的 package.json，用于确认官方 package 和 bundle 注册
 是否已移除；这是 DSH 运行状态检查，不是对插件仓库配置的依赖。

 如果目标 package 仍注册在指定 DSH profile 中，本脚本先调用官方卸载规范：

   dsh plugin --profile <profile> remove <package-name>

 官方卸载成功并确认 profile 不再注册该 package 后，脚本再删除本插件运行时生成的
 共享数据目录：

   <DSH_HOME>\profiles\.session-manager-custom-backup
   <DSH_HOME>\profiles\.session-manager-custom-trash

 这两个目录保存插件管理的备份区、回收站清单和会话文件。卸载脚本会删除它们，
 因此执行前应确认其中没有需要保留的数据。它们位于 profiles 根目录下，可能被同一
 DSH_HOME 下的多个 profile 共享；如果发现其他 profile 仍注册本插件，脚本会拒绝
 清理这些共享目录，以保护其他 profile 的数据。

 本脚本不会删除 scripts/install.ps1 生成的本地 tarball 缓存或迁移备份目录：

   <DSH_HOME>\profiles\<profile>\.dsh-local-install
   <DSH_HOME>\profiles\<profile>\.dsh-local-install-backup

 这两类目录属于安装过程产物，不属于插件运行时数据；如需清理，应由维护者另行
 确认后处理。

 如果官方卸载失败，脚本不会继续删除插件运行时数据目录，以便用户保留现场并重试。
 无论卸载成功还是发生错误，脚本最终都会等待用户按 Enter 后才结束；本脚本没有
 -NoPause 参数，也不读取 DSH_NONINTERACTIVE 等跳过等待的环境变量。

.PARAMETER ProfileName
 要卸载插件的 DSH profile 名称，默认值为 web。

.NOTES
 支持平台：Windows。
 DSH 运行基线：0.1.0-rc.7 或兼容的后续版本。
 PowerShell 运行版本基线：
 - 最低版本：Windows PowerShell 5.1。
 - 兼容目标：PowerShell 7.x。

 执行顺序：
 1. 使用脚本内置的稳定 package name 和插件数据目录名。
 2. 检查目标 profile 是否注册该 package。
 3. 如已注册，调用官方 dsh plugin remove，并验证注册已移除。
 4. 确认没有其他 profile 使用本插件后，删除插件运行时数据目录。
 5. 在成功或失败路径都等待用户操作后结束。
#>
#Requires -Version 5.1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 稳定卸载标识由脚本自身持有，使复制或远端下载后的脚本不依赖仓库目录。
$PackageName = '@dsh-local/session-manager-custom'
# 两个运行时目录位于 DSH_HOME/profiles 根目录，对同一 DSH_HOME 下的 profile 共享。
$BackupDirectoryName = '.session-manager-custom-backup'
$TrashDirectoryName = '.session-manager-custom-trash'

<#
.SYNOPSIS
 解析 DSH_HOME。

.DESCRIPTION
 优先使用用户显式提供的 DSH_HOME；未提供时使用 DSH 默认的用户目录。
 该函数只计算路径，不创建或修改任何目录。
#>
function Get-DshHome {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
    return $env:DSH_HOME
  }

  return Join-Path $HOME '.dsh'
}

<#
.SYNOPSIS
 获取 JSON 对象的可选属性值。

.DESCRIPTION
 使用 PSObject.Properties 读取可选属性，避免在 Set-StrictMode 下直接访问
 不存在的嵌套属性导致卸载检查提前失败。
#>
function Get-JsonPropertyValue {
  param(
    [Parameter(Mandatory = $false)]
    [AllowNull()]
    [object]$Object,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($null -eq $Object) { return $null }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }

  return $property.Value
}

<#
.SYNOPSIS
 验证 profile 名称是单个 DSH profile 名称，而不是路径。

.DESCRIPTION
 本脚本只应操作 $DSH_HOME/profiles/<name> 下的目标 profile。
 拒绝路径分隔符和目录穿越片段，避免清理路径超出预期 profile 目录。
#>
function Assert-ProfileName {
  if ([string]::IsNullOrWhiteSpace($ProfileName)) {
    throw 'ProfileName 不能为空。'
  }

  if ($ProfileName -match '[\\/]') {
    throw "ProfileName 必须是单个 profile 名称，不能包含路径分隔符：$ProfileName"
  }

  if ($ProfileName -eq '.' -or $ProfileName -eq '..' -or $ProfileName -match '\.\.') {
    throw "ProfileName 不能包含目录穿越片段：$ProfileName"
  }
}

<#
.SYNOPSIS
 读取 profile 中目标 package 的注册状态。

.DESCRIPTION
 DSH 官方 CLI 会同时维护 profile package.json 的 dependencies 和
 dsh.profile.bundles。本函数检查这两个位置；任一位置存在目标 package，
 都视为仍然需要执行官方 remove。
#>
function Get-ProfileRegistration {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProfileDir,

    [Parameter(Mandatory = $true)]
    [string]$PackageName
  )

  $manifestPath = Join-Path $ProfileDir 'package.json'
  $result = [ordered]@{
    ManifestPath = $manifestPath
    Exists = $false
    Dependency = $false
    Bundle = $false
    Registered = $false
  }

  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    return [pscustomobject]$result
  }

  $result.Exists = $true
  try {
    $profile = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "无法读取或解析 profile 清单：$manifestPath"
  }

  $dependencies = Get-JsonPropertyValue -Object $profile -Name 'dependencies'
  if ($null -ne $dependencies) {
    foreach ($property in $dependencies.PSObject.Properties) {
      if ($property.Name -eq $PackageName) {
        $result.Dependency = $true
        break
      }
    }
  }

  $dsh = Get-JsonPropertyValue -Object $profile -Name 'dsh'
  $profileConfig = Get-JsonPropertyValue -Object $dsh -Name 'profile'
  $bundles = Get-JsonPropertyValue -Object $profileConfig -Name 'bundles'
  if ($null -ne $bundles) {
    foreach ($bundle in @($bundles)) {
      if ([string]$bundle -eq $PackageName) {
        $result.Bundle = $true
        break
      }
    }
  }

  $result.Registered = $result.Dependency -or $result.Bundle
  return [pscustomobject]$result
}

<#
.SYNOPSIS
 查找仍注册本插件的其他 DSH profile。

.DESCRIPTION
 插件备份区和回收站位于 profiles 根目录，而不是某个 profile 目录内，
 因而属于同一 DSH_HOME 下的共享数据。清理前必须确认其他 profile 不再注册
 本插件；无法读取其他 profile 的清单时按失败处理，不冒险删除共享数据。
#>
function Find-OtherProfileRegistrations {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilesRoot,

    [Parameter(Mandatory = $true)]
    [string]$PackageName,

    [Parameter(Mandatory = $true)]
    [string]$ExcludedProfileName
  )

  if (-not (Test-Path -LiteralPath $ProfilesRoot -PathType Container)) {
    return @()
  }

  $matches = New-Object System.Collections.Generic.List[string]
  $profileDirectories = @(Get-ChildItem -LiteralPath $ProfilesRoot -Directory -Force)
  foreach ($directory in $profileDirectories) {
    # 插件共享数据目录不是 DSH profile，不应当按 profile 清单读取。
    if ($directory.Name -eq $BackupDirectoryName -or
        $directory.Name -eq $TrashDirectoryName) {
      continue
    }

    if ($directory.Name -eq $ExcludedProfileName) { continue }

    $registration = Get-ProfileRegistration -ProfileDir $directory.FullName -PackageName $PackageName
    if ($registration.Registered) {
      [void]$matches.Add($directory.Name)
    }
  }

  return @($matches)
}

<#
.SYNOPSIS
 删除一个插件运行时生成的数据目录。

.DESCRIPTION
 该函数只接受本脚本明确构造的插件数据路径，并拒绝删除文件或重解析点目录。
 重解析点可能指向目录外部，因此卸载脚本不跟随或递归删除这类路径。
#>
function Remove-PluginDataDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host "未发现 $Label：$Path"
    return
  }

  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer) {
    throw "$Label 不是目录，拒绝删除：$Path"
  }

  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label 是重解析点，拒绝递归删除：$Path"
  }

  Write-Host "正在删除 $Label：$Path" -ForegroundColor Yellow
  Remove-Item -LiteralPath $Path -Recurse -Force

  if (Test-Path -LiteralPath $Path) {
    throw "$Label 清理后仍然存在：$Path"
  }
}

<#
.SYNOPSIS
 在所有退出路径等待用户操作。

.DESCRIPTION
 该函数没有跳过等待的开关或环境变量。它由顶层 finally 调用，因此官方卸载
 成功、profile 不存在、依赖不存在、命令失败和脚本异常都会到达这里。
#>
function Wait-ForUserToClose {
  Write-Host ''
  Write-Host '卸载脚本已结束。请检查上面的结果，然后按 Enter 关闭此窗口。' -ForegroundColor Cyan
  [void](Read-Host '按 Enter 继续')
}

$failure = $null

try {
  Assert-ProfileName

  $dshHomePath = Get-DshHome
  $profilesRoot = Join-Path $dshHomePath 'profiles'
  $profileDir = Join-Path $profilesRoot $ProfileName
  $backupRoot = Join-Path $profilesRoot $BackupDirectoryName
  $trashRoot = Join-Path $profilesRoot $TrashDirectoryName

  Write-Host "目标 DSH profile：$profileDir"
  Write-Host "目标 package：$PackageName"

  $before = Get-ProfileRegistration -ProfileDir $profileDir -PackageName $PackageName
  if ($before.Registered) {
    $dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -eq $dshCommand) {
      throw '找不到 dsh 命令；无法执行官方插件卸载。请先安装或配置 DeepSeek Harness。'
    }

    Write-Host '正在使用官方 dsh plugin 卸载插件...'
    & dsh plugin --profile $ProfileName remove $PackageName
    if ($LASTEXITCODE -ne 0) {
      throw "官方 dsh plugin 卸载失败，退出码：$LASTEXITCODE"
    }

    $after = Get-ProfileRegistration -ProfileDir $profileDir -PackageName $PackageName
    if ($after.Registered) {
      throw '官方卸载命令已返回成功，但 profile 中仍存在目标 package 注册，拒绝清理插件数据目录。'
    }

    Write-Host '官方 package 和 bundle 注册已移除。'
  } else {
    Write-Host '目标 package 未在 profile 中注册，跳过官方 remove。'
  }

  $hasPluginData = (Test-Path -LiteralPath $backupRoot) -or (Test-Path -LiteralPath $trashRoot)
  if ($hasPluginData) {
    $otherProfiles = @(Find-OtherProfileRegistrations -ProfilesRoot $profilesRoot -PackageName $PackageName -ExcludedProfileName $ProfileName)
    if ($otherProfiles.Count -gt 0) {
      $names = $otherProfiles -join ', '
      throw "以下其他 profile 仍注册本插件：$names。插件数据目录是共享的，本次拒绝清理。"
    }

    Write-Host '未发现其他 profile 注册本插件，开始清理插件运行时数据目录。'
  }

  Remove-PluginDataDirectory -Label '插件备份区目录' -Path $backupRoot
  Remove-PluginDataDirectory -Label '插件回收站目录' -Path $trashRoot

  Write-Host ''
  Write-Host "插件卸载完成：$PackageName" -ForegroundColor Green
  Write-Host '已清理插件备份区和回收站数据；安装过程产生的 tarball 缓存未处理。'
} catch {
  $failure = $_
  Write-Host "ERROR：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '卸载未完全成功；未继续执行后续的插件数据清理。' -ForegroundColor Yellow
} finally {
  Wait-ForUserToClose
}

if ($null -ne $failure) {
  throw $failure
}
