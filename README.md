# dsh-session-timeline

[English](README.en.md) | 中文

DSH（DeepSeek Harness）插件：在右侧边栏新增**「会话时间线」**页签，把一个工作区的全部会话画成一条鱼骨时间线——原生 handoff 血缘、手工拖拽衔接、分支扇出一图全览，双击即达任意历史会话。

## 功能一览

| 能力 | 说明 |
|---|---|
| 鱼骨时间线 | 中央水平主轴 + 日期刻度，会话节点在轴上下交替排布，鱼刺连轴 |
| 血缘可视化 | 蓝实线 = handoff 衔接（父单子），紫实线 = 分支（扇出，父带 `⑂N` 徽章），虚线橙 = 手工衔接 |
| 手工衔接 | 节点间拖拽即可补记「这个会话接着那个会话」，与原生血缘合并计算语义 |
| handoff 待接提示 | 紫框 = 调用过 handoff skill 且无前驱（待接前驱）；金框 = 出现过 handoff 调用且无后继（待接后继） |
| 详情区 + 轮次条 | 点击节点查看会话详情；一排轮次横条翻看完整对话，handoff 调用轮金色高亮 |
| 工作区切换 | 顶部下拉切换会话桶，「当前会话工作区」自动跟随；页签计数实时显示顶层会话数 |
| 一键跳转 | 双击节点（或详情区按钮）直接切换到该会话，跨工作区生效 |

## 安装

前置：已安装并运行 DSH（DeepSeek Harness）。

打开 DSH 的**插件页 → 添加插件**，按下列任一方式安装：

1. **npm 包名**（推荐，待发布）：填 `@dsh-external/session-timeline`（npm 发布后可用，见 [发布渠道](#发布渠道)）
2. **Release 压缩包**（立即可用）：从 [GitHub Releases](https://github.com/ColumKam/dsh-session-timeline/releases) 下载 `.tgz`，解压后填入**解压目录的本地路径**
3. **源码构建**（开发者）：

```bash
git clone https://github.com/ColumKam/dsh-session-timeline.git
cd dsh-session-timeline
npm run build        # 需 DSH_CHECKOUT 指向 DSH 源码 checkout（见下）
```

然后把本目录填入「添加插件」的本地路径。

## 使用指南

### 时间语义

- **时间线定位 / 轴刻度 / 节点框内时间 = 最后活动时间**（`lastAt`）
- **创建时间 = 首条真实用户消息的时间**（仅详情区显示）；两者不同时详情区会标注「日志创建」，用于识别"打开过但很久才开始对话"的空壳会话

### 画布交互

- **缩放**：左上角 `− N% +` 控件（±10%，10%~300%，围绕视口中心锚定；点击 N% 复位 100%）
- **滚轮**：浏览器原生滚动（上下/左右），面板不拦截；Ctrl+滚轮 = 浏览器整体缩放
- **平移**：画布空白处按住左键拖拽（grab → grabbing）；在节点上拖拽 = 建立手工衔接连线

### 排序与方向

- 头部下拉切换排序键：**按创建时间（默认）/ 按最后活动**
- 方向：**从新到老（默认）/ 从老到新**；从新到老时主轴箭头在左端

### 血缘链

- **节点** = 工作区的顶层会话（`session-` 前缀；subagent 会话不入线）
- **独立会话**在鱼骨层（主轴上下交替）；**handoff 链子会话**用血缘深度行向轴外侧叠行，分支子与父同侧扇出
- 连线走**正交避障路由**（A* + 拥挤代价错开平行走线），绝不出斜线、不穿会话框
- **血缘链 = 原生边 ∪ 手工边**：出入度、`⑂N` 徽章、分支判定、详情区叙述全部按合并链计算——父已有原生单子再补一条手工后继时，单子边也显形为紫色分支线
- 「handoff」标签 = 会话**实际调用过 handoff skill** 或以 handoff 种子开场（不按消息文字匹配）
- 手工条目自带「断开」按钮，删改即时生效

### 详情区

- 选中节点显示：标题、创建/最后活动时间、血缘叙述、衔接列表
- **轮次条**：每轮一根横条（首/末轮较大，handoff 调用轮金色），点击查看该轮完整对话（用户消息 + 助手回复，各截断 4000 字符）；详情外框滚轮 = 上一轮/下一轮
- 「切换到该会话」按钮一键跳转

## 数据与隐私

- **只读**扫描 `~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd`（header、标题、首条用户消息时间、末事件时间、handoff 调用明细；zstd 多帧解码 + mtime/size 缓存）
- **唯一写入**：手工衔接落 `~/.dsh/session-timeline/<bucket>.json`（按工作区隔离）
- 不上传任何数据，不改动会话存储

## API（webserver 前缀路由 `/session-timeline/api`）

| 端点 | 说明 |
|---|---|
| `GET /workspaces` | 工作区清单 `{ ok, workspaces: [{bucket, cwd, sessions, newest}] }` |
| `GET /list?workspace=<桶\|__global__>&session=<id>` | 节点 + 原生边 + 手工衔接清单 |
| `GET /turns?session=<id>&workspace=<桶>&turn=N` | 轮次明细（`&turn=N` 单轮按需取） |
| `POST /link` `{workspace?, session?, from, to}` | 建立手工衔接（按创建时间归一定向，幂等） |
| `POST /unlink` `{workspace?, session?, from, to}` | 删除手工衔接（双向匹配） |

## 开发

```bash
npm run build    # tsc host + tsdown client（借 DSH checkout 工具链）
npm test         # pretest 自动 build，再跑全部单测
```

- `src/index.ts`：host——会话桶扫描 + API 路由
- `src/parse.ts`：纯函数会话日志解析（无插件依赖）
- `src/geometry/layout.ts`：纯函数布局（版面常量与坐标计算）
- `src/geometry/lineage.ts`：纯函数血缘链合并语义
- `src/geometry/routing.ts`：纯函数正交避障路由
- `src/client/index.ts`：UI——组件、拖拽、详情、渲染
- `test/*.test.mjs`：单测（node:test，导入 `lib/` 构建产物）

构建依赖 DSH 源码 checkout 的 tsc/tsdown：`export DSH_CHECKOUT=<dsh 源码目录>`（build.sh 会自动探测 `~/dsh-harness` 等常见路径）。

改 A*/布局几何时先读 `src/geometry/*.ts` 顶部「三个历史坑」注释；验证 = `npm test` 全绿后再浏览器 DOM 采样（SVG path 的 V/H 是单坐标指令，按 x,y 成对解析会误报）。

## 发布渠道

- **GitHub Releases**：每个版本附 `npm pack` 产出的 tgz（含构建好的 `lib/`）
- **npm**（规划中）：所有 peer 依赖（`@deepseek-ai/dsh-host-webserver` 等）均在公共 npm，具备直接发布条件
- **插件市场索引**：`market-index.json` 提供市场格式 1 索引，npm 发布后在 DSH「发现」页添加本仓库 raw URL 即可浏览安装

## 许可证

[BSD-3-Clause](LICENSE)
