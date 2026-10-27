# @dsh-external/session-timeline

会话时间线（右侧边栏页签）：鱼骨时间线——中央水平主轴（右端箭头），轴上
日期刻度（YY-MM-DD，日期变化处标注、文字放鱼刺对侧），会话按创建时间
从左到右交替分布在轴上下两侧，鱼刺竖线连到轴。

- **缩放**：时间线窗口左上角 `− N% +` 控件（按钮 ±10%，范围 10%~300%）；
  鼠标在窗口内滚动滚轮联动缩放（±5%，围绕光标锚点）。100% = 原始比例。
  画框高度固定，缩放只作用于内容（滚动范围随之伸缩）。
- **排序**：头部「按创建时间（默认）/ 按最后活动」下拉切换；节点时间与
  轴刻度跟随所选排序键。
- **方向**：头部「从老到新（默认）/ 从新到老」下拉切换时间线左右方向；
  从新到老时主轴朝向反转，箭头移到最左端。
- **布局**：列 = 所选排序键（等距；末事件 time，长命会话定位在
  其最近活动处，创建时间在详情区可见）。独立会话在鱼骨层（主轴上下
  奇偶交替，鱼刺接轴）；**handoff 链子会话用血缘深度行**——继承父侧、
  向轴外侧叠行（行距 = 节点高 + 24；血缘分派恒按创建序，与显示排序键解耦），
  分支子与父同侧同层扇出（走轴侧通道）。时间线区横向 + 纵向滚动。
  节点框内时间为 `YYYY-MM-DD HH:MM`。
- **节点** = 工作区（会话存储桶）的顶层会话（`session-` 前缀；subagent
  会话不入线）。
- **血缘弯折线**（实线；父近轴边 → 父侧通道 → 水平至子列 → 水平进入
  子节点左侧，箭头向右）：
  - 蓝 = handoff 衔接（父单子，链式）
  - 紫 = 分支（父多子，扇出；父节点带 `⑂N` 徽章）
- **手工衔接**（虚线橙）：把一个节点拖到另一个节点即建立（host 按创建
  时间自动定向；与原生血缘重复会被拒）。to 端与 handoff 链同款**下沉
  深度行**（继承 from 侧、向轴外侧叠行），连线走行缝水平进入目标左侧；
  同层连线走列缝。点击节点可查看详情并断开其手工衔接。
  手工衔接计入出入度：有手工出边的会话不再显示「待接后继」金框。
- **handoff 新会话标签**：会话首条真实用户消息内容含 handoff 文档引用
  （host 检索第一条内容，如"读 handoff 文档…"）→「handoff」标签。
- **handoff skill 强调**：会话首个/最后一个对话内调用过 handoff skill
  （`user/message` + `source{kind:skill-invocation,name:handoff}`），且对应
  方向无任何实线/虚线衔接边时，边框强调——首个对话 = 紫色（待接前驱），
  最后对话 = 金色（待接后继）；两者兼有 = 紫外框 + 金内圈。
- **工作区切换**：页签头部下拉按工作区分开显示（默认 = 当前会话工作区，
  列表按最近活动排序，显示 cwd 尾名与会话数）。
- **双击切换**：双击节点 = `uiWorkspace.openSession` 切换到该会话（跨工作区
  生效）；详情区也有「切换到该会话」按钮。
- **首/末轮对话**：选中节点后详情区显示「首轮对话（默认）/ 末轮对话」两页
  （真实用户消息分轮；助手文本 = 该轮**最后一次**回复，整轮无正式回复时
  回退 `[推理]` 前缀的推理；各截断 4000 字符）。**滚轮语义分区**：详情区
  框内滚轮 = 切换首轮 ⇄ 末轮；对话文本框内滚轮 = 滑动翻看内容。
  API：`GET /turns?session=<id>&workspace=<桶>`。
- **工作区隔离**：手工衔接落 `~/.dsh/session-timeline/<bucket>.json`；
  会话存储只读。

## 数据来源

- 会话元数据：`~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd`
  的 header 行（`createdAt` / `parentSession` / `isSeeded` / `cwd`）、最后一条
  事件 time（最后活动）、最后一条 `session/title` 事件、首条真实用户消息
  时间与内容（**会话创建时间 = 首条真实用户消息的 time**；尚无用户消息的
  会话回落 header `createdAt`，原值另以 `logCreatedAt` 随节点返回；
  handoff 新会话判据）、
  首末对话窗口内的 handoff skill 调用（zstd 多帧解码，mtime+size 缓存，
  容忍尾部撕裂帧；轮次窗口以真实用户消息 `source.kind=user` 分隔）。

## API（webserver 前缀路由 `/session-timeline/api`）

- `GET /workspaces` → `{ ok, workspaces: [{bucket, cwd, sessions, newest}] }`
- `GET /list?workspace=<桶|__global__>&session=<当前会话id>`（workspace 优先）→
  `{ ok, bucket, unreadable, sessions[](含 bucket/handoffSeed/lastAt), edges[], manualLinks[] }`
- `POST /link` `{ workspace?, session?, from, to }` → 按创建时间归一定向后落账（幂等）
- `POST /unlink` `{ workspace?, session?, from, to }` → 删除该手工衔接（双向匹配）

## 构建 / 注入

```bash
npm run build          # tsc host + tsdown client（借 dsh checkout 工具链）
# 注入（dsh-super-injector）：dev_inject_plugin dir=<本目录>；改码后 dev_reload_package session-timeline
```
- **弯折线 = 正交避障路由**（系统性算法，非模板）：节点框（外扩 2px）为障碍，画布取框缘 ±8px 生成正交通道网格，每条边跑 A* 最短路径（代价 = 长度 + 转折 x10 + 已占用通道拥挤 x30，跨边共享拥挤表错开平行走线），任意布局/连线组合自动适配、不穿任何会话框与鱼骨刺。
- **缩放**：时间线窗口左上角 `− N% +` 控件（按钮 ±10%，范围 10%~300%）；
  鼠标在窗口内滚动滚轮联动缩放（±5%，围绕光标锚点）。100% = 原始比例。
  画框高度固定，缩放只作用于内容（滚动范围随之伸缩）。
- **排序**：头部「按创建时间（默认）/ 按最后活动」下拉切换；节点时间与
  轴刻度跟随所选排序键。
- **方向**：头部「从老到新（默认）/ 从新到老」下拉切换时间线左右方向；
  从新到老时主轴朝向反转，箭头移到最左端。
- **布局**：列 = 所选排序键（等距；末事件 time，长命会话定位在
  其最近活动处，创建时间在详情区可见）。独立会话在鱼骨层（主轴上下
  奇偶交替，鱼刺接轴）；**handoff 链子会话用血缘深度行**——继承父侧、
  向轴外侧叠行（行距 = 节点高 + 24；血缘分派恒按创建序，与显示排序键解耦），
  分支子与父同侧同层扇出（走轴侧通道）。时间线区横向 + 纵向滚动。
  节点框内时间为 `YYYY-MM-DD HH:MM`。
- **节点** = 工作区（会话存储桶）的顶层会话（`session-` 前缀；subagent
  会话不入线）。
- **血缘弯折线**（实线；父近轴边 → 父侧通道 → 水平至子列 → 水平进入
  子节点左侧，箭头向右）：
  - 蓝 = handoff 衔接（父单子，链式）
  - 紫 = 分支（父多子，扇出；父节点带 `⑂N` 徽章）
- **手工衔接**（虚线橙）：把一个节点拖到另一个节点即建立（host 按创建
  时间自动定向；与原生血缘重复会被拒）。to 端与 handoff 链同款**下沉
  深度行**（继承 from 侧、向轴外侧叠行），连线走行缝水平进入目标左侧；
  同层连线走列缝。点击节点可查看详情并断开其手工衔接。
  手工衔接计入出入度：有手工出边的会话不再显示「待接后继」金框。
- **handoff 新会话标签**：会话首条真实用户消息内容含 handoff 文档引用
  （host 检索第一条内容，如"读 handoff 文档…"）→「handoff」标签。
- **handoff skill 强调**：会话首个/最后一个对话内调用过 handoff skill
  （`user/message` + `source{kind:skill-invocation,name:handoff}`），且对应
  方向无任何实线/虚线衔接边时，边框强调——首个对话 = 紫色（待接前驱），
  最后对话 = 金色（待接后继）；两者兼有 = 紫外框 + 金内圈。
- **工作区切换**：页签头部下拉按工作区分开显示（默认 = 当前会话工作区，
  列表按最近活动排序，显示 cwd 尾名与会话数）。
- **双击切换**：双击节点 = `uiWorkspace.openSession` 切换到该会话（跨工作区
  生效）；详情区也有「切换到该会话」按钮。
- **首/末轮对话**：选中节点后详情区显示「首轮对话（默认）/ 末轮对话」两页
  （真实用户消息分轮；助手文本 = 该轮**最后一次**回复，整轮无正式回复时
  回退 `[推理]` 前缀的推理；各截断 4000 字符）。**滚轮语义分区**：详情区
  框内滚轮 = 切换首轮 ⇄ 末轮；对话文本框内滚轮 = 滑动翻看内容。
  API：`GET /turns?session=<id>&workspace=<桶>`。
- **工作区隔离**：手工衔接落 `~/.dsh/session-timeline/<bucket>.json`；
  会话存储只读。

## 数据来源

- 会话元数据：`~/.dsh/sessions/<bucket>/<sessionId>/session.v4.jsonl.zstd`
  的 header 行（`createdAt` / `parentSession` / `isSeeded` / `cwd`）、最后一条
  事件 time（最后活动）、最后一条 `session/title` 事件、首条真实用户消息
  时间与内容（**会话创建时间 = 首条真实用户消息的 time**；尚无用户消息的
  会话回落 header `createdAt`，原值另以 `logCreatedAt` 随节点返回；
  handoff 新会话判据）、
  首末对话窗口内的 handoff skill 调用（zstd 多帧解码，mtime+size 缓存，
  容忍尾部撕裂帧；轮次窗口以真实用户消息 `source.kind=user` 分隔）。

## API（webserver 前缀路由 `/session-timeline/api`）

- `GET /workspaces` → `{ ok, workspaces: [{bucket, cwd, sessions, newest}] }`
- `GET /list?workspace=<桶|__global__>&session=<当前会话id>`（workspace 优先）→
  `{ ok, bucket, unreadable, sessions[](含 bucket/handoffSeed/lastAt), edges[], manualLinks[] }`
- `POST /link` `{ workspace?, session?, from, to }` → 按创建时间归一定向后落账（幂等）
- `POST /unlink` `{ workspace?, session?, from, to }` → 删除该手工衔接（双向匹配）

## 构建 / 注入

```bash
npm run build          # tsc host + tsdown client（借 dsh checkout 工具链）
# 注入（dsh-super-injector）：dev_inject_plugin dir=<本目录>；改码后 dev_reload_package session-timeline
```

