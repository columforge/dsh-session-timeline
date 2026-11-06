# GitHub Release 文案规则

适用范围：本仓库（`@columforge/session-timeline`）的所有 GitHub Release（tag `vX.Y.Z`）。目标：读者只看标题和首屏，就能判断"这版值不值得升、升了会变什么"。

## 1. 标题

格式：`vX.Y.Z — <一句要点>`

- 版本号与 git tag 完全一致（含 `v` 前缀）；
- 要点 = 本版最重要的 1–2 个变化；多个要点用「 + 」连接（如 `包名迁移 @columforge + npm 发布`）；
- 一句读完，中文 ≤ 30 字；不写"更新""优化""修复若干问题"这类无信息词；
- 不以"推荐升级""强烈建议"等营销语气收尾；升级条件写进正文；
- 参照既有风格：
  - `v0.0.27 — 首个公开版本`
  - `v0.0.28 — 归档会话显示 + 语言跟随 DSH`
  - `v0.0.33 — 原生 fork 血缘恢复`
  - `v0.0.34 — 可作为 profile bundle 安装（git 分发）`
  - `v0.0.35 — 包名迁移 @columforge + npm 发布`

## 2. 正文结构

正文**不重复标题**（GitHub Release 详情页已展示 title），直接从第一个 `###` 小节开始。按实际内容取舍小节，空节直接删除，不留占位：

```markdown
### 新增
- 面向用户的新能力；每条一句话，写清触发条件与实际影响。

### 变更
- 行为/接口/配置/依赖的变化；兼容性影响写在同一句（旧版本如何、是否需要迁移）。

### 修复
- 修了什么、什么条件下触发、修复前后差异；引用上游时给具体 commit/issue 标识。

### 验证
- 测试数量与结果（如 `node --test` 59/59）；
- 关键实测结论（线上对账数字、GUI 实测等）；
- 只写真实跑过、可复现的结论。

### 安装
- 按渠道优先级列；命令放代码块；
- 渠道状态必须准确：未上架的渠道写"自 vX.Y.Z 起提供"，不得写成已发布。

**Artifact** `<本版资产文件名>`  
sha256 `<值>`
```

规则：

- 正文不重复标题：详情页标题栏已显示 title，正文不再写 `## vX.Y.Z — ...` 一类首行；
- 每条 bullet 以一句话为主，需要时补"触发条件 → 实际影响"；
- 安装命令统一写法：`dsh plugin --profile web add <spec>`；git 源写 `git+https://…#<commit>`；市场索引用完整 URL；
- DSH/插件兼容性变化时，正文补一行指向 README 的「DSH 版本支持」矩阵；
- Release 不写成逐 commit 的 changelog；细节留给 git 历史；
- 不写内部工单号、绝对路径、个人备注。

## 3. 事实准确性（硬性）

- 文案中的每个数字、API 名、命令都必须与代码或实测一致；不确定就不写；
- `sha256` 必须对**本版 Release 资产实际下载后计算**（`sha256sum`），禁止凭记忆或复制上一版；
- Artifact 文件名必须与 Release 附件实际一致（资产名随包名/版本变化，如 `columforge-session-timeline-0.0.35.tgz`）；
- 旧版本补写文案时同样遵守本节；不改动已发布版本的既有事实性内容。

## 4. 发布检查清单

1. `package.json` 版本 bump → 重建 `lib/`（git 分发要求提交构建产物）→ 提交；
2. `git tag vX.Y.Z` → `git push origin master` + `git push origin vX.Y.Z`；
3. `npm pack` 生成 tgz → 创建 GitHub Release，标题与正文按本文档；
4. **核验附件**：`gh release view <tag> --json assets`，文件名与版本不符时用 API 删除旧附件；
5. 下载本版资产 → `sha256sum` → 回填正文；
6. 维护 npm 与市场索引时：更新 `market-index.json` 与 README 的渠道描述，确保正文"安装"节与实际一致。

## 5. 已知工具坑（本仓库实测）

- 本机 `gh` 版本没有 `gh release edit` 子命令，且 `PATCH /releases/tags/<tag>` 返回 404；改标题/正文用
  `gh api -X PATCH repos/<owner>/<repo>/releases/<id> --input <json>`（先 `GET /releases/tags/<tag>` 取 `id`）。
- 发布工具上传附件时可能选中目录中排序靠前的旧 tgz：发布后必须执行检查清单第 4 步；旧附件用
  `DELETE /repos/<owner>/<repo>/releases/assets/<id>` 删除。
- 附件名带版本号时，安装说明中的文件名必须写实际资产名，不要沿用上一版模板。

## 6. 英文发布

如需英文版：沿用同一结构，标题同样 `vX.Y.Z — <point>`；小节名用 `### Added / ### Changed / ### Fixed / ### Verification / ### Installation`；事实与验证要求与中文版完全一致。
