# Release Note Layout

本目录用于保存与 GitHub Release 对应的版本更新说明。

## 规则

- 当前版本说明固定为 `docs/releases/v<version>.md`。
- 历史版本说明放在 `docs/releases/history/v<version>.md`。
- 文件第一行使用 `# v<version>` 记录完整版本标识。
- 文件名只用于定位文件，不要求承载全部版本信息。
- 不使用 YAML front matter 作为版本元数据。
- GitHub Release 正文由脚本去掉第一行标题和后续空行后生成。
- `docs/releases/README.md` 只描述目录规范，不作为某个版本的 Release 正文。

## 校验与生成

```powershell
.\scripts\release-notes.ps1 -Check
.\scripts\release-notes.ps1 -Body -Version v0.5.2
```

该脚本只读取文件并输出正文，不修改文件，不创建或推送 Release。
