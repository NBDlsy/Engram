# 更新日志 (CHANGELOG)
## [1.5.2] - 2026-09-15
- 修复精简(TrimmerWorkflow)在 `ApplyTrim` 崩溃: `Cannot read properties of undefined (reading 'location')`
  - 新增 `trimNormalizer`，对 LLM 精简结果做 schema 归一化，兼容 `meta` 缺失 / 平铺字段 / 字符串元素 / `location` 为字符串等脏数据
  - 无法解析时回退为原始事件拼接，不再抛 TypeError
- 修复工作流日志模块误标: `WorkflowDefinition` 支持 `logModule`，精简/总结/实体/预处理工作流各自归属正确的日志分类（此前全部记为 RAG/Inject）
- 精简提示词补充 `meta` 包裹层硬约束与输出前校验清单，修正"一个一个"笔误
- 新增 `test/unit/trim-normalizer.test.ts` 覆盖上述脏数据场景
- 新增 `test/integration/trim-workflow.test.ts` 端到端验证：用线上崩溃的完全相同输入跑完整
  TrimmerWorkflow，确认不再抛异常，并校验 keepRecentCount 保留语义
- 修复 `EventTrimmer` 配置优先级: 实例改为只累积 override，修复初始化后持久化设置被缓存的完整
  配置永久遮蔽、改动读不到的问题。新增 `test/unit/trim-config-precedence.test.ts`
- 精简背景概览加上限 (8000 字符)，超限时保留最近部分，避免概览随事件积压线性增长再次撑爆 prompt
- 修复两处 `catch {` 未绑定变量却在块内引用 `e` 的运行时 bug (`SaveEvent` / `UserReview`)。
  后者会导致 `UserCancelled` 抛成 ReferenceError，使用户取消被误判为流程异常
- 新增 `.prettierrc`。此前项目无 prettier 配置，而工作区为 CRLF、prettier 默认按 LF 处理，
  导致 `pnpm run lint` 对全部 249 个文件报错、完全失效。配置后降至 220 个；
  剩余差异为仓库历史风格所致，需一次性全量格式化才能消除（未执行，避免大范围 diff）
- 精简状态新增「已精简条目」(level>=1 数量)。这类事件不会被再次合并、不计入触发阈值，
  却始终占用注入上下文，长期只增不减；先暴露为可观测，便于判断是否需要二级压缩
- 精简改为分批合并: 新增 `TrimConfig.maxEventsPerTrim`（默认 10），积压超限时只合并最老的一批，
  避免一次性把几十条事件塞进 prompt 导致输出过长（崩溃的真正诱因）。设置面板新增对应滑块
- 归一化兜底时会记录 LLM 原始输出的截断快照，便于定位模型跑偏形态
- 精简背景概览去重: `FormatTrimInput` 显式构造 `{{engramSummaries}}`，剔除本次待合并条目，
  修复同一批事件在 prompt 中出现两次（概览区 + 待合并区）导致的长度翻倍
- 合并事件不再一律命名为「精简合并」: `ApplyTrim` 此前把 `structured_kv.event` / `causality`
  写死为 `'精简合并'` / `'Chain'`，导致所有合并条目在记忆流里无法分辨。现改为采用 LLM 给的主题与因果
  （经 `trimNormalizer` 归一化），仅在缺失时回退旧值
- Agentic 索引 `getAgenticIndex()` 的 record 新增 `time_anchor` 属性，让召回裁判能按时间远近判断相关性
  （此前 record 只有 id / event / role / location / causality，模型无从判断"久远"还是"近期"）
- 内置提示词同步: 精简提示词统一 summary 字数要求（原 400-500 与 200-300 自相矛盾），
  并禁止把历法时间改写为"第X天"等相对时间；摘要提示词补上 `time_anchor` 字段与相对时间换算规则；
  召回提示词说明 record 属性构成，新增时间维度决策法则
- 新增 `test/integration/agentic-index.test.ts`，并补充 event / causality 透传相关用例
- 精简结果宽容提取: 模型忘了套 `{"events": [...]}` 外壳（直接吐单个事件对象）或顶层就是数组时，
  `ApplyTrim` 不再抛"无有效的精简结果"，改为按单事件处理；`ParseJson` 遇到 `{"events": {...}}`
  也从"清空为 []"改为"包成数组保留"。真正无可用内容时仍抛错，但会带上原始输出快照便于定位
- 修复「一搜索事件整个视图就崩」: `filterEvents` 里 `kv.event?.toLowerCase()` 假设字段是字符串，
  而库里存在被写成数字/数组的 `structured_kv.event`（`TypeError: n.event?.toLowerCase is not a function`）。
  该分支仅在有搜索词时才执行，所以表现为"不搜索没事、一搜索就崩"。新增 `toText` 统一容错，
  `filterEntities` 同样处理
- 修复 Agentic 索引构建失败 (`e.replaceAll is not a function`): `escapeXml` 与列表字段未做类型容错，
  非字符串（数字/对象）或"写成字符串的数组字段"（`"王城".join` 不存在）都会抛错，导致整个索引为空
- 渲染异常不再"哑巴失败": `ErrorBoundary` 现在把错误同步写入 Engram 开发者日志
  （含事件 id、错误消息、截断的组件栈），占位卡片也直接显示错误原因。
  此前只 `console.error`，日志面板查不到，用户只能看到一句"组件加载失败"无从下手
- `EventCard` 对缺失 `significance_score` 的事件兜底（此前 `toFixed` 会让整张卡片渲染失败）
- 修复大幕动画导致的「界面变透明、完全无法操作」死锁:
  `CurtainOverlay` 把 onCovered / onReveal / onComplete 直接放进 effect 依赖，父组件每次 setState
  都会换掉回调身份 → effect 重跑 → `ctx.revert()` 掐断正在播放的 GSAP 时间线 → onComplete 永不触发。
  结果停在「内容已卸载 + pointer-events:none」的状态，界面只剩透明外壳且点不动。
  改为用 ref 持有回调（依赖收敛为 mode/direction/hostColor），并在 MainLayout 加生命周期看门狗：
  开幕/闭幕超过 2.5s 未结束则强制推进到终态；关闭请求增加日志记录
- 修复「记忆编辑中搜索事件时整个界面变透明、完全无法操作」:
  列表使用 `GroupedVirtuoso` 虚拟化，搜索过滤后组件可能带着**旧的分组索引**回调
  `groupContent` / `itemContent`，原先未判空 → `group` 为 undefined 直接抛错 →
  整棵 React 树卸载（界面只剩透明外壳，点什么都没反应）。已对两处索引取用加判空
- 稳定性: `EventCard` 对缺失 `structured_kv` / `summary` 的脏数据兜底（此前同样会渲染失败）；
  `App` 层补 `ErrorBoundary`，任何视图的渲染异常只显示错误提示，不再让界面整体消失
- `ParseJson` 解析失败时输出原始快照（详见下条）
- Agentic 召回自愈: `BuildPrompt` 检测到召回模板未使用 `{{engramIndex}}` 时自动补挂索引并告警。
  此前用户把数据源换成纯摘要宏后，模型看不到事件 ID，召回会静默失效（日志仅一行"无有效事件"）
- 内置摘要提示词改用中性客观的用词准则（替换原"情境化用词"，后者会引导模型对亲密剧情做情感润色，
  与"忠实记录"冲突），并新增 `<context_injection>` 段统一注入角色卡/世界书/历史摘要/图谱，
  消除 userPromptTemplate 与系统提示词的重复宏注入


## [1.5.1] - 2026-04-22
修复css bug


## [1.5.0] - 2026-04-22
更新各项依赖到新版,包括vite 8,react 19,tailwind 4,zustand 5等
