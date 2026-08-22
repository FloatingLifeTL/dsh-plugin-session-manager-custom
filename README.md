# DSH 会话数据管理器

DeepSeek Harness Web 插件，用于查看、预览和管理本机会话数据。

- 当前版本：`0.5.1`
- DSH 开发基线：`0.1.0-rc.7`；当前上游 `master` 尚待真实 Web 集成复核
- 平台范围：Windows
- 状态：developer preview，接口可能变化

## 名称与仓库映射

| 名称 | 值 |
|---|---|
| 插件显示名 | DSH 会话数据管理器 |
| 插件 ID | `session-manager-custom` |
| npm/package 名 | `@dsh-local/session-manager-custom` |
| GitHub 仓库名 | `dsh-plugin-session-manager-custom` |
| GitHub 安装命令 | `dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin-session-manager-custom#v0.5.1` |

## 功能概要

- 在设置按钮右侧显示 `会话管理器` 悬浮入口。
- 查看全部、未归档、归档、异常、子代理、备份区和回收站会话。
- 子代理会话不会因未挂到主工作区而被误判为未分组异常。
- 支持归档、恢复、移动工作区、修复未分组、清理无效索引和批量操作。
- 移入备份区或回收站时会同步移除工作区引用、归档标记和投影缓存；恢复时重新关联工作区并立即重建缓存。
- 支持备份区、回收站只读预览。
- 支持搜索、复选框、右侧只读预览和宽度调整。
- 所有会话数据保留在本机 DSH profile 中。

详细的视图分类、数据状态、生命周期和安全边界见 [项目说明](./docs/project.md)，更新说明见 [CHANGELOG.md](./CHANGELOG.md)。

## 安装

```powershell
dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin-session-manager-custom#v0.5.1
```

安装要求：

- DeepSeek Harness DSH
- `dsh --profile web`
- `pnpm`
- Windows PowerShell 5.1，或 Windows 上的 PowerShell 7.x（已验证 `pwsh 7.6.5`）

安装完成后需要重启 DSH 并刷新 Web 页面。

升级说明：命令中的 `#v0.5.1` 指向本次发布版本的 tag。后续发布新版本后，把 tag 改成新版对应值再执行一次，即可更新到对应版本；若希望始终以本地源码为准，可改用 [本地安装或更新](#本地安装或更新)。

## 本地安装或更新

将仓库克隆或下载到本地后，在 PowerShell 中切换到仓库根目录，然后运行：

```powershell
.\scripts\install.ps1
```

脚本会根据自身所在位置识别插件包，将其打包到 DSH profile 内的 `.dsh-local-install`，再从 tarball 使用官方 bundle 安装；它也会保留回收站和备份区数据，并自动处理旧的手动注册迁移。交互运行时默认会等待按 Enter；自动化或管道执行请添加 `-NoPause`。

## 使用

1. 打开 `http://127.0.0.1:3080`。
2. 在页面设置按钮附近找到 `会话管理器`。
3. 打开管理弹窗，按 `ESC` 可关闭。
4. 使用顶部 Tab 切换分类视图。
5. 点击行查看右侧只读预览，或使用复选框执行批量操作。

## 项目结构

```text
dsh-plugin-session-manager-custom/
├─ .github/
│  └─ workflows/tests.yml
├─ package.json
├─ cordis.patch.yml
├─ index.js
├─ client.js
├─ tests/
│  └─ host.test.js
├─ scripts/
│  └─ install.ps1
├─ docs/
│  └─ project.md
├─ README.md
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ THIRD_PARTY_NOTICES.md
├─ CODEOWNERS
├─ LICENSE
├─ VERSION
├─ .gitattributes
└─ .gitignore
```

## 开发

```powershell
node --check index.js
node --check client.js
node --test tests/host.test.js
npm pack --dry-run
```

## 贡献与权限

本仓库由主发布者 `FloatyTFL`（GitHub `FloatingLifeTL`）拥有并维护。主发布者保留最终的修改、审核、合并、回滚和发布决定权。

协作者只能通过 Issue、Fork 和 Pull Request 提交变更，所有变更必须经过主发布者审核确认后才能合并或发布。当前只有主发布者拥有仓库写权限，不启用必须由另一名协作者批准才能合并的规则，避免单维护者仓库被权限规则锁死。

提交前请运行开发检查，并确保不提交本地路径、token、会话数据或私人运维信息。详细规则见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
