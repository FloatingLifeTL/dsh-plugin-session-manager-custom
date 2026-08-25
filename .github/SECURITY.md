# Security Policy

## Reporting a Vulnerability

请通过 GitHub Issue 或私有安全报告提交问题，不要将 token、会话数据或真实 DSH profile 信息写入公开 Issue。

## Supported Scope

当前发布范围只验证 Windows 上的 DSH Web profile。

本插件会访问本机 DSH 会话、工作区、归档状态和持久化文件。以下是需要重点审查的边界：

- Agent/Session 生命周期结束
- 备份区和回收站文件移动
- 恢复、移入回收站和彻底删除
- 对真实 DSH profile 的副作用
- 任何网络上传行为

## Minimal Reproduction

报告时请提供：

- DSH 版本
- Web profile 类型
- 操作步骤
- 预期行为
- 实际行为
- 是否影响真实会话、备份区或回收站

## Privacy

- 公开仓库不包含 token、API key、会话数据、备份、回收站内容或个人邮箱。
- 本地运维资料、真实配置和用户数据不属于公开仓库内容。
