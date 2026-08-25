# DSH 会话数据管理器

DeepSeek Harness Web 插件，用于查看、预览和管理本机会话数据。

- 当前版本：`0.5.2`
- 仓库最后更新：`2026-08-24 (UTC+08:00)`
- DSH 开发基线：`0.1.0-rc.7`；当前上游 `master` 尚待真实 Web 集成复核
- 平台范围：Windows
- 状态：developer preview，接口可能变化

## 名称与仓库映射

| 名称 | 值 |
|---|---|
| 插件显示名 | DSH 会话数据管理器 |
| 插件 ID | `session-manager-custom` |
| npm/package 名 | `@dsh-local/session-manager-custom` |
| GitHub 仓库名 | `dsh-plugin_session-manager-custom` |
| GitHub 安装命令 | `dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin_session-manager-custom#v0.5.2` |

## 功能概要

- 在设置按钮右侧显示 `会话管理器` 悬浮入口。
- 查看全部、未归档、归档、异常、子代理、备份区和回收站会话。
- 子代理会话不会因未挂到主工作区而被误判为未分组异常。
- 支持归档、恢复、移动工作区、修复未分组、清理无效索引和批量操作。
- 移入备份区或回收站时会同步移除工作区引用、归档标记和投影缓存；恢复时重新关联工作区并立即重建缓存。
- 支持备份区、回收站只读预览。
- 支持搜索、复选框、右侧只读预览和宽度调整。
- 所有会话数据保留在本机 DSH profile 中。

详细的视图分类、数据状态、生命周期和安全边界见 [项目说明](./docs/project.md)，更新说明见 [v0.5.2](./docs/releases/v0.5.2.md)。

## 安装

```powershell
dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin_session-manager-custom#v0.5.2
```

安装要求：

- DeepSeek Harness DSH
- `dsh --profile web`
- `pnpm`
- Windows PowerShell 5.1，或 Windows 上的 PowerShell 7.x（已验证 `pwsh 7.6.5`）

安装完成后需要重启 DSH 并刷新 Web 页面。

升级说明：命令中的 `#v0.5.2` 指向本次发布版本的 tag。后续发布新版本后，把 tag 改成新版对应值再执行一次，即可更新到对应版本；若希望始终以本地源码为准，可改用 [本地安装或更新](#本地安装或更新)。

## 本地安装或更新

将仓库克隆或下载到本地后，在 PowerShell 中切换到仓库根目录，然后运行：

```powershell
.\scripts\install.ps1
```

脚本会根据自身所在位置识别插件包，将其打包到 DSH profile 内的 `.dsh-local-install`，再从 tarball 使用官方 bundle 安装；它也会保留回收站和备份区数据，并自动处理旧的手动注册迁移。交互运行时默认会等待按 Enter；自动化或管道执行请添加 `-NoPause`。

## 卸载

卸载脚本是独立工具，不读取仓库的 `package.json`、`cordis.patch.yml`，也不依赖脚本所在目录。可以在仓库内运行，也可以把 `uninstall.ps1` 单独复制到任意本地目录后运行：

```powershell
.\scripts\uninstall.ps1
```

公开仓库可以以内存方式执行 `main` 分支的最新脚本，当前工作目录不会留下 `uninstall.ps1` 文件；命令默认卸载 `web` profile：

```powershell
iex ((irm 'https://raw.githubusercontent.com/FloatingLifeTL/dsh-plugin_session-manager-custom/main/scripts/uninstall.ps1').TrimStart([char]0xFEFF))
```

脚本使用内置的稳定包名 `@dsh-local/session-manager-custom`，先按官方规范执行 `dsh plugin --profile <profile> remove <package-name>`，再清理插件自身生成的备份区和回收站目录：

```text
$DSH_HOME\profiles\.session-manager-custom-backup
$DSH_HOME\profiles\.session-manager-custom-trash
```

在线脚本方式会直接执行下载内容，运行前请确认脚本来源可信。`TrimStart([char]0xFEFF)` 只移除下载到内存中的 UTF-8 BOM，不会改变仓库脚本文件。脚本会卸载插件，并可能删除插件运行时生成的备份区和回收站数据；它不会删除安装过程产生的 `.dsh-local-install` tarball 缓存或迁移备份目录。

GitHub 仓库处于 Private 状态时，匿名 Raw URL 不可用。需要远端运行时，先使用已登录的 GitHub CLI 下载到临时文件，再执行本地临时脚本：

```powershell
$tempScript = Join-Path ([IO.Path]::GetTempPath()) 'session-manager-custom-uninstall.ps1'
try {
  $content = gh api `
    -H 'Accept: application/vnd.github.raw+json' `
    'repos/FloatingLifeTL/dsh-plugin_session-manager-custom/contents/scripts/uninstall.ps1?ref=v0.5.2'
  if ($LASTEXITCODE -ne 0) { throw '从 GitHub 下载卸载脚本失败。' }

  $content | Set-Content -LiteralPath $tempScript -Encoding UTF8
  & $tempScript -ProfileName web
} finally {
  Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
```

不建议使用 `Invoke-RestMethod <url> | Invoke-Expression` 直接执行远端文本，因为这种方式不便审查下载内容，也不适合可靠传递脚本参数。

卸载脚本不会删除安装脚本生成的 `.dsh-local-install` tarball 缓存或迁移备份目录。备份区和回收站数据会在卸载时一并删除；执行前请确认其中没有需要保留的会话。若同一 `DSH_HOME` 下的其他 profile 仍注册本插件，脚本会保留共享数据目录并报告错误。无论成功或失败，脚本最终都会等待用户按 Enter 后才结束；使用 `-ProfileName` 可指定其他 profile。


## 使用

1. 打开 `http://127.0.0.1:3080`。
2. 在页面设置按钮附近找到 `会话管理器`。
3. 打开管理弹窗，按 `ESC` 可关闭。
4. 使用顶部 Tab 切换分类视图。
5. 点击行查看右侧只读预览，或使用复选框执行批量操作。

## 项目结构

```text
dsh-plugin_session-manager-custom/
├─ .github/
│  ├─ CODEOWNERS
│  ├─ CONTRIBUTING.md
│  ├─ SECURITY.md
│  └─ workflows/tests.yml
├─ package.json
├─ cordis.patch.yml
├─ lib/
│  ├─ index.js
│  └─ client.js
├─ tests/
│  └─ host.test.js
├─ scripts/
│  ├─ install.ps1
│  ├─ uninstall.ps1
│  └─ release-notes.ps1
├─ docs/
│  ├─ project.md
│  ├─ THIRD_PARTY_NOTICES.md
│  ├─ VERSION
│  └─ releases/
│     ├─ README.md
│     ├─ v0.5.2.md
│     └─ history/
│        ├─ v0.5.1.md
│        └─ v0.5.0.md
├─ README.md
├─ LICENSE
├─ .gitattributes
└─ .gitignore
```

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node --test tests/host.test.js
npm pack --dry-run
```

## 贡献

欢迎通过 Issue、Fork 和 Pull Request 贡献，提交前请阅读 [CONTRIBUTING.md](./.github/CONTRIBUTING.md)。

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
