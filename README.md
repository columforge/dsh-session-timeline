# @dsh-external/session-timeline

会话时间线（右侧边栏页签）：鱼骨时间线——中央水平主轴（箭头指向排列方向），
轴上日期刻度（YYYY-MM-DD，日期变化处标注、文字放鱼刺对侧），会话按所选排序键
（默认创建时间）从左到右交替分布在轴上下两侧，鱼刺竖线连到轴。

- **时间语义**：时间线定位/轴刻度/节点框内时间 = **最后活动时间**（`lastAt`，
  日志末事件 time）；**创建时间**（= 首条真实用户消息时间，见「数据来源」）
  只在详情区显示。
- **缩放**：窗口左上角 `− N% +` 控件（按钮 ±10%，范围 10%~300%）；窗口内滚轮
  联动缩放（±5%，围绕光标锚点）。100% = 原始比例；画框高度固定。
- **排序**：头部「按创建时间（默认）/ 按最后活动」下拉切换；节点时间与轴刻度
  跟随所选排序键。
- **方向**：「从新到老（默认）/ 从老到新」下拉切换；从新到老时主轴箭头在左端。
- **布局**：列 = 所选排序键（等距）。独立会话在鱼骨层（主轴上下奇偶交替，
  鱼刺接轴）；**handoff 链子会话用血缘深度行**——继承父侧、向轴外侧叠行
  （行距 = 节点高 + 24），分支子与父同侧同层扇出（走轴侧通道）。side/depth
  分派恒按拓扑序（依赖已分派才处理），与显示排序键解耦。时间线区横纵滚动。
- **节点** = 工作区（会话存储桶）的顶层会话（`session-` 前缀；subagent 会话
  不入线）。
- **边 = 正交避障路由**（组件见「源码结构」）：节点框（外扩 2px）为障碍，
  框缘 ±8px 生成正交通道网格，每条边跑 A*（代价 = 长度 + 转折 x10 + 通道拥挤
  x30，跨边共享拥挤表错开平行走线），任意布局/连线组合自动适配；
  兜底优先外侧走廊 U 形，其次 L 形——**绝不出斜线、不穿会话框**。
  - 蓝实线 = handoff 衔接（父单子，链式）
  - 紫实线 = 分支（扇出；父节点带 `⑂N` 徽章）
  - 虚线橙 = 手工衔接（拖拽建立；host 按创建时间自动定向，与原生血缘重复
    会被拒）。to 端与 handoff 同款下沉深度行；点击节点可查看详情并断开。
- **血缘链 = 原生边 ∪ 手工边**：凡链上语义一律按合并链计算（纯函数
  `src/geometry/lineage.ts`）——出入度（金紫框判据）、`⑂N` 徽章（原生 +
  手工后继总数）、分支判定（**合并出度 ≥ 2 即分支**：父另有手工后继时，
  原生单子边也显形为紫色分支线）、详情区「血缘 / 衔接到」叙述（手工边标
  「（手工）」，全无前驱才报根会话）。host `edges[].kind` 保持原生口径
  （按原生子数分类，/link 判重用），显形类别由 UI 推导，API 契约不变。
  深度行跨链传递不变：手工链 A→B→C 与原生接手工（P→B→C）同侧连续下沉。
  统计行「衔接 X · 分支 Y」= 显形类别口径（与画布颜色一致）；「手工 Z」
  = 手工边数。
- **引出/接入边矩阵**（父子面向侧 + 外侧边优先）：引出主选 = 外侧边
  （up 顶 / down 底），次选面向侧缘；接入主选 = 面向侧缘（父在子左 => 子入
  左缘；父在子右 => 子入右缘），次选外侧边。防重合微扰沿边滑动（出口水平
  ±10px、接入竖直 ±6px），不得垂直推回框内。
- **「handoff」标签** = 会话**调用过 handoff skill**（`handoffUsed`）或以
  **handoff 种子开场**（`isSeeded`）。不按首条消息含 handoff 字样判定——
  讨论 handoff 的会话会被误标（2026-10-29 定夺移除该文字匹配判据）。
- **handoff skill 强调**：紫框 = 首个对话内调用过 handoff skill 且无前驱边
  （待接前驱）；金框 = **消息中出现过任意 handoff skill 调用**（不限末对话，
  中间轮也算）且无后继边（待接后继）。选中会话在详情区列出每次调用：
  轮次 / 时间 / 消息 seq。
- **工作区切换**：头部下拉首项「当前会话工作区」= 跟随当前会话所属桶，其余为
  各工作区（按最近活动排序，显示 cwd 尾名与**顶层会话数**）。
- **页签计数**：标题「会话时间线（N）」= 当前面板视图的顶层会话数——跟随工作区
  下拉即时切换（未选时 = 当前会话工作区），每 12s 轻轮询；`N` 与面板统计行
  `N 会话` 恒一致。口径 = 时间线节点数（`session-*` 顶层会话，subagent 子会话
  不计）；新建会话需先落盘产生 `session-*` 目录才会加一。
- **双击切换**：双击节点 = `uiWorkspace.openSession`（跨工作区生效）；详情区
  也有「切换到该会话」按钮。
- **轮次条**：详情区顶部一排横向横条，每轮一根（真实用户消息分轮；助手文本 =
  该轮最后一次回复，整轮无正式回复回退 `[推理]`；各截断 4000 字符）。
  **首/末轮横条较大**；**handoff 调用轮金色高亮**（选中轮 = 蓝色填充；末轮即
  handoff 轮时单条同时具备两语义，不再重复显示）。点击任意条查看该轮完整
  对话（首轮默认选中；详情外框滚轮 = 上一轮/下一轮，对话文本框内 = 翻看
  内容）。
  API：`GET /turns?session=<id>&workspace=<桶>` →
  `{ ok, turns, first, last, handoffTurns[{turn,user,assistant,at}] }`；
  `&turn=N` → `{ ok, turns, turn, data }` 单轮按需取。
- **工作区隔离**：手工衔接落 `~/.dsh/session-timeline/<bucket>.json`；
  会话存储只读。
- **已移除**：全貌缩放模式（勿回退）。

## 数据来源

- 会话元数据：`~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd`
  的 header 行（`createdAt` / `parentSession` / `isSeeded` / `cwd`）、最后一条
  事件 time（最后活动）、最后一条 `session/title` 事件、首条真实用户消息
  时间、handoff skill 调用明细（每次调用 = `user/message` +
  `source{kind:skill-invocation,name:handoff}`，记录 seq/time/所属轮次；
  zstd 多帧解码，mtime+size 缓存，容忍尾部撕裂帧；轮次以真实用户消息
  `source.kind=user` 分隔）。
- **会话创建时间 = 首条真实用户消息（`source.kind=user`）的 time**；尚无用户
  消息的会话回落 header `createdAt`。header 原值以 `logCreatedAt` 随节点
  返回，详情区在两者不同时显示「日志创建」——用于识别"打开过但很久之后才
  真正开始对话"的空壳会话。

## API（webserver 前缀路由 `/session-timeline/api`）

- `GET /workspaces` → `{ ok, workspaces: [{bucket, cwd, sessions, newest}] }`
- `GET /list?workspace=<桶|__global__>&session=<当前会话id>`（workspace 优先）→
  `{ ok, bucket, unreadable, sessions[](含 createdAt/logCreatedAt/lastAt/
  seeded/handoffFirst/handoffUsed/handoffHits[{seq,at,turn}]/bucket),
  edges[], manualLinks[] }`
- `POST /link` `{ workspace?, session?, from, to }` → 按创建时间归一定向后落账（幂等）
- `POST /unlink` `{ workspace?, session?, from, to }` → 删除该手工衔接（双向匹配）

## 源码结构

- `src/index.ts`：host —— 会话桶扫描 + `list` / `workspaces` / `turns` /
  `link` / `unlink` API。
- `src/parse.ts`：**纯函数**会话日志解析（`parseLog`：header/标题/首条用户
  消息/lastAt/handoff 调用明细，无插件依赖）。
- `src/geometry/layout.ts`：**纯函数**布局（`computeLayout` / `colX` / `nodeTop`
  + 版面常量，无 React/DOM 依赖）。
- `src/geometry/lineage.ts`：**纯函数**血缘链合并语义（`lineageDegrees` 合并
  出入度 / `displayKind` 连线显形类别，无 React/DOM 依赖）。
- `src/geometry/routing.ts`：**纯函数**正交路由（`segHitsObstacle` /
  `routeOrthogonal` / `routeEdgePath` 引出接入矩阵）。
- `src/client/index.ts`：UI —— 组件、拖拽、详情、渲染；几何逻辑只做薄封装。
- `test/*.test.mjs`：单测（node:test，导入 `lib/parse.js` / `lib/geometry/*.js`）。

## 构建 / 测试 / 注入

```bash
npm run build          # tsc host + tsdown client（借 dsh checkout 工具链）
npm test               # pretest 自动 build，再跑全部单测（parse + 几何 + 血缘链）
# 注入（dsh-super-injector）：dev_inject_plugin dir=<本目录>
# 改码后：npm run build -> dev_reload_package session-timeline -> 浏览器刷新
```

改 A*/布局几何时先读 `src/geometry/*.ts` 顶部「三个历史坑」注释，并先跑
`npm test` 再浏览器 DOM 采样验证（SVG path 的 V/H 是单坐标指令，按 x,y 成对
解析会误报）。
