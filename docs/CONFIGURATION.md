# 配置参考

本文档说明 `dsh-time-router` 的全部配置字段、默认值、校验规则、密钥存储与文件位置，并给出三个完整示例。字段行为以 `src/config.js`、`src/openai.js`、`index.js` 的实现为准。

## 目录

- [配置写在哪儿](#配置写在哪儿)
- [顶层字段](#顶层字段)
- [路由字段（peak / offPeak）](#路由字段peak--offpeak)
- [路由形态的判定与继承规则](#路由形态的判定与继承规则)
- [virtual](#virtual)
- [manual](#manual)
- [fallback](#fallback)
- [holidays](#holidays)
- [status](#status)
- [debug](#debug)
- [密钥存储](#密钥存储)
- [校验错误与告警](#校验错误与告警)
- [文件与环境变量](#文件与环境变量)
- [完整示例](#完整示例)

## 配置写在哪儿

插件是一个 bundle：仓库里的 [`cordis.patch.yml`](../cordis.patch.yml) 插入一行 `id: time-router`、`name: dsh-time-router` 的 Host 插件，以及一个 Client 模块。用户配置有两种等价写法：

**A. Profile patch（推荐，随 profile 保存，不随仓库更新丢失）**

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: time-router
  name: dsh-time-router
  config:
    enabled: true
    peakWindows:
      - ['09:00', '12:00']
      - ['14:00', '18:00']
```

**B. 仓库内的 bundle patch**（适合 `link:` 检出的本地开发）

直接编辑本仓库的 [`cordis.patch.yml`](../cordis.patch.yml) 中 `id: time-router` 那一行的 `config:`。

两点语义需要注意：

- Profile patch 里的 `config:` 是**整块替换**该行的 config，不会与 bundle patch 里的 config 深合并；但插件自身会与内置默认值合并，所以只写想改的字段是安全的。
- 只写 `id` 不写 `insert` 的 patch 会覆盖已有行；`name` 用于断言目标插件名，建议与安装的包名（`dsh-time-router`）保持一致。

配置改动在插件行重新加载后生效。通过面板的快捷操作修改 `enabled` / `manual` 时，插件会写入配置并重启自身（状态接口返回 `restarting: true`）。

## 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` 时固定走 offPeak，判定原因为 `disabled`，不再发生切换。注意 `manual` 覆盖优先于此项。 |
| `timezone` | string | `Asia/Shanghai` | IANA 时区名。所有日历判定（日期、星期、窗口、下次切换）都显式换算到该时区，不依赖操作系统时区。 |
| `peakWindows` | `[string, string][]` | `[['09:00','12:00'], ['14:00','18:00']]` | 高峰窗口，24 小时制 `HH:MM`，半开区间 `[start, end)`；必须非空；不允许起止相同或跨午夜（跨午夜请拆成两个窗口）；按开始时间排序，重叠会告警（按并集处理）。 |
| `peak` | object | 直连 OpenCode Go | 高峰路由，见[路由字段](#路由字段peak--offpeak)。 |
| `offPeak` | object | 委托 `deepseek-official` | 非高峰路由，同上。 |
| `virtual` | object | `time-router` / `auto-chat`+`auto-reasoner` | 虚拟 provider 与虚拟模型，见 [virtual](#virtual)。 |
| `manual` | object | `{ mode: auto, until: null }` | 手动覆盖，见 [manual](#manual)。 |
| `fallback` | object | 见 [fallback](#fallback) | 重试与熔断冷却。 |
| `holidays` | object | 见 [holidays](#holidays) | 节假日数据链。 |
| `status` | object | 见 [status](#status) | 状态环与事件日志。 |
| `debug` | object | `{ fakeNow: null, probeTool: false }` | 演示/测试辅助。 |

## 路由字段（peak / offPeak）

一条路由要么是 **direct**，要么是 **delegated**：`baseURL` 存在（非空字符串）即为 direct，此时所有 direct 字段生效；否则必须有 `provider:`。两种字段集互斥，未知字段只告警。

### direct 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseURL` | string | 无（出现即 direct） | OpenAI 兼容端点根地址，须以 `http://` 或 `https://` 开头；请求发往 `<baseURL>/chat/completions`。 |
| `label` | string | 由 host 推导 | 显示名与熔断键的一部分。host 为 `opencode.ai` 时为 `OpenCode Go`，其余为 hostname；无法解析时为 `direct-<routeKey>`。 |
| `apiKeyEnv` | string \| null | peak 默认 `OPENCODE_API_KEY` | 密钥环境变量名，须匹配 `^[A-Z_][A-Z0-9_]*$`；设为 `null` 可跳过这一级。 |
| `apiKeyFile` | string \| null | `null` | 密钥文件路径。支持 `{dshHome}` 占位；**`~` 展开到 DSH_HOME**（不是操作系统用户目录）。 |
| `apiKey` | string \| null | `null` | 内联密钥。会把明文写进 profile patch，加载时告警，建议改用前两种或面板保存。 |
| `headers` | `Record<string,string>` | `{}` | 附加请求头。若插件已根据解析出的密钥设置了 `authorization`，这里的 `authorization` 会被忽略。 |
| `models` | `{ chat: string, reasoner: string }` | peak：`deepseek-v4.1-flash` / `deepseek-v4-pro`；offPeak：`deepseek-flash` / `deepseek-v4-pro` | 两条虚拟模型分别映射到的真实模型 id，均不可为空。 |
| `contextWindow` | integer | 262144（未继承时）；默认 peak 路由为 1000000 | 向 Harness 公布、并与另一条路由取交集的上下文窗口，范围 1–10000000。 |
| `maxTokens` | integer | 32768（未继承时）；默认 peak 路由为 384000 | 单次输出上限，请求的 `maxTokens` 会被钳制到该值，范围 1–10000000。 |
| `inputModalities` | `('text'\|'image')[]` | `['text']` | 输入模态；必须非空，`text` 始终保留并置首。虚拟模型只广告两条路由都支持的模态。 |
| `reasoningEfforts` | string[] \| null | 默认 peak 路由为 `['low','high','max']` | 该路由支持的推理档位。设为 `[]` 或 `null`（或该位置没有内置默认值时省略）后，既不发送 `reasoning_effort`，也不向 Harness 广告档位；虚拟模型只广告两条路由档位的并集，派发时按目标路由裁剪。 |
| `requestTimeoutMs` | integer | `600000` | 单次请求超时，与调用方的 `signal` 组合，范围 1000–3600000。 |

### delegated 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | string | 无（出现且无 `baseURL` 即 delegated） | 已注册的 Harness 路由 id。不得等于 `virtual.provider`（否则加载报错）。 |
| `models` | `{ chat: string, reasoner: string }` | 该位置的内置默认模型 | 目标路由上的真实模型 id。**建议显式写出**，否则会继承内置默认值，可能不是目标路由上存在的模型。 |

delegated 路由的请求由 Harness 自己的 adapter 处理；插件只做两件事：把 `provider`/`model` 改写成目标值，并把历史消息里属于虚拟 provider 的 assistant 归属重写到目标 provider/model（保留 `replayState`），以便目标 adapter 恢复自己的回放状态。

## 路由形态的判定与继承规则

`resolveConfig()` 对两条路由分开处理，规则略不对称：

1. **delegated**（用户写了 `provider:` 且没写 `baseURL`）：只继承该位置的默认 `models`，不继承 `baseURL`、`contextWindow` 等 direct 字段。
2. **direct**（用户写了 `baseURL`）：以该位置的内置默认值为基底做合并。因此：
   - 自定义 peak 直连端点时，除非显式覆盖，否则会继承 peak 默认的 `models`（`deepseek-v4.1-flash` / `deepseek-v4-pro`）、`contextWindow: 1000000`、`maxTokens: 384000`、`reasoningEfforts: ['low','high','max']`、`apiKeyEnv: OPENCODE_API_KEY`、`requestTimeoutMs: 600000`。
   - 把 **offPeak 改成直连**时，内置 offPeak 默认值里带有 `provider: deepseek-official`，它会留在合并结果里，从而产生一条 `unknown configuration key "offPeak.provider"` 告警（无害，direct 模式不使用该字段）。该位置的 direct 默认值为 `contextWindow: 262144`、`maxTokens: 32768`、无 `apiKeyEnv`，因此还需配好密钥来源，否则会再收到"没有密钥来源"的告警。
3. 两条委托路由指向同一个 provider 时告警：此时时间路由没有实际效果，直到两者不同。
4. `virtual.models.chat` 与 `virtual.models.reasoner` 相同时告警：一个虚拟模型就够了。

## virtual

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `virtual.provider` | string | `time-router` | 虚拟 provider id。插件在激活时用该 id 注册 adapter，并拦截发往它的 `llm/stream`。 |
| `virtual.models.chat` | string | `auto-chat` | 聊天虚拟模型 id。 |
| `virtual.models.reasoner` | string | `auto-reasoner` | 推理虚拟模型 id。必须是两个不同的值才有意义（相同会告警）。 |

改名后记得同步把 Harness 的默认模型指向新的 provider/model id；旧的默认模型会指向一个不存在的路由，从而破坏模型选择。

## manual

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `manual.mode` | `'auto' \| 'peak' \| 'offPeak'` | `auto` | `auto` 按时间判定；`peak` / `offPeak` 强制该路由。**优先级高于 `enabled: false`。** |
| `manual.until` | ISO 8601 string \| null | `null` | 覆盖的过期时刻；`null` 表示不自动过期（此时"下次切换"显示为 `pinned`）。`mode` 为 `auto` 时该字段被忽略并告警。 |

`until` 已过期时判定自动回到 `auto`，不需要手工清理。面板的"自动 / 强制高峰 / 强制非高峰"按钮会写入 `manual` 并触发插件重启。

## fallback

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `fallback.enabled` | boolean | `true` | `false` 时关闭全部重试与运行时跨路由回退：首 token 前的失败直接返回错误，也不会记录新的熔断。 |
| `fallback.sameProviderRetry` | integer | `1` | 首 token 前对**同一路由**的额外重试次数，范围 0–3。仅对可重试失败（限流、5xx/传输、空响应）生效。 |
| `fallback.quotaCooldownMinutes` | integer | `30` | 配额熔断的默认冷却分钟数，范围 1–1440；若失败带有 `Retry-After` 则优先使用它。 |
| `fallback.authCooldownMinutes` | integer | `0` | 认证熔断的冷却分钟数，范围 0–1440。`0` 表示认证熔断不自动过期，直到面板/命令重置或更换凭据。 |

熔断按 `provider + model` 粒度记录（direct 路由的 provider 用其 `label`）。熔断打开的路由在下一轮会被直接跳过；若两条路由都熔断，请求直接失败。`/time-router reset`、面板"重置冷却"或 `POST /api/time-router/state {"resetBreakers": true}` 可清空。

## holidays

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `holidays.online` | boolean | `true` | 是否启用在线同步。关闭后只用内置数据、缓存与覆盖。 |
| `holidays.refreshDays` | integer | `7` | 在线数据的新鲜窗口（天），范围 1–365；窗口内且已知该年数据时跳过抓取。 |
| `holidays.sources` | string[] | 见下 | 在线源 URL 模板，必须非空且每个都含 `{year}` 占位；按顺序尝试，首个成功即止，单源超时 10 秒。 |
| `holidays.overrides` | `Record<string, 'holiday' \| 'workday'>` | `{}` | 手工覆盖，键为 `YYYY-MM-DD`，值 `holiday`（休息日 → 全天 offPeak）或 `workday`（工作日 → 照常按窗口判定）。优先级最高。 |

默认 `holidays.sources`：

```yaml
- https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json
- https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json
- https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json
- https://timor.tech/api/holiday/year/{year}
```

数据优先级：`overrides` > 在线 > 内置 `data/holidays-YYYY.json` > 仅按周一至周五。在线源说明与许可见 [holiday-sources.md](holiday-sources.md)。

## status

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `status.maxEvents` | integer | `200` | 内存状态环保留的事件数，范围 10–2000；也是启动时从日志回读的行数。 |
| `status.logFile` | boolean | `true` | 是否写 `%DSH_HOME%/plugins/time-router/events.jsonl`。关闭后只在内存里保留状态环与用量。 |
| `status.rotateBytes` | integer | `5242880`（5 MB） | 触发轮转的单文件大小，范围 64 KiB–512 MiB。 |
| `status.rotateFiles` | integer | `3` | 保留的历史文件数，范围 0–9；`0` 表示直接清空当前文件而不保留历史。 |

事件日志每行一个 JSON 对象，字段与隐私边界见 [DESIGN.md](DESIGN.md#事件日志格式) 与 README 的"隐私"一节。

## debug

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `debug.fakeNow` | ISO 8601 string \| null | `null` | 固定判定时钟，用于演示与测试；设置后面板/命令会显示"Debug fakeNow is active"。只影响路由判定，不改变时间戳写入（事件里仍会带上固定时刻）。 |
| `debug.probeTool` | boolean | `false` | 预留字段：解析并保留在配置中，当前运行时不注册对应工具。要探测路由请用 `/time-router probe`。 |

## 密钥存储

direct 路由的密钥解析顺序（`src/openai.js` 的 `resolveApiKey()`）：

1. 配置 `apiKey`（告警：明文进 profile patch）。
2. 环境变量 `apiKeyEnv` 指向的变量（非空才采用）。
3. `apiKeyFile` 指向的文件（`{dshHome}` 占位、`~` 展开到 DSH_HOME）。
4. 插件数据文件 `%DSH_HOME%/plugins/time-router/keys/<routeKey>.key`，即 `peak.key` / `offPeak.key`。

第 3、4 步的文件读取结果有 30 秒缓存；面板保存密钥或调用 `POST /api/time-router/state {"apiKey":...}` 后会立即失效缓存。来源标记（状态接口里的 `source`）为 `config`、`env:<NAME>`、`file`、`auto-key-file` 之一。

约束与安全：

- 密钥值**从不**出现在日志、状态输出或 HTTP 响应里；状态接口只返回 `{present, source, hint}`。
- 面板写入的密钥文件以 `0600` 创建（Windows 上受 ACL 限制，文件位于用户 profile 下）。
- 密钥缺失时请求不会发出，直接以 `MISSING_CREDENTIAL` 结束，并按认证失败处理（开熔断 + 本轮回退）。
- 环境变量名不合规（例如包含小写或连字符）会在加载时报错。

## 校验错误与告警

**加载即报错（插件不加载，日志记录错误）**：

| 触发 | 报文要点 |
|---|---|
| `config` 不是映射 | `config must be a mapping` |
| `timezone` 不是有效 IANA 时区 | `is not an IANA time zone name` |
| `peakWindows` 为空 / 不是二元组 / 格式不是 `HH:MM` / 起止相同 / 跨午夜 | 对应的 `peakWindows[i] ...` 错误 |
| `peak` / `offPeak` 不是对象、`models` 缺失或为空 | `must be an object ...` / `models.chat` |
| `baseURL` 不是 http(s) URL | `must be an http(s) URL` |
| `headers` 不是字符串映射 | `must be a mapping of header names to strings` |
| `apiKeyEnv` 不是合法环境变量名 | `must be an environment variable name like OPENCODE_API_KEY` |
| `contextWindow` / `maxTokens` / `requestTimeoutMs` 越界 | `must be an integer from ... through ...` |
| `inputModalities` 为空或含未知模态 | `must be a non-empty list containing "text" ...` |
| 委托路由缺少 `provider`，或与 `virtual.provider` 相同 | `must differ from virtual.provider` |
| `manual.mode` 非法 / `until` 不是 ISO | `manual.mode must be one of ...` / `ISO 8601` |
| `fallback` 各数值越界 | `must be an integer from ... through ...` |
| `holidays.sources` 为空或缺少 `{year}` | `must contain the {year} placeholder` |
| `holidays.overrides` 键不是 `YYYY-MM-DD` 或值不是 `holiday`/`workday` | `invalid date key` / `must be "holiday" or "workday"` |
| `status` 各数值越界 | `must be an integer from ... through ...` |
| `debug.fakeNow` 不是 ISO | `must be null or an ISO 8601 timestamp` |

**只告警不失败**（`router`/`ctx.logger.warn`，状态接口的 `configWarnings` 可见）：

- 任一层的未知键（如 `config.foo`、`peak.extra`、`manual.bar`）。
- `peakWindows` 区间重叠（按并集处理）。
- `apiKey` 内联。
- direct 路由完全没有密钥来源（`apiKey`/`apiKeyEnv`/`apiKeyFile` 都为 null）。
- 两条委托路由指向同一 provider。
- `virtual.models.chat` 与 `virtual.models.reasoner` 相同。
- `manual.until` 在 `mode: auto` 下被忽略。

## 文件与环境变量

| 名称 | 说明 |
|---|---|
| `DSH_HOME` | Harness 数据目录；未设置时默认 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`）。插件的数据文件都在其下。 |
| `%DSH_HOME%/plugins/time-router/holidays.cache.json` | 在线节假日缓存（`version`、`fetchedAt`、`fetchedYears`、`days`）；启动时同步读取。 |
| `%DSH_HOME%/plugins/time-router/events.jsonl` | 路由事件日志（`status.logFile: false` 时不存在），轮转文件为 `.1`、`.2`、`.3`。 |
| `%DSH_HOME%/plugins/time-router/keys/peak.key` | 面板保存的 peak 直连密钥。 |
| `%DSH_HOME%/plugins/time-router/keys/offPeak.key` | 同理，用于 offPeak 直连路由。 |
| `<apiKeyEnv 指定的变量>` | 例如 `OPENCODE_API_KEY`；只在对应路由为 direct 时读取。 |

## 完整示例

### 示例一：默认 OpenCode Go（peak 直连 + offPeak 委托）

与内置默认值等价，可作为起点：

```yaml
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
      apiKeyEnv: OPENCODE_API_KEY          # 或 apiKeyFile / 面板保存到 keys/peak.key
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
    virtual:
      provider: time-router
      models:
        chat: auto-chat
        reasoner: auto-reasoner
    fallback:
      enabled: true
      sameProviderRetry: 1
      quotaCooldownMinutes: 30
      authCooldownMinutes: 0
    holidays:
      online: true
      refreshDays: 7
    status:
      maxEvents: 200
      logFile: true
      rotateBytes: 5242880
      rotateFiles: 3
```

### 示例二：自定义直连 gateway（peak 直连 + offPeak 委托）

换成自建/第三方 OpenAI 兼容网关。注意显式覆盖从 peak 默认值继承来的模型名、上下文与输出上限：

```yaml
- id: time-router
  name: dsh-time-router
  config:
    peak:
      label: My gateway
      baseURL: https://gateway.example.com/v1
      apiKeyEnv: MY_GATEWAY_KEY
      headers:
        x-tenant: team-a
      models:
        chat: gw-chat-1
        reasoner: gw-reasoner-1
      contextWindow: 131072
      maxTokens: 16384
      inputModalities: ['text', 'image']
      reasoningEfforts: ['low', 'high']
      requestTimeoutMs: 120000
    offPeak:
      provider: deepseek-official
      models:
        chat: deepseek-flash
        reasoner: deepseek-v4-pro
    fallback:
      sameProviderRetry: 2
      quotaCooldownMinutes: 60
```

该例中虚拟模型公布的能力是两条路由的交集：`contextWindow` 取 131072 与 offPeak 路由上下文窗口的较小值，`maxTokens` 取两者较小值，输入模态取两条路由都支持的子集，推理档位取并集并在派发时裁剪。`inputModalities` 里的 `image` 不会让虚拟模型变成支持图片——只有两条路由都支持时才会。

### 示例三：两条路由全委托

两条真实路由都已由其他插件/行注册，插件只负责按时间改写 provider/model：

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
    fallback:
      enabled: true
      sameProviderRetry: 0
      quotaCooldownMinutes: 15
```

注意：

- 两个 `provider` 必须不同，否则加载告警且时间路由没有效果。
- 委托路由的 `models` 显式写出，避免继承到目标路由上不存在的模型 id。
- 委托路由的 `contextWindow` / `maxTokens` / `reasoningEfforts` 由目标路由自己的 adapter 决定，`virtual` 的能力交集通过 `llm.resolveModelInfo()` 解析获得；解析失败只会告警一次，虚拟模型退化为只广告两条路由共有的信息。

三个示例都可以叠加 `holidays.overrides` 做局部修正，例如：

```yaml
    holidays:
      overrides:
        '2026-12-31': holiday   # 公司自行放假
        '2027-01-02': workday   # 调休上班
```
