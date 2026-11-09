# dsh-time-router

中文 · [English](README.md)

`dsh-time-router` 是 DeepSeek Harness（dsh）0.2.2-rc.1 的插件（bundle）：它按北京时间在两个模型路由之间切换——工作日 `09:00–12:00` 与 `14:00–18:00` 走 **peak** 路由，其余时间（含周末与法定节假日）走 **offPeak** 路由。插件注册一个虚拟 provider `time-router`（虚拟模型 `auto-flash` / `auto-pro`），在 Harness 的 `llm/stream` waterfall 上拦截发往该 provider 的请求，把本轮锁定到某条真实路由并流式转发；它内置 2025–2027 年中国节假日数据并支持在线刷新，提供按轮锁定、熔断与带说明的回退、状态与用量环、JSONL 事件日志、`/time-router` 命令、HTTP 状态 API，以及输入框停靠区里的状态 chip。

## 目录

- [特性](#特性)
- [路由方式](#路由方式)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [命令与面板](#命令与面板)
- [回退与计费语义](#回退与计费语义)
- [节假日](#节假日)
- [隐私](#隐私)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [许可证](#许可证)

## 特性

- **按北京时间峰谷路由**：默认 peak 窗口为工作日 `09:00–12:00`、`14:00–18:00`（`Asia/Shanghai`），区间为半开 `[start, end)`；窗口之外的请求走 offPeak。
- **节假日感知**：周六、周日与法定节假日全天走 offPeak；国务院通知里的调休补班日按工作日处理，照常按窗口判定。
- **虚拟 provider + 虚拟模型**：`time-router` / `auto-flash`、`auto-pro`（均可改名）。Harness 的模型选择器、能力校验与会话归属看到的都是一个稳定的 provider/model 对。
- **每条路由可选直连或委托**：带 `baseURL` 的路由是 *direct*（插件自己说 OpenAI Chat Completions 协议）；只写 `provider:` 的路由是 *delegated*（复用已注册的 Harness 路由）。两条路由独立选择。
- **按轮锁定，绝不中途换路**：同一轮（以该轮最后一条持久的用户消息 id 标识）内路由不变；工具循环续写、会话标题/压缩等辅助请求继承本轮的锁。
- **首 token 提交语义**：第一个 chunk 之前最多同路由重试一次（可配），然后可切到另一条路由；第一个 chunk 之后本轮提交，不再回退。
- **熔断**：认证类失败（含缺少密钥）让该 provider/model 进入认证熔断，直到重置或更换凭据；配额类失败按 `Retry-After` 或 `quotaCooldownMinutes` 有界冷却。熔断打开的路线在下一轮直接被跳过，不再浪费一次失败请求。
- **回退有说明**：通知写明哪条路线、因为什么、切到哪条，以及按当前时段该轮的计价后果；跨入高峰窗口的长轮次在事件里标记 `crossedIntoPeak`。
- **内置节假日数据 + 可选在线刷新**：`data/holidays-2025.json`、`holidays-2026.json`、`holidays-2027.json`；在线源为 `NateScarlet/holiday-cn`（MIT）与 `timor.tech`（CC BY-NC-SA），按优先级回退，永不阻塞请求。
- **状态与用量**：内存状态环、按天按路由的 token 用量、JSONL 事件日志（5 MB × 3 份轮转）。
- **命令与面板**：`/time-router [probe|sync|reset]`；输入框停靠区的状态 chip 与内联面板；`GET /api/time-router/status`、`POST /api/time-router/state`。
- **零运行时依赖**：插件代码不 import 任何 `@deepseek-ai/*` 包，`link:`／本地目录安装无需 `node_modules`。

## 路由方式

请求进入 Harness 后，先经过 `llm/stream` waterfall，再进入 adapter 投影与派发。插件在这个 waterfall 上做一次投影前的判定：

```text
                     ┌────────────────────────────────────────────────────┐
  GenerateOptions ──▶│ llm/stream waterfall                               │
  provider: ?        │  provider != "time-router"  ──▶ next()（原样放过）  │
                     └───────────────────────┬────────────────────────────┘
                                             │ provider == "time-router"
                                 ┌───────────▼───────────┐
                                 │ 判定本轮路由           │ manual > enabled > 节假日 > 窗口
                                 └───────────┬───────────┘
               工作日的 peak 窗口内           │            其他时间 / 周末 / 法定节假日
                 ┌───────────────────────────┴───────────────────────────┐
        ┌────────▼─────────┐                                  ┌──────────▼──────────┐
        │ peak 路由         │                                  │ offPeak 路由         │
        │ direct：自带端点  │                                  │ delegated：委托已有  │
        │ 或 delegated      │                                  │ Harness 路由         │
        └────────┬─────────┘                                  └──────────┬──────────┘
                 └───────────────────────┬───────────────────────────────┘
                              首 token 前：重试 / 回退；首 token 后：本轮提交
```

**判定顺序**（`Scheduler.evaluate()`，纯函数，只依赖当前时刻、配置与节假日日历）：

1. `manual.mode` 为 `peak` / `offPeak` 且未过期 → 强制走该路由（**优先级高于 `enabled: false`**）。
2. `enabled: false` → 固定 offPeak，原因 `disabled`，不再发生切换。
3. 当天是工作日（普通工作日或调休补班日）且当前时刻落在某个 `peakWindows` 区间内 → peak，原因 `peak-window`。
4. 其余 → offPeak，原因按日历给出：`statutory-holiday`（法定节假日）、`makeup-workday-outside-window`（补班日但不在窗口内）、`weekend`（周末）、`outside-peak-window`（工作日窗口外）。

**路由形态**（`src/config.js`）：解析时以 `baseURL` 是否存在区分——有 `baseURL` 即 direct，必须有 `models.chat` / `models.reasoner`，由插件按 OpenAI Chat Completions 协议流式调用；只有 `provider:` 即 delegated，请求被改写成该已注册路由的 provider/model 后交给 Harness 自己的 adapter 流式处理。两种形态可以任意组合（默认就是 peak 直连 + offPeak 委托）。

**默认路由与核验**（2026-11-09 实测）：

- **peak（direct）**：OpenCode Go，`https://opencode.ai/inference/go/openai/v1`，模型 `deepseek-v4.1-flash`（chat）/ `deepseek-v4-pro`（reasoner），`contextWindow: 1000000`、`maxTokens: 384000`、推理档位 `low/high/max`、纯文本。实测该端点返回 OpenAI chat-completion SSE：`reasoning_content` 增量、最终 chunk 带 usage；其 DeepSeek 加价窗口为周一至周五 `01:00–04:00` 与 `06:00–10:00` UTC，即 `09:00–12:00` / `14:00–18:00` Asia/Shanghai，与默认 peak 窗口完全一致——这是默认值的由来。
- **offPeak（delegated）**：委托给已注册的 `deepseek-official` 路由，模型 `deepseek-flash`（chat）/ `deepseek-v4-pro`（reasoner）。

**虚拟模型能力**（`Router.virtualCapabilities()`）：虚拟模型对 Harness 公布两条真实路由的“安全交集”——最小 `contextWindow`、最小 `defaultMaxTokens`、两条路由都支持的输入模态、以及推理档位的并集（默认档优先取 offPeak，其次 peak）。每次派发再按目标路由的实际能力裁剪（例如目标不支持某个 `reasoningEffort` 时去掉它）。

**本轮锁**（`src/locks.js`）：路由在“新一轮开始”时选定，锁键是该会话最后一条*持久*用户消息的 id（`source.kind === 'user'` 且有 `id`）。工具循环的续写仍带同一个消息 id，因此继承锁；辅助请求（任何设置了 `purpose` 的调用，例如会话标题、压缩）也继承锁。没有会话或无持久用户消息 id 的请求（例如一次性探测）不落锁，按请求到达时刻单独判定。锁是内存态：24 小时过期、最多 200 个会话、按 LRU 淘汰；**插件重载会丢失锁**，重载后的下一个请求按当时时间重新判定——这是唯一被接受的中途换路场景（见[回退与计费语义](#回退与计费语义)）。

## 快速开始

**前置条件**

- DeepSeek Harness **0.2.2-rc.1**（Desktop 或 Web 均可；Web 面板需要带 web server 的 profile）。
- Node **≥ 22**（只用于跑测试；插件本身零运行时依赖，`link:`／本地目录安装不需要 `node_modules`）。

**1. 安装插件**

三种等价方式，任选其一：

- Harness 的 **Plugins 页面**：选择“从本地目录安装”，指向本仓库的绝对路径。
- Agent 工具 `plugin_manager`：以本仓库的绝对目录作为安装目标。
- 命令行（`dsh` CLI 会把参数转发给该 profile 目录下的 pnpm）：

```bash
dsh plugin --profile desktop add C:\path\to\dsh-time-router
```

`dsh plugin` 内部转发给 pnpm，因此安装本地目录会生成 `link:` 依赖。**卸载前请先把 Harness 默认模型切回真实路由，再移除 bundle**：虚拟路由随插件卸载而消失，默认模型仍指向 `time-router` 会破坏模型选择。卸载用 `dsh plugin --profile desktop remove dsh-time-router`，或在 Plugins 页面移除该 bundle。

**2. 配置路由与密钥**

默认配置即可用：peak 直连 OpenCode Go，offPeak 委托给已注册的 `deepseek-official` 路由。直连路由需要一个密钥，按以下顺序解析（`src/openai.js`）：

1. 配置里的 `peak.apiKey`（**不推荐**，会把明文写进 profile patch，加载时会告警）。
2. 环境变量 `peak.apiKeyEnv` 指向的变量（默认 `OPENCODE_API_KEY`）。
3. `peak.apiKeyFile` 指向的文件（支持 `{dshHome}` 占位；注意 `~` 展开到 **DSH_HOME**，不是操作系统用户目录）。
4. 插件数据文件 `%DSH_HOME%/plugins/time-router/keys/peak.key`（面板里“保存密钥”就写到这里）。

配置文件放在 profile 的 `cordis.patch.yml`，以 `id: time-router` 覆盖 bundle 内那一行的 config（**profile patch 的 `config` 是整块替换而非深合并**，但插件自身会与内置默认值合并，所以只写想改的字段即可）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: time-router
  name: dsh-time-router
  config:
    enabled: true
    timezone: Asia/Shanghai
    peakWindows:
      - ['09:00', '12:00']
      - ['14:00', '18:00']
    peak:
      label: OpenCode Go
      baseURL: https://opencode.ai/inference/go/openai/v1
      apiKeyEnv: OPENCODE_API_KEY
      models:
        chat: deepseek-v4.1-flash
        reasoner: deepseek-v4-pro
      contextWindow: 1000000
      maxTokens: 384000
      inputModalities: ['text']
      reasoningEfforts: ['low', 'high', 'max']
      requestTimeoutMs: 600000
    offPeak:
      provider: deepseek-official
      models:
        chat: deepseek-flash
        reasoner: deepseek-v4-pro
    fallback:
      enabled: true
      sameProviderRetry: 1
      quotaCooldownMinutes: 30
      authCooldownMinutes: 0
```

如果安装的是本仓库的 `link:` 检出，也可以直接改仓库内的 [`cordis.patch.yml`](cordis.patch.yml)（两种写法等价）。

**只有委托路由的配置**（两条路线都复用已在 Harness 注册的 provider）：

```yaml
- id: time-router
  name: dsh-time-router
  config:
    peak:
      provider: my-peak-gateway
      models:
        chat: deepseek-v4.1-flash
        reasoner: deepseek-v4-pro
    offPeak:
      provider: deepseek-official
      models:
        chat: deepseek-flash
        reasoner: deepseek-v4-pro
```

> 委托路由的 `models` 建议显式写出：不写时 peak 会继承默认的 `deepseek-v4.1-flash` / `deepseek-v4-pro`，offPeak 会继承 `deepseek-flash` / `deepseek-v4-pro`，不一定是目标 gateway 上真实存在的模型 id。若两条委托路由指向同一个 provider，加载时会告警“time routing has no effect until they differ”。

**3. 把 Harness 默认模型指向虚拟路由**

只有把默认模型设成 `time-router` / `auto-flash`（推理任务可用 `auto-pro`），流量才会经过路由器；否则插件处于空闲状态。两种方式等价：

- **Settings → Models** 里选择 provider `time-router`、模型 `auto-flash`。
- 在 profile patch 里覆盖默认模型行：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: time-router
    model: auto-flash
    reasoningEffort: high
```

**4. 验证**

在会话里执行 `/time-router probe`：它会通过虚拟路由发一条 16 token 的小请求（“Reply with the single word: pong”），并报告本轮被路由到哪条路线、原因是什么、模型回了什么。也可以直接看 `/time-router` 的状态输出，或 `GET /api/time-router/status`。

## 配置参考

完整字段表（类型、默认值、取值范围、校验规则）、密钥存储、告警列表与三个完整示例见 **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。摘要：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时固定走 offPeak（原因 `disabled`） |
| `timezone` | `Asia/Shanghai` | IANA 时区名，所有日历判定都显式换算到该时区 |
| `peakWindows` | `[['09:00','12:00'], ['14:00','18:00']]` | 半开区间；不允许跨午夜、起止相同；重叠会告警 |
| `peak` | 直连 OpenCode Go | 有 `baseURL` 即 direct；否则须有 `provider:` |
| `offPeak` | 委托 `deepseek-official` | 同上 |
| `virtual` | `time-router` / `auto-flash` + `auto-pro` | 虚拟 provider 与模型 id |
| `manual` | `{ mode: auto, until: null }` | `auto` / `peak` / `offPeak`，可带 ISO 过期时间 |
| `fallback` | `{ enabled: true, sameProviderRetry: 1, quotaCooldownMinutes: 30, authCooldownMinutes: 0 }` | 重试与熔断冷却 |
| `holidays` | `{ online: true, refreshDays: 7, sources, overrides: {} }` | 在线刷新与手工覆盖（`YYYY-MM-DD → holiday\|workday`） |
| `status` | `{ maxEvents: 200, logFile: true, rotateBytes: 5 MB, rotateFiles: 3 }` | 状态环与事件日志 |
| `debug` | `{ fakeNow: null, probeTool: false }` | `fakeNow` 用于演示/测试时固定时钟 |

非法值在加载时抛错（插件不加载并记录错误）；未知键只告警不失败。

## 命令与面板

### 斜杠命令

```text
/time-router           # 状态（零 token，不发模型请求）
/time-router probe     # 通过虚拟路由发一条最小探测请求并核对返回
/time-router sync      # 立即同步节假日数据
/time-router reset     # 清空全部熔断
```

`/time-router` 的示例输出（数值随实际时刻变化）：

```text
Time router 0.1.0
Now: 2026-11-09 22:35:51 (Monday, workday)
Route: off-peak — outside-peak-window
Next switch: 2026-11-10 09:00:00
Peak: OpenCode Go (deepseek-v4.1-flash / deepseek-v4-pro)
Off-peak: deepseek-official (deepseek-flash / deepseek-v4-pro)
Today: peak 0↑/0↓ tokens, off-peak 0↑/0↓ tokens
```

`peak` / `offPeak` 两行会带上 `— cooling down (<code>)` 表示该路线正处于熔断冷却；最近 3 条回退通知、节假日告警以及 `debug.fakeNow` 是否生效也会追加在输出里。

### Web 面板

Client 半（[`client.js`](client.js)）在 **`conversation.composer.dock`** 槽位注册一个 chip（id `time-router-status`，`order: 20`）：圆点颜色表示当前路由（高峰/非高峰/已停用），文字显示当前路由与下次切换时间，点击展开内联面板。面板内容：当前时刻/星期/日类型、路由与原因、下次切换、两条路由的标签与模型、熔断状态、今日 peak/off-peak 输入输出 token、节假日告警、快捷操作（自动 / 强制高峰 / 强制非高峰 / 启停路由 / 重置熔断 / 同步节假日）、直连路由的密钥保存框，以及最近事件（含 `↩ fallback`、`↑ billed at peak price`、失败标记）。面板每 15 秒轮询一次状态接口。

> 说明：本插件在 Harness 页面里渲染 chip 与面板；请以 Harness 页面中实际可见的效果为准。项目验证阶段仅确认了 Host 侧 API 与配置生效，**未做浏览器视觉走查**。

### HTTP API

仅当 profile 同时提供 `webServer` 与 `connection` 服务时注册；每个请求先经过 Harness 的 `connection.requestRejection()`（Host/Origin 与浏览器认证）检查。没有 web server 的 profile 会跳过这段 API，插件其余功能不受影响。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/time-router/status?events=25` | 一次返回完整快照：插件/虚拟路由、当前判定、日历与告警、两条路由与熔断、通知、最近事件、用量、`clockSkewMs`、缓存文件路径 |
| `POST` | `/api/time-router/state` | 快捷操作（见下） |

`POST` 请求体支持的字段：

- `{"enabled": false}` 或 `{"manualMode": "auto"|"peak"|"offPeak", "manualUntil": null|ISO}`：写入配置并**重启插件**（返回 `{"ok":true,"restarting":true}`）；没有配置编辑器时返回错误，此时请直接改 bundle patch。
- `{"resetBreakers": true, "provider": "<可选>"}`：重置全部或某个 provider 的熔断。
- `{"syncHolidays": true}`：立即同步节假日。
- `{"apiKey": "...", "routeKey": "peak"}`：把密钥写入 `%DSH_HOME%/plugins/time-router/keys/peak.key`（仅 direct 路由；文件权限 0600，Windows 上受 ACL 限制）。

状态快照从不返回密钥本体，只返回 `{present, source, hint}` 形式的存在性与来源标记。

## 回退与计费语义

**首 token 是不可逆点。** 插件只在“还没有任何 chunk 交给 Harness”时重试或换路；一旦第一个 chunk 已经流出去，本轮就提交给当前 provider，后续即使断流也不会重复发送（避免重复扣费、重复工具调用和会话日志错乱）。

首 token 之前的失败处理（`Router.recover()`）按失败分类执行：

| 失败 | 处理 |
|---|---|
| 认证（401/403、缺少凭据、无效 key 等） | 打开**认证熔断**（直到手动重置或更换凭据才恢复），本轮切到另一条路由 |
| 配额（402，或 429 且响应提示 quota/balance/credit/usage limit） | 打开**配额熔断**（有 `Retry-After` 用 `Retry-After`，否则用 `quotaCooldownMinutes`），本轮切到另一条路由 |
| 限流（429 无配额语义） | 无 `Retry-After` 或 `Retry-After` ≤ 5 s 时同路由重试（受 `sameProviderRetry` 限制）；否则切到另一条路由 |
| 服务端/传输类（5xx、网络、超时、空响应） | 可重试；重试次数用尽后切到另一条路由 |
| 上下文超限（400/413/422 且提示 context length 等） | **不回退**，直接把错误交给用户（换路由也不会变短，重试无意义） |
| 主动中止（abort） | 直接结束，不回退 |
| `fallback.enabled: false` | 关闭重试与运行时跨路由回退：失败即结束，也不记录新的熔断 |

回退时有两条约束：一次请求最多切一次路由（`attemptedRoutes` 防止来回横跳）；若另一条路由也已熔断，则直接返回错误。

**回退通知**由 `describeFallback()` 生成，说明“谁、为什么、切到谁、计价后果、何时恢复”，例如：

```text
OpenCode Go reported exhausted quota (429); this turn switched to deepseek-official —
this turn is billed at peak pricing; OpenCode Go cools down until 2026-11-09T04:30:00.000Z.
```

通知出现在 `/time-router` 状态输出（最近 3 条）、Harness 日志（warn）与状态 API 的 `notices` 字段；面板事件行则用 `↩ fallback`、`↑ billed at peak price` 标记回退与跨窗口轮次。通知里的计价语句取“切换瞬间是否处于高峰窗口”，对应 OpenCode Go 对 DeepSeek 的加价窗口，而不是目标路由的名字。

**跨窗口的长轮次照实计价。** 因为绝不中途打断，一个 08:50 开始、跑到 09:30 的长轮次会继续留在它开始时选定的路由上；如果该轮在高峰窗口内仍在产生 token，上游就按高峰价计费。这类轮次在状态事件里标记 `crossedIntoPeak: true`，面板显示 `↑ billed at peak price`。这是刻意的取舍：宁可计价上多花一点，也不打断一轮对话或重复一次工具调用。

**插件的重载/重启**是唯一被接受的中途换路场景：锁是内存态，重载后下一轮请求重新判定；已经在流式输出中的请求由 Harness 侧结束，不影响本次语义。面板里改 `enabled` / `manual` 会写配置并触发插件重启，因此也会丢掉锁。

## 节假日

- **内置数据**：随包发布 `data/holidays-2025.json`、`data/holidays-2026.json`、`data/holidays-2027.json`（含 `year`、`source`、`verifiedAt`、`holidays`、`makeupWorkdays`）。2025 年 28 个放假日 + 5 个补班日，2026 年 33 + 6，2027 年 29 + 5；数据核对记录见 [docs/holiday-sources.md](docs/holiday-sources.md)。
- **优先级**：`holidays.overrides`（手工）> 在线数据 > 内置数据 > 仅按周一至周五判断。
- **在线刷新**：`holidays.online: true` 时启动后异步同步一次，之后每 6 小时一次；每次同时取“当前年”和“下一年”，新鲜度由 `refreshDays` 控制。同步失败保留旧数据，只产生面板告警，**从不阻塞路由请求**。
- **在线源**（按顺序尝试，首个成功即止，单源超时 10 s）：
  1. `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`（MIT）
  2. `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`（MIT，jsDelivr 备用）
  3. `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json`（MIT，部分网络环境不可直连）
  4. `https://timor.tech/api/holiday/year/{year}`（CC BY-NC-SA 4.0，非商业；限额 10000 次/IP/24h）
- **缓存**：`%DSH_HOME%/plugins/time-router/holidays.cache.json`（先写临时文件再 rename；启动时同步读取，保证重启后第一个请求就能用）。
- **年份覆盖**：节假日数据每年 11 月前后由国务院公布，插件从每年 11 月起对“下一年”缺数据的情况给出告警。以 2026-11-09 核验时点为准，2028 年安排尚未公布（在线源对 2028 返回 404/空对象），2027 年数据已内置。
- **注意**：`timor.tech` 目前尚无 2027 年数据；在线源返回空对象不等于“全年无休”，内置数据优先保证正确。

## 隐私

- **事件日志只记路由事实，不记内容**。JSONL 每行一个 JSON 对象，字段为：`at`/`atMs`、`dateKey`、`session`（sha256 前缀 12 位）、`turn`（sha256 前缀 12 位）、`route`、`provider`、`model`、`tier`、`reason`、`isPeak`、`crossedIntoPeak`、`fallback`（回退详情）、`failure`（失败事实）、`durationMs`、`usage`（输入/输出/缓存/推理 token）、`outcome`。
- **永不写入**：prompt、补全文本、工具参数/结果、原始 session id、原始轮次 id。会话与轮次只以不可逆的哈希前缀出现。
- **密钥**：任何日志、状态输出、HTTP 响应都不包含密钥本体；状态里只给出 `source` 标记（`config`、`env:NAME`、`file`、`auto-key-file`）与是否存在。面板写入的密钥落在 `%DSH_HOME%/plugins/time-router/keys/peak.key`（尽量 0600）。
- **日志轮转**：默认单文件 5 MB，超过后轮转为 `events.jsonl.1`、`.2`、`.3`；`logFile: false` 可完全关闭磁盘日志（内存状态环不受影响）。用量统计存在内存里，重启后从 0 重新累计。

## 故障排查

常见问题的完整处理步骤见 **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**。速查：

| 现象 | 首先检查 |
|---|---|
| 直连路由返回 `MISSING_CREDENTIAL` | 密钥来源：`apiKeyEnv` 对应的环境变量、`apiKeyFile`、`%DSH_HOME%/plugins/time-router/keys/peak.key`（`~` 展开到 DSH_HOME） |
| 出现 401/403，路线进入冷却 | 换 key 或修正配置后 `/time-router reset`（认证熔断不会自己过期） |
| 出现 402/429 配额错误 | 等配额恢复或切路由；配额熔断有界冷却，`Retry-After` 优先 |
| 看到 `↩ fallback` / 回退通知 | 通知里写明原因与计价后果；状态 API 的 `notices`、`events` 与事件日志可查完整记录 |
| 时间判定与预期不符 | 确认 `timezone`、`peakWindows` 半开区间、`manual` 覆盖、`debug.fakeNow`；面板显示的是 Asia/Shanghai 时间 |
| 节假日数据过期/缺失 | `/time-router sync`；检查 `%DSH_HOME%/plugins/time-router/holidays.cache.json` 的 `fetchedAt` 与面板告警 |
| 模型选择器里找不到 `auto-flash` | 插件行是否启用、虚拟 provider 是否注册成功；见日志中 `time-router: virtual provider ... ready` |
| 面板请求 401 | 面板走 Harness 的 `connection` 校验；从 Harness 页面内打开，不要直接访问 API URL |
| 需要看日志 | Harness 日志（provider 启动/同步/回退告警）；`%DSH_HOME%/plugins/time-router/events.jsonl`（路由事件）；`holidays.cache.json`（节假日缓存） |

## 开发与测试

代码布局：

```text
index.js              Host 半：注册虚拟 provider、waterfall 拦截、命令、面板 API
client.js             Client 半：composer dock 的 chip 与内联面板
src/config.js         配置合并、校验、direct/delegated 判定
src/schedule.js       当前时刻的纯函数路由判定与下次切换
src/holidays.js       节假日数据链、内置/在线/缓存/覆盖
src/router.js         llm/stream 拦截、按轮锁、能力投影、回退状态机
src/openai.js         直连 OpenAI 兼容路由的 SSE 客户端
src/adapter.js        虚拟 provider 的 LlmAdapter
src/locks.js          按轮锁（LRU + TTL）
src/breakers.js       认证/配额熔断
src/failure.js        失败分类与回退文案
src/status.js         状态环、用量统计、JSONL 事件日志与轮转
src/time.js           时区安全的日历/时间换算
data/                 2025–2027 内置节假日数据
locale/               en/zh 文案
test/                 config / schedule / holidays / router / openai / core 六个测试文件
```

要求 Node ≥ 22，**没有依赖要安装**：

```bash
# 推荐：逐个文件跑（沙箱环境下 node --test test/ 可能不可用）
for f in test/*.test.js; do node "$f"; done

# 或者
node --test test/*.test.js
```

当前共有 **43 个单元测试**（config 7、schedule 8、holidays 6、openai 8、router 9、core 5），全部通过；CI 用同样的逐文件方式在 Node 22 上运行，并对每个 JS 文件执行 `node --check`。

贡献流程、代码不变量与 PR 检查清单见 **[CONTRIBUTING.md](CONTRIBUTING.md)**；架构与设计取舍见 **[docs/DESIGN.md](docs/DESIGN.md)**。

**验证状态**（2026-11-09，`Asia/Shanghai`）：

- 43 个单元测试全部通过（`node test/<file>.test.js` 逐文件执行）。
- 插件已以 `link:` 方式安装进 Desktop profile，bundle 列表与 `id: time-router` 的行处于启用状态，`agent-default-model` 指向 `time-router` / `auto-flash`。
- **端到端路由实测通过**：默认模型指向 `time-router` / `auto-flash` 的新会话依次走通三条路径——非高峰委托 `deepseek-official`（`deepseek-flash`）、强制高峰直连 OpenCode Go（`deepseek-v4.1-flash`，含 reasoning token 用量）、以及移除密钥后的认证回退（`MISSING_CREDENTIAL` → 本轮自动切到 `deepseek-official` 并记录回退通知）。每次真实请求都写入 `%DSH_HOME%/plugins/time-router/events.jsonl`，会话日志里的 `request/header` 记录的是虚拟路由 `time-router` / `auto-flash`。
- 节假日在线同步已实际跑通：`%DSH_HOME%/plugins/time-router/holidays.cache.json` 中记录了 2026 与 2027 的抓取结果。
- HTTP 状态接口已注册到运行中的 Harness：从浏览器会话以外直接请求 `GET /api/time-router/status` 会得到 401，即 Harness 的 `connection` 校验生效。
- 浏览器内 chip/面板的视觉效果未做自动化验证，请以 Harness 页面实际渲染为准。

## 许可证

MIT，见 [LICENSE](LICENSE)。节假日数据来自政府公开通知与上述第三方镜像；`timor.tech` 数据为 CC BY-NC-SA 4.0（非商业用途），商业分发请以 `NateScarlet/holiday-cn`（MIT）与内置数据为准。
