# AGENTS.md

本文件适用于 `dsh-plugin_session-manager-custom` 公开仓库。
公开用户说明以 `README.md` 为准，详细行为和兼容性说明见 `docs/project.md`。

## 仓库角色

- 公开仓库是公开代码、用户文档、Release、标签和版本说明的唯一事实源。
- 公开仓库不保存内部开发源镜像、本地私有归档或开发环境元数据。
- `README.md` 面向使用者；`.github/CONTRIBUTING.md` 面向贡献者；本文件面向仓库维护和 Agent 操作。

## 内容边界

公开仓库允许提交以下内容：

- `lib/` 下的插件入口
- `tests/` 下的测试
- `scripts/install.ps1`、`scripts/uninstall.ps1`、`scripts/release-notes.ps1`
- `docs/` 下的项目说明、版本信息和发布说明
- `.github/` 下的社区规范与工作流
- `package.json`、`cordis.patch.yml`、`LICENSE`、公开的 `.gitattributes` 和 `.gitignore`

不得提交以下内容：

- 本地路径、用户目录、token、API key、真实配置
- DSH 会话数据、个人 profile、备份区、回收站内容
- `TempData/`、`node_modules/`、`build/`、`dist/`
- `*.log`、`*.tgz`、临时导出文件
- 本地私有归档目录 `_Private_Archive/`
- 内部开发源根目录或与公开仓库重复的旧结构

如果本机存在 `_Private_Archive/`，它只能是本地私有归档，不得使用 `git add -f`、提交或推送。

## 版本与发布

- `package.json` 的版本与 `docs/VERSION` 必须一致。
- 当前版本说明固定为 `docs/releases/v<version>.md`。
- 历史版本说明放在 `docs/releases/history/`。
- `docs/releases/README.md` 是目录规范，不作为 Release 正文。
- Release 正文使用 `scripts/release-notes.ps1 -Body` 提取。
- 发布前必须执行 `.\scripts\release-notes.ps1 -Check`。
- `main`、版本、Tag 和 Release 由主发布者统一维护。

## 开发检查

```powershell
node --check lib/index.js
node --check lib/client.js
node --test tests/host.test.js
.\scripts\release-notes.ps1 -Check
npm pack --dry-run
```

PowerShell 脚本需要兼容 Windows PowerShell 5.1 与 PowerShell 7：

- `scripts/install.ps1`
- `scripts/uninstall.ps1`
- `scripts/release-notes.ps1`

上述脚本应保持 UTF-8 BOM，避免 Windows PowerShell 5.1 解析中文时出错。

## 修改边界

- 未获明确授权，不修改 `main`、Tag、Release 或发布历史。
- 未获明确授权，不 amend、不强推、不推送公开仓库。
- 不提交本地私有归档、内部开发源目录、会话数据或本机路径。
- 提交前运行公开仓库开发检查。
- 贡献者流程以 `.github/CONTRIBUTING.md` 为准。

## 兼容性

- 当前公开支持范围：Windows。
- DSH 开发基线：`0.1.0-rc.7`。
- 插件状态：developer preview，内部接口可能变化。
