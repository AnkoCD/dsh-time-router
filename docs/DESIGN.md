# 设计说明

本文档说明 `dsh-time-router` 的架构、关键设计取舍、轮次分类与回退状态机、事件日志格式，以及已知局限。所有描述都以仓库中的实现为准（`index.js`、`client.js`、`src/**`），不引用仓库外的规划文档。

## 目录

- [目标与约束](#目标与约束)
- [总体架构](#总体架构)
- [为什么是“虚拟 adapter + waterfall 拦截”](#为什么是虚拟-adapter--waterfall-拦截)
- [时间判定](#时间判定)
- [轮次分类与锁定](#轮次分类与锁定)
- [回退状态机](#回退状态机)
- [事件日志格式](#事件日志格式)
- [设计取舍与偏离直觉方案的决定](#设计取舍与偏离直觉方案的决定)
- [局限与已知取舍](#局限与已知取舍)
- [测试策略](#测试策略)

## 目标与约束

一句话目标：**在不改变 Harness 会话语义的前提下，让同一份“auto”模型按北京时间在两个真实路由之间自动切换。**

由此推出的硬约束：

1. **不打断一轮对话。** 一旦模型开始产出，本轮就不再换路由、不重发请求；代价是跨窗口的长轮次按实际时段计费。
2. **不做双重能力投影。** Harness 在派发前会按 adapter 公布的能力裁剪请求；如果插件在 adapter 内部二次改写，能力校验与投影可能重复执行或与真实路由不一致。
3. **不改动 Harness 交给插件的请求对象。** 会话循环里的请求/消息是共享、冻结的数据结构，原地修改会破坏其他消费者（日志、回放、并发请求）。
4. **不阻塞请求。** 网络（节假日同步）与配置错误都不能让路由决策变慢或抛错；失败要么降级、要么在请求开始前明确报错。
5. **零运行时依赖。** 插件不 import 任何 `@deepseek-ai/*` 包，靠鸭子类型对接已发布契约（`LlmAdapter` 方法、`llm/stream` waterfall、`commands`、`webServer`、`connection`、`configEditor`），因此 `link:`/本地目录安装无需 `node_modules`。

## 总体架构

```text
┌──────────────────────────── Client（Web）────────────────────────────┐
│  client.js：composer dock 的 chip + 内联面板                          │
│  每 15 s GET /api/time-router/status，动作 POST /api/time-router/state │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ HTTP（经 Harness connection 校验）
┌───────────────────────────────────▼───────────────────────────────────┐
│  Host 半（index.js）                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ src/config  │  │ src/holidays │  │ src/schedule │  │ src/status │  │
│  │ 合并/校验    │  │ 数据链+缓存   │  │ 纯函数判定    │  │ 环+用量+日志│  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         └────────────────┴─────────────────┴────────────────┘         │
│                                   │                                    │
│   ┌───────────────┐   ┌───────────▼────────────┐   ┌────────────────┐  │
│   │ src/adapter   │   │ src/router             │   │ src/api        │  │
│   │ 虚拟 provider │◀──│ llm/stream 拦截        │──▶│ /api/time-router│  │
│   │              │   │ 锁/熔断/回退/能力投影   │   │                │  │
│   └───────┬───────┘   └───────┬───────────────┘   └────────────────┘  │
│           │                   │                                       │
│           ▼                   ▼                                       │
│   Harness llm service   src/openai（direct）│ ctx.llm.stream（delegated）│
└───────────────────────────────────────────────────────────────────────┘
```

模块职责：

| 模块 | 职责 |
|---|---|
| `index.js` | 解析配置、构造各服务、注册虚拟 adapter、挂 `llm/stream` 监听、注册 `/time-router` 命令与面板 API、启动节假日后台同步 |
| `src/config.js` | 默认值合并、字段校验、direct/delegated 判定、告警收集 |
| `src/time.js` | 基于 `Intl` 的时区安全换算（`zonedParts`、`dateKeyOf`、`minuteOfDayOf`、`zonedInstant`），避免使用 `Date` 的本地 getter |
| `src/holidays.js` | 内置/在线/缓存/覆盖的数据链、`sync()`、日历告警 |
| `src/schedule.js` | `evaluate()`（当前时刻 → 路由 + 原因）与 `nextSwitchAt()`（分钟粒度扫描未来 8 天） |
| `src/router.js` | waterfall 拦截入口、`plan()` 轮次分类、能力交集、首 token 前重试/回退、归属重写、事件记录 |
| `src/openai.js` | direct 路由的 SSE 客户端：请求构造、密钥解析、流解析（reasoning/text/tool/usage/finish）、HTTP 错误分类 |
| `src/adapter.js` | 虚拟 provider 的 `LlmAdapter`：`listModels`/`resolveModel`/`prepareCall`，`stream` 仅作拦截缺失时的防御路径 |
| `src/locks.js` | 按轮锁（LRU + 24h TTL + 200 会话上限） |
| `src/breakers.js` | 认证/配额熔断，按 `provider + model` 记录 |
| `src/failure.js` | 失败分类（auth/quota/rate-limit/server/context/aborted/other）与回退文案 |
| `src/status.js` | 内存状态环、按天按路由的用量聚合、JSONL 事件日志与轮转 |
| `src/api.js` | 两个 HTTP 路由与快照组装（不含任何密钥） |

## 为什么是“虚拟 adapter + waterfall 拦截”

Harness 的模型调用路径是：会话构造 `GenerateOptions` → `llm/stream` waterfall → 选中 provider 的 adapter `prepareCall()` 做能力校验与投影 → adapter `stream()` 产出 chunk。两个可选切入点：

- **在 adapter 内部路由**：注册一个 adapter，在它的 `stream()` 里再调用别的 provider 的 `stream()`。
- **在 waterfall 上拦截**：请求到达 adapter 之前就改写 `provider`/`model` 交给真实路由，虚拟 adapter 只负责“让这个 provider 存在且可被选择”。

实现选择了后者，并在前者只保留一条防御路径（`src/adapter.js` 的 `stream()` 仍会调用 `router.route()`，仅当监听注册失败时才可能被走到，且会 warn）。

这样做解决四个具体问题：

**1. 一次投影，而不是两次。** waterfall 在 adapter 派发之前拿到请求，路由器决定真实目标后直接调用目标路由，因此**只有一个** adapter 看到这次请求并执行能力校验/投影。若在虚拟 adapter 内部转发，虚拟 adapter 会先按虚拟能力投影一次，目标 adapter 再投影一次；两套能力不同时（例如虚拟模型是交集、目标支持图片）就会出现“内容被提前裁剪”或“校验按错的模型执行”。

**2. 绝不修改冻结的请求。** `buildInnerOptions()` 永远返回新对象：`{...options}`，需要改写 `provider`/`model`/`messages` 时再生成新的字段；`retargetMessages()` 用 `map()` 生成新数组，未变化时原样返回同一个引用。会话循环里的请求对象、消息数组与其中的消息对象都不会被原地写入。

**3. 轮次身份在请求边界上最清楚。** 拦截点拿到的 `GenerateOptions` 带有 `sessionId`、`purpose`、`messages`（含每条消息的 `id`/`source`），足以判断“这是新一轮 / 工具循环续写 / 辅助请求 / 一次性请求”。adapter 内部拿到的上下文没有 `purpose` 语义，分类会更不可靠。

**4. 归属重定向只对委托路由做。** 会话历史里 assistant 消息的 `source` 记录的是生产它的 provider/model；当真实路由被改写后，Harness 只会在“历史与目标由同一个 adapter 实例拥有”时把 replay 状态（例如签名/加密的推理回放）转交给目标 adapter。因此 delegated 分支会把 `source.provider === 虚拟 provider` 的 assistant 消息重写为目标 `provider`/`model`，并**保留原 `replayState` 字段**；direct 分支不需要（插件自己解析请求，直接使用 `messages` 原文的文本与工具调用）。这是“重放溯源（replay provenance）重定向”，只动归属元数据，不动内容。

**虚拟 provider 的存在理由**：Harness 的模型选择器、默认模型配置、会话归属与能力校验都以 `provider + model` 为键。注册 `time-router` 让“按时间路由”表现为一个普通的模型选择，而不是一个需要每轮改配置的外部开关；同时它让默认模型只需要设置一次（`agent-default-model`），之后由插件决定真实去向。

**能力交集的实现**：`Router.virtualCapabilities()` 并行解析两条真实路由的模型信息（direct 用配置里的声明，delegated 用 `llm.resolveModelInfo()`），然后取交集：最小 `contextWindow`、最小 `defaultMaxTokens`、两条路由都支持的输入模态、推理档位并集（默认档优先 offPeak，其次 peak）。结果按 60 秒 TTL 缓存，并在 `llm/adapters-updated` / `llm/models-updated` 事件上失效。派发时再按目标真实路由裁剪（direct 按配置的 `reasoningEfforts`，delegated 按 `resolveModelInfo()` 的结果），避免把目标不认识的 `reasoningEffort` 传下去。

## 时间判定

`Scheduler.evaluate(atMs)` 是纯函数：给定时刻、解析后的配置、节假日日历，返回路由与原因。由此得到三个性质：

- **休眠/唤醒后仍然正确。** 不需要定时器维护“当前路由”，机器睡眠跨越边界后第一个请求直接按真实时刻判定。
- **可测试。** 测试直接构造时刻断言路由，不需要 mock 时钟轮转；`debug.fakeNow` 也是同一机制（`Scheduler.now()` 优先取配置的固定时刻）。
- **可解释。** 每次判定都带 `reason`（`peak-window`、`statutory-holiday`、`weekend`、`outside-peak-window`、`makeup-workday-outside-window`、`disabled`、`manual-*`），这个字符串会进入状态命令、面板和事件日志。

判定顺序（`evaluate()`）：

1. `manual.mode` 有效 → 强制对应路由（`manual-peak` / `manual-offPeak`）；**先于 enabled 判断**，因此“停用路由”不会压过“强制高峰”。
2. `enabled === false` → offPeak，原因 `disabled`；`nextSwitchAt()` 返回 `null`（固定，不切换）。
3. 当天是工作日（`workday` 或 `makeup-workday`）且时刻落在某个窗口 `[start, end)` → peak。
4. 其余 → offPeak，原因按日历细分。

窗口是**半开区间**：`09:00` 属于高峰，`12:00` 不属于；`14:00` 属于，`18:00` 不属于。窗口在解析时按开始时间排序，重叠只告警（按并集处理），不允许跨午夜（要求拆成两个窗口），否则 `nextSwitchAt` 的分钟扫描会不成立。

`nextSwitchAt()` 从下一个整分钟开始逐分钟向后扫描最多 8 天，找到第一个会改变路由的时刻；若存在未到期的 `manual.until`，还会单独检查该时刻。窗口按分钟对齐，因此分钟扫描是精确的，而不是近似。面板的“下次切换”与命令输出的 `Next switch` 都来自这个函数。

节假日日历只回答 `dayKind(dateKey)`；优先级是 `overrides` > 在线 > 内置 > 仅按星期几。**路由决策从不触发网络**：在线同步在激活后异步执行、之后每 6 小时一次，结果写入缓存文件并升级内存日历；失败保留旧数据并产生面板告警。

默认 peak 窗口不是随意取的：OpenCode Go 对 DeepSeek 的加价窗口是周一至周五 `01:00–04:00` 与 `06:00–10:00` UTC，即 `09:00–12:00` / `14:00–18:00` Asia/Shanghai，与默认 `peakWindows` 完全重合（2026-11-09 实测）。因此默认配置下“高峰走 peak、非高峰走 offPeak”同时满足“高峰时段用订阅价覆盖加价时段”的意图；自定义窗口时请自行核对目标路由的计价时段。

## 轮次分类与锁定

路由器在 `plan(options)` 里把一次请求归入四类之一：

| 条件（按顺序判断） | `kind` | 使用哪条路由 | `reason` |
|---|---|---|---|
| `options.purpose` 非空 | `auxiliary` | 有锁用锁，否则用当前判定 | `inherit-<lock.reason>` 或当前判定的 reason |
| 无 `sessionId`、或无持久用户消息 id | `one-off` | 有锁用锁，否则用当前判定 | 同上 |
| 有锁且 `lock.userKey === 最后一条持久用户消息 id` | `continuation` | 锁的路由 | 锁创建时的 reason |
| 其他 | `new-turn` | 当前判定，并**新建锁** | 当前判定的 reason |

“持久用户消息”指数组里最后一条 `role === 'user'`、`id` 为非空字符串且 `source.kind === 'user'` 的消息（`lastDurableUserKey()`）。只带内容、没有 `id`/`source` 的注入型 user 消息（例如运行时追加的提示）不算轮次边界。

锁结构：

```js
{
  userKey,          // 轮次身份：最后一条持久用户消息 id
  routeKey,         // 'peak' | 'offPeak'
  lockedAt,         // 锁定时刻
  reason,           // 为什么选它（进入事件与回退文案）
  crossedIntoPeak,  // 本轮是否在 offPeak 路由上跨入了高峰窗口
  fallback,         // 本轮是否发生过回退
  fallbackReason,   // 回退通知文本
}
```

`crossedIntoPeak` 在每次 `plan()` 时更新：如果锁的路由是 offPeak 且当前时刻处于高峰窗口，就置为 `true`。它回答的是“这轮是不是从非高峰跨进了高峰”，正是计费上需要被标记的情况。

锁按 `sessionId` 存放，`TurnLocks` 是插入序 LRU：`get()` 命中后刷新位置；24 小时 TTL 过期删除；超过 200 个会话淘汰最久未用的。**锁不持久化**：插件重载/重启后清空，下一条请求按当时时间重新判定——这是 README 中声明的“唯一被接受的中途换路”。回退也会改写锁（`applyFallbackLock()`），使本轮后续请求继续走回退后的路由，而不是每轮再试一次坏掉的路线。

## 回退状态机

两个阶段：**计划期**（`plan()`，请求还没发）和**首 token 前**（`route()` 的尝试循环）。首 token 之后没有回退分支。

```text
plan()
 ├─ 目标路由的熔断已打开？ ──是──▶ 另一条也打开 ──▶ 按原计划尝试（会失败）
 │                                  └─否──▶ 直接改走另一条（plan-time fallback，记录 from*）
 └─ 否 ─▶ 目标路由

route()（每轮最多切一次路由）
 attempt:
   构造 inner options（投影/归属重写/effort 裁剪）
   open stream ──抛错──▶ classify
   等第一个 chunk ──抛错/end-of-stream/terminal error chunk──▶ classify
        │
        ▼
   recover(classified, {attempts, retriesLeft, attemptedRoutes})
        ├─ fallback.enabled=false ........ stop（返回错误 chunk）
        ├─ aborted / context ............. stop
        ├─ circuit(auth|quota) ........... 打开熔断
        ├─ retryable && retriesLeft>0 .... retry（同一路由，retriesLeft--）
        ├─ 另一条路由已尝试过 ............ stop
        ├─ 另一条路由熔断打开 ............ stop
        ├─ circuit 或 other/rate-limit/server ─▶ switch（一次；重置 retriesLeft）
        └─ 其他 ......................... stop
        │
   switch ─▶ 生成回退通知、改写本轮锁、换 target，重新 attempt
        │
   stop ──▶ yield 错误 chunk，记录 outcome=error

 第一个非终止 chunk 到达 ──▶ 本轮提交：原样透传后续 chunk
        └─ 之后抛错/错误 finish ──▶ 记录 outcome=error，不再回退
```

“终止 chunk”指 `type === 'finish' && reason.kind === 'error'`。判断发生**在第一个 chunk 被 yield 出去之前**，因此“重试/回退”与“已提交”的边界与用户实际看到的内容完全一致。

失败分类（`src/failure.js`）把 Harness 的 `LlmFailure` 代码/状态码归一为：

| kind | 触发 | 可重试 | 熔断 |
|---|---|---|---|
| `auth` | 401/403、`MISSING_CREDENTIAL`、`INVALID_API_KEY` 等 | 否 | `auth`（直到重置/改凭据） |
| `quota` | 402、`QUOTA*`、`INSUFFICIENT_*`、`BILLING` | 否 | `quota`（`Retry-After` 或冷却分钟） |
| `rate-limit` | 429、`RATE_LIMIT`、`OVERLOADED` 等 | 无 `Retry-After` 或 ≤ 5 s 时可重试 | 否 |
| `server` | 5xx、`TRANSPORT`、`NETWORK`、`TIMEOUT`、`EMPTY_RESPONSE` 等 | 是 | 否 |
| `context` | `CONTEXT_WINDOW_EXCEEDED` 等 | 否 | 否（也不回退） |
| `aborted` | 调用方 abort | 否 | 否 |
| `other` | 其他 | 否 | 否 |

熔断器按 `provider + model` 记录（direct 路由用 `label` 作为 provider 名）。配额熔断的 `until = now + (Retry-After 或 quotaCooldownMinutes)`；认证熔断在 `authCooldownMinutes > 0` 时有界，否则 `until = null` 表示“直到人工重置或更换凭据”。`reset()` 支持按 provider 或全量清空，`/time-router reset` 与面板按钮走同一条路径。

回退通知由 `describeFallback()` 拼装，固定包含四个信息：来源路由、原因（含状态码）、目标路由、计价后果与恢复方式。计价语句取“切换瞬间是否在高峰窗口内”（`scheduler.inPeakWindow()`），对应上游按时间加价的窗口，而不是目标路由的名字。通知同时写入 `router.notices` 环形缓冲（最多 20 条，状态命令显示最近 3 条）、Harness 日志与状态 API。

## 事件日志格式

每个完成的请求写一条事件：内存状态环有界（`status.maxEvents`），同时追加到 `%DSH_HOME%/plugins/time-router/events.jsonl`，单文件超过 `rotateBytes` 时轮转（`.1` → `.2` → …，最多 `rotateFiles` 份）。

一行即一个 JSON 对象，字段如下：

| 字段 | 类型 | 含义 |
|---|---|---|
| `at` / `atMs` | ISO 字符串 / 数字 | 请求开始时刻（`plan.nowMs`） |
| `dateKey` | `YYYY-MM-DD` | 该时刻在配置时区下的日历日，用量按它分桶 |
| `session` | string \| null | `sha256(sessionId)` 前 12 位；无会话为 `null` |
| `turn` | string \| null | `sha256(userKey)` 前 12 位；无持久轮次为 `null` |
| `route` | `'peak' \| 'offPeak'` | **计划路由**（`plan.routeKey`） |
| `provider` | string | 实际产出该流的 provider（direct 路由为其 `label`） |
| `model` | string | 实际模型 id |
| `tier` | `'chat' \| 'reasoner'` | 虚拟模型档位 |
| `reason` | string | 路由判定原因（含 `inherit-*`、`manual-*`） |
| `isPeak` | boolean | 本次请求开始时是否处于高峰窗口 |
| `crossedIntoPeak` | boolean | 本轮锁是否为 offPeak 且已跨入高峰窗口 |
| `fallback` | object \| null | 回退详情：`fromRouteKey`、`fromProvider`、`fromModel`、`toRouteKey`、`toProvider`、`toModel`、`kind`、`code`、`notice` |
| `failure` | object \| null | 失败事实：`kind`、`code`、可选 `status`、`message`（截断 300 字符） |
| `durationMs` | number | 从开始尝试到结束的毫秒数 |
| `usage` | object \| null | `inputTokens`、`outputTokens`、`totalTokens`，可选 `cacheReadTokens`、`reasoningTokens`（direct 客户端会归一化 OpenAI 的 usage 字段） |
| `outcome` | `'ok' \| 'error' \| 'aborted'` | 结束方式 |

示例（字段值为示意）：

```json
{"at":"2026-11-09T01:55:03.120Z","atMs":1794189303120,"dateKey":"2026-11-09","session":"3f9a1c2b7d10","turn":"a1b2c3d4e5f6","route":"peak","provider":"OpenCode Go","model":"deepseek-v4.1-flash","tier":"chat","reason":"peak-window","isPeak":true,"crossedIntoPeak":false,"fallback":null,"failure":null,"durationMs":1840,"usage":{"inputTokens":512,"outputTokens":96,"totalTokens":608},"outcome":"ok"}
```

隐私边界：事件里**没有** prompt、补全、工具参数与结果、原始 session id、原始轮次 id；会话与轮次只以不可逆哈希前缀出现。密钥从不进入事件。事件写入是异步队列（`appendFile` 串行化）；写入失败不抛错，只记录 `writeError` 并 warn；启动时会回读日志尾部最多 `maxEvents` 行填充状态环，因此重启后面板仍有历史。用量聚合（按天、按路由、今日/近七日）**只在内存里**，重启后从 0 开始累计。

## 设计取舍与偏离直觉方案的决定

以下决定与“最直接的做法”不同，每一项都有明确的失败场景作为理由。

**1. 在 waterfall 拦截，而不是在虚拟 adapter 内部转发。** 最直接的实现是让虚拟 adapter 的 `stream()` 调目标 provider 的 `stream()`。问题是能力投影与校验会执行两次、且第一次用的是虚拟模型（交集）的能力，会把目标路由本来能接受的内容提前裁掉；同时拦截点能拿到 `purpose`/消息 id，而 adapter 内部拿不到。结论：waterfall 拦截负责路由，adapter 只负责“存在”。

**2. 以“最后一条持久用户消息 id”作为轮次身份，而不是会话或时间窗口。** 会话级锁无法在同一会话里为新消息换路；纯时间判定又会在工具循环中途换路。消息 id 是唯一同时满足“新一轮就变、同一轮工具循环不变”的稳定标识。没有它（无会话、注入消息）就退化为按请求判定，而不是瞎猜。

**3. 首 token 提交，而不是断流后从另一条路由续写。** 续写需要把已产出的半截内容、工具调用状态和签名推理状态迁移到另一条路由，语义上不可能干净（重复扣费、重复工具调用、会话日志分叉）。因此选择“第一个 chunk 即承诺”，把不可恢复的失败留到下一个用户轮次。

**4. 用熔断，而不是每轮都重试坏掉的路线。** 一个失效的 key 或耗尽的配额，如果每轮都先试一次，每个用户轮次都要多付一次失败请求和一段延迟。熔断让“已知不可用”的路由在计划期就被跳过，且认证熔断默认不自动恢复（除非配置了冷却），因为认证问题不会自己好。

**5. 能力交集 + TTL 缓存，而不是每次请求实时探测。** 实时探测会给每个请求增加一次 model-info 往返（delegated 路由），且在拓扑变化时抖动。交集保证“公布出去的能力在两条路由上都能用”，60 秒 TTL + `llm/adapters-updated` / `llm/models-updated` 失效足够跟上拓扑变化；代价是能力可能比任一真实路由保守（见局限）。

**6. 归属重定向而非复制历史。** 直接改写 assistant 消息的 `provider`/`model` 会丢失回放状态；复制消息会破坏会话日志与去重。实现只重写归属字段并保留 `replayState`，内容一字不动。

**7. 节假日本地优先 + 后台同步。** 让路由等待网络会把可用性交给第三方站点（国内网络对 GitHub raw 并不总是可达）。因此内置数据永远可用、缓存启动时同步读取、在线同步纯后台；优先级是本地覆盖 > 在线 > 内置 > 仅按星期几，失败只降级。

**8. 回退必须解释自己。** 静默回退会让用户困惑于“为什么模型变了/为什么变贵了”。通知固定输出原因、去向、计价后果与恢复方式；事件日志同时保留 `fallback` 与 `crossedIntoPeak` 供事后核对。

**9. 面板只做 chip + 内联面板，不做独立设置页。** 配置的权威来源是 bundle/profile patch；独立设置页会引入第二份配置需要同步。面板以只读状态为主，配少量高频动作（启停、强制路由、重置熔断、同步、保存密钥），所有写操作最终都落到同一份配置或同一个 key 文件。

**10. 明确放弃的能力。** 不在边界处“平滑迁移”进行中的轮次；不做跨进程/持久化锁；不做费用预测或预算上限；不实现 `debug.probeTool` 对应的工具（探测用 `/time-router probe` 命令）；不为 direct 路由实现图片/文件上传（文本协议，附件投影为确定性占位文本）。

## 局限与已知取舍

- **锁是内存态。** 插件重载/重启丢失锁；多进程或多 profile 不共享；不跨设备。因此这也是唯一被接受的中途换路场景。
- **首 token 后不可回退。** 上游断流只能以错误结束本轮；已产出的 token 照常计费，插件不会重发。
- **跨窗口长轮次按实际时段计费。** 08:50 开始、09:30 仍在输出的轮次会按高峰价计费，事件标记 `crossedIntoPeak: true`。这是“不打断”的代价。
- **虚拟模型能力取交集，可能偏保守。** 例如 peak 直连支持图片、offPeak 委托只支持文本时，虚拟模型只广告文本；`maxTokens` 取两条路由较小值，因此单轮输出上限可能低于某一条真实路由。
- **direct 路由只支持文本。** 图片被投影为 `[image omitted because the direct route accepts text only; attachment <id>]`，文件使用 Harness 提供的确定性文件句柄文本（`llm.fileRequestText()`），拿不到时退化为固定占位文案。
- **direct 路由只实现 Chat Completions SSE 协议。** 非 OpenAI 兼容协议、Responses API、二进制流不在支持范围。
- **用量准确性取决于上游是否返回 usage。** 不返回 usage 的响应只计入请求数、不计 token；用量是内存态，重启清零；运行期回退的轮次，token 按**计划路由**分桶（`route` 字段），而 `provider`/`model` 记录实际来源，两者在回退轮次上可能不一致。这是当前实现的一个已知记账细节。
- **事件日志是尽力而为。** 异步追加、无 fsync；进程被强杀可能丢尾部若干行（启动回读时会跳过残行）；日志轮转在单进程内串行执行，不处理其他进程同时写同一文件的情况。
- **时钟偏差只展示不修正。** 抓取节假日在线数据时，插件会用响应头 `Date` 与本机时间推算偏差并在状态接口里给出 `clockSkewMs`；但路由判定使用本机时钟，不做自动校正，也不从模型 provider 的响应里取样。
- **节假日依赖第三方镜像。** 官方通知由 `NateScarlet/holiday-cn`（MIT）与 `timor.tech`（CC BY-NC-SA 4.0，非商业、限流）镜像；`timor` 缺 2027 数据，2028 年安排截至 2026-11-09 尚未公布。空在线结果不会被当作“全年无休”，内置数据兜底。
- **面板状态是轮询快照。** 面板每 15 秒拉一次状态，配置改动后面板会等待约 500 ms 再刷新，因此界面可能短暂显示旧状态。
- **没有费用数字。** 插件只描述计价档位（高峰/非高峰），不计算金额，也不阻止超额。
- **Web UI 未经视觉走查。** Host 侧 API、配置生效与路由行为有验证；浏览器内 chip/面板的实际渲染请以 Harness 页面为准。

## 测试策略

测试全部是 `node:test` 单元测试，不依赖 Harness 运行时，也不需要网络：

| 文件 | 覆盖点 |
|---|---|
| `test/config.test.js` | 默认值、direct/delegated 判定、窗口校验、时区/覆盖/手动/调试字段报错、未知键告警、数组替换语义 |
| `test/schedule.test.js` | 半开窗口边界、周末/节假日/补班日、下次切换、手动覆盖与过期、停用、`fakeNow`、系统时区无关性 |
| `test/holidays.test.js` | 内置 2025–2027 分类、覆盖优先级、holiday-cn/timor 解析、缓存写入、失败保留旧数据、缺年降级告警 |
| `test/openai.test.js` | SSE 映射（reasoning/text/tool/usage/finish）、401/缺失密钥/密钥文件、错误事件、消息与工具转换、HTTP 分类 |
| `test/router.test.js` | 轮次分类与锁、跨窗口标记、计划期熔断回退、同路由重试后跨路由回退、首 chunk 后提交、归属重写、未知模型 |
| `test/core.test.js` | 锁 LRU/TTL、状态环与用量聚合、失败分类、回退文案、熔断打开/过期/重置 |

共 43 个测试。`Scheduler`（纯函数 + `now` 注入）、`TurnLocks`/`Breakers`/`StatusStore`（`now` 注入）与 direct 客户端（`fetch` 可替换、密钥目录可注入）在设计时就以可测试性为目标，因此大多数测试无需 monkey-patch 全局状态。
