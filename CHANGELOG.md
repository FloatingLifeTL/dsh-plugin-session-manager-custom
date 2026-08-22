# 更新说明

## 0.5.1 - 2026-08-23-Sun

## 概要

`session-manager-custom` 0.5.1 修复会话移入保留区、恢复和移动工作区时的状态同步问题，并保持现有安装与运行方式不变。

## 修复

- 修复会话移入备份区或回收站后，工作区关联、归档标记和投影缓存可能残留的问题。
- 修复会话从备份区或回收站恢复后，工作区关联和投影缓存没有立即重建的问题。
- 修复普通会话恢复正常后，工作区关联与归档状态可能不同步的问题。
- 修复会话在同一会话管理器中移动工作区时，旧工作区引用可能未清理的问题。
- 修复恢复过程出现工作区或派生索引同步失败时，仍可能返回成功的问题；现在会尝试将文件送回保留区并保留清单。

## 改进

- 会话管理器主标题与侧边栏入口统一为“会话管理器”，当前版本由 Host 的 `package.json` 实时读取并在标题中弱化显示。
- 清理与恢复操作现在统一维护 `workspace.json` 和 `session_projcache.json`。
- 恢复后优先通过 DSH 冷读机制写回投影缓存，缓存服务不可用时保留下次冷读重建路径。
- 索引同步失败时返回明确的失败结果，不再把部分同步当成成功。

## 安装

```powershell
dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin-session-manager-custom#v0.5.1
```

本地安装或更新：

```powershell
.\scripts\install.ps1
```

## 兼容性

- 插件版本仍为 `0.5.x`，无安装方式、客户端入口或 DSH 兼容性边界变化。
- 发布 Tag：`v0.5.1`。

## 0.5.0 - 2026-08-22-Sat

## 概要

`session-manager-custom` 0.5.0 首次公开发布，提供 DSH Web 会话数据管理能力。

## 主要功能

- 查看全部、未归档、归档、异常和子代理会话。
- 管理备份保留区与回收站，并支持只读预览。
- 支持归档、恢复、工作区移动、未分组修复和批量操作。
- 使用标准 DSH bundle 注册和本地 tarball 安装流程。
- 当前发布范围为 Windows。

## 安装

```powershell
dsh plugin --profile web add github:FloatingLifeTL/dsh-plugin-session-manager-custom#v0.5.0
```

本地安装或更新：

```powershell
.\scripts\install.ps1
```

## 兼容与验证

- DSH 开发基线：`0.1.0-rc.7`。
- 当前上游 `master` 尚待真实 Web 集成复核。
- Host 测试：13/13 通过。
- Windows PowerShell 5.1 与 PowerShell 7 安装脚本解析通过。
- `npm pack --dry-run` 通过。
