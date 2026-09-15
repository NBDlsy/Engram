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


## [1.5.1] - 2026-04-22
修复css bug


## [1.5.0] - 2026-04-22
更新各项依赖到新版,包括vite 8,react 19,tailwind 4,zustand 5等
