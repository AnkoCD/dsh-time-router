# 故障排查

本文按现象组织。每条给出：可能原因、如何确认、如何处理。配置字段的完整含义见 [CONFIGURATION.md](CONFIGURATION.md)，路由与回退的实现见 [DESIGN.md](DESIGN.md)。

## 目录

- [1. 直连路由报 MISSING_CREDENTIAL](#1-直连路由报-missing_credential)
- [2. 401 / 403 与认证熔断](#2-401--403-与认证熔断)
- [3. 配额错误（402 / 429）与冷却](#3-配额错误402--429与冷却)
- [4. 看到回退通知 / 回退没有发生](#4-看到回退通知--回退没有发生)
- [5. 时间判定与预期不符](#5-时间判定与预期不符)
- [6. 节假日数据缺失或陈旧](#6-节假日数据缺失或陈旧)
- [7. 模型选择器里找不到 auto-chat](#7-模型选择器里找不到-auto-chat)
- [8. 插件似乎没生效](#8-插件似乎没生效)
- [9. 面板请求 401 / 面板不更新](#9-面板请求-401--面板不更新)
- [10. 日志与诊断信息在哪里](#10-日志与诊断信息在哪里)
- [11. 其他常见告警](#11-其他常见告警)

## 1. 直连路由报 MISSING_CREDENTIAL

**现象**：首 token 之前就收到错误，`failure.code` 为 `MISSING_CREDENTIAL`，随后本轮切到另一条路由；该直连路由进入认证熔断（`/time-router` 状态里显示 `— cooling down`）。

**原因**：直连路由找不到任何可用的密钥。密钥解析顺序（`src/openai.js`）：

1. `peak.apiKey`（配置内联，不推荐）
2. 环境变量 `peak.apiKeyEnv`（默认 `OPENCODE_API_KEY`）
3. `peak.apiKeyFile` 指向的文件
4. `%DSH_HOME%/plugins/time-router/keys/peak.key`

**确认**：

```text
/time-router            # 看 Peak/Off-peak 行是否 cooling down
```

或看状态接口里 `routes.peak.key`：`{present, source, hint}`。`present: false` 表示四个来源都没读到。

**处理**：

- 设置环境变量后**重启** Harness（进程环境变量在启动时读取；密钥文件读取有 30 秒缓存）。
- 或把密钥写进文件：`%DSH_HOME%/plugins/time-router/keys/peak.key`（纯文本，不要带引号）。
- 或在面板里粘贴密钥点“保存密钥”（仅当 peak 是 direct 路由时显示）。
- 注意 `apiKeyFile` 里的 `~` 展开到 **DSH_HOME**（不是用户主目录）；要写 `{dshHome}/keys/my.key` 也可以。
- 修好后执行 `/time-router reset` 清掉认证熔断，否则下一轮仍会跳过该路由。

## 2. 401 / 403 与认证熔断

**现象**：错误信息含 `HTTP 401` / `HTTP 403` 或 `AUTH`，路线进入 `auth` 熔断。默认配置（`authCooldownMinutes: 0`）下**它不会自动恢复**。

**原因**：密钥无效、被吊销、额度账户未授权、代理改写了 `Authorization` 头，或者配置里 `headers.authorization` 与解析出的密钥冲突（插件在已设置 `authorization` 时会忽略 `headers` 里的同名头，所以更可能是密钥本身或环境变量没生效）。

**确认**：`/time-router probe` 会报告本轮路由与失败信息；状态快照的 `breakers[]` 里能看到 `kind: auth`、`since`、`until: null`。

**处理**：

1. 修正密钥（环境变量/文件/面板）。
2. `/time-router reset`（或面板“重置冷却”，或 `POST /api/time-router/state {"resetBreakers": true}`）。
3. 如果确实想让认证失败在一段时间后自动重试，设 `fallback.authCooldownMinutes`（1–1440）。

## 3. 配额错误（402 / 429）与冷却

**现象**：`HTTP 402`、或 429 且响应体含 `quota` / `balance` / `credit` / `usage limit`；路线进入 `quota` 熔断。配额熔断的恢复时间优先取响应的 `Retry-After`，否则用 `fallback.quotaCooldownMinutes`（默认 30 分钟）。

**确认**：状态快照 `routes.<route>.breaker` 的 `kind: quota`、`until` 即恢复时刻（ISO 时间）；`/time-router` 状态行显示 `cooling down (QUOTA)`。

**处理**：

- 充值/等待配额恢复；冷却结束后自动恢复使用（`Breakers.check()` 到期即删除）。
- 想缩短/延长冷却：调 `fallback.quotaCooldownMinutes`（注意 `Retry-After` 优先，某些 429 会给出很长的时间）。
- 需要立刻重试用该路由：`/time-router reset`。
- 若 429 并非配额语义（普通限流），插件会先在同一路由重试（`fallback.sameProviderRetry`，无 `Retry-After` 或 ≤ 5 秒时），再切另一条路由。

## 4. 看到回退通知 / 回退没有发生

**现象**：出现类似下面的通知：

```text
OpenCode Go reported exhausted quota (429); this turn switched to deepseek-official —
this turn is billed at peak pricing; OpenCode Go cools down until 2026-11-09T04:30:00.000Z.
```

**含义**：首 token 之前，计划路由失败且失败类别允许回退（认证、配额、限流、服务端/传输类），于是本轮改走另一条路由；本轮锁也被改写，后续工具循环继续走回退后的路由。通知同时会出现在：

- `/time-router` 状态输出的末尾（最近 3 条）；
- Harness 日志（warn）；
- `GET /api/time-router/status` 的 `notices` 字段；
- 面板事件行的 `↩ fallback` 标记（回退轮次）与 `↑ billed at peak price` 标记（跨入高峰窗口的轮次）。

**为什么没有回退**（以下情况是设计如此）：

| 情况 | 行为 |
|---|---|
| 已经产出第一个 chunk 之后出错 | 本轮提交，不回退、不重发 |
| 上下文超限（`CONTEXT_WINDOW_EXCEEDED`） | 不重试、不回退，直接报错（换路由不会让请求变短） |
| 调用方主动中止 | 直接结束 |
| `fallback.enabled: false` | 不重试、不跨路由回退，也不记录新熔断 |
| 另一条路由的熔断也已打开 | 直接返回错误 |
| 本次请求已经切过一次路由 | 不再切第二次 |

想确认“到底发生了什么”，看事件日志里该轮次的 `fallback`、`failure` 与 `outcome` 字段（见 [第 10 节](#10-日志与诊断信息在哪里)）。

## 5. 时间判定与预期不符

按以下顺序检查：

1. **时区**：`timezone` 必须是 IANA 名（默认 `Asia/Shanghai`）。判定不依赖本机时区；面板与命令显示的是配置时区的墙上时间。
2. **窗口是半开的**：`09:00` 算高峰，`12:00` 不算；`14:00` 算，`18:00` 不算。`09:00–12:00` 与 `14:00–18:00` 之间是午休（offPeak）。
3. **手动覆盖**：`manual.mode` 不是 `auto` 时优先于时间判定，而且优先级**高于** `enabled: false`。看状态输出的 `(manual peak)` / `(manual offPeak)` 后缀，或状态快照的 `now.manual`。
4. **是否被停用**：`enabled: false` 时固定走 offPeak，原因 `disabled`，`Next switch: pinned`。
5. **节假日数据**：法定节假日全天 offPeak；调休补班日按工作日处理。若日期判断与日历不符，见第 6 节。
6. **`debug.fakeNow` 是否被设置**：状态输出末尾会出现 `⚠ Debug fakeNow is active`。开发/演示后记得清空。
7. **本机时钟偏差**：路由判定用本机时钟。状态快照的 `clockSkewMs` 是插件抓取节假日在线数据时，用响应头 `Date` 与本机时间推算出的偏差（仅提示，不用于修正判定）。如果本机时间本身是错的，一切判定都会跟着错。
8. **插件刚重载**：锁是内存态，重载后下一轮按当时时间重新判定，可能与上一轮不同（这是唯一被接受的中途换路）。

自检：

```text
/time-router            # Now / Route / Next switch 三行就是判定结果
/time-router probe      # 发一条最小请求，报告实际走的路由与原因
```

## 6. 节假日数据缺失或陈旧

**现象**：面板出现黄色/红色告警；某天本该放假却按工作日处理，或反之；跨年后 1 月仍按“仅周一至周五”判断。

**确认**：

- 状态接口的 `calendar` 字段：`years`、`currentYearCovered`、`nextYearCovered`、`fetchedAt`、`lastError`、`warnings`。
- 缓存文件 `%DSH_HOME%/plugins/time-router/holidays.cache.json`：`fetchedAt` 是抓取时间戳，`fetchedYears` 记录各年抓到的天数。
- 内置数据 `data/holidays-2025.json`、`holidays-2026.json`、`holidays-2027.json`。

**处理**：

- `/time-router sync` 立即同步（面板“同步节假日”等价）。
- 检查 `holidays.online` 是否为 `true`，以及网络能否访问 `cdn.jsdelivr.net` / `fastly.jsdelivr.net`；`raw.githubusercontent.com` 在部分网络不可直连（它是第三顺位源，前两个失败才会用到）。
- 在线源按顺序尝试：jsDelivr → Fastly → GitHub raw → `timor.tech`（限流 10000 次/IP/24h，返回 429 时会被跳过）。
- `timor.tech` 尚无 2027 数据；在线返回空对象**不等于**“全年无休”，内置数据仍会生效。
- 官方通常在每年 11 月公布下一年安排；11 月起若下一年无数据会给出告警。以 2026-11-09 核验时点为准，2028 年尚未公布。
- 只想单独修正某几天，用 `holidays.overrides`（`holiday` 表示休息日，`workday` 表示工作日），它优先级最高。
- 内置数据字段说明与核验记录见 [holiday-sources.md](holiday-sources.md)。

## 7. 模型选择器里找不到 auto-chat

**现象**：Settings → Models 里没有 `time-router` / `auto-chat`，或默认模型指向它但无法选择。

**原因与处理**：

1. **bundle 没装上**：确认 profile 的依赖里有 `dsh-time-router`（`link:` 或已安装版本），且 bundle 列表包含它。
2. **插件行被停用**：确认 `id: time-router` 的行处于启用状态（`disabled` 不为真）。
3. **加载报错**：配置校验失败时插件**不会加载**（不是回退到默认值），错误会被记录。逐项对照 [CONFIGURATION.md 的校验错误表](CONFIGURATION.md#校验错误与告警)。
4. **改名后没同步默认模型**：如果自定义了 `virtual.provider` / `virtual.models`，默认模型必须改用新的 id；旧 id 指向不存在的路由，模型选择会失败。
5. **插件重载中**：面板修改 `enabled` / `manual` 会触发重启，短暂窗口内虚拟路由不可用。
6. **验证注册成功**：Harness 日志里应有 `time-router: virtual provider "time-router" ready; peak → ..., off-peak → ...`。

## 8. 插件似乎没生效

**现象**：路由判定、面板、命令都存在，但请求从不经过路由器；事件日志没有新行。

**最常见原因**：Harness 的默认模型没有指向 `time-router` / `auto-chat`，所以请求走的是真实路由，插件处于空闲状态。两种改法：Settings → Models，或 profile patch：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: time-router
    model: auto-chat
    reasoningEffort: high
```

其他可能：

- 会话里手动选了别的 provider/model（会话级选择优先于默认模型）。
- 插件行 `enabled: false`（注意这是**路由停用**，固定走 offPeak，虚拟路由仍然工作；插件行本身的启用状态是另一件事）。
- 改动配置后没有重新加载：手工改 patch 后需要让 Harness 重新加载该行（面板的快捷操作会自动重启插件）。

确认请求确实过了路由器——事件日志出现新的行，或 `/time-router` 的 “Today:” 用量增长。

## 9. 面板请求 401 / 面板不更新

**现象**：面板显示错误 `Update failed`；直接访问 `GET /api/time-router/status` 得到 `401 not authorized`。

**原因**：这两个 HTTP 路由只在 profile 同时提供 `webServer` 与 `connection` 服务时注册，并且每个请求都先经过 Harness 的 `connection.requestRejection()`（Host/Origin 与浏览器认证）。从浏览器会话之外直接请求 API URL、跨源访问、或在没有 connection 服务的环境里用浏览器打开，都会 401。**这是预期行为，不是插件 bug。**

**处理**：

- 在 Harness 页面内使用面板与命令；不要直接把 API URL 贴到浏览器地址栏。
- 确认 profile 有 web server：没有 web server 的 profile 会跳过整段面板 API，插件其余功能（路由、命令、事件日志）不受影响。
- 面板每 15 秒轮询一次；配置变更后面板等待约 500 ms 再刷新，可能短暂显示旧状态，等一轮即可。
- 若面板一直报错而 `/time-router` 命令正常：说明 API 未注册或连接检查失败，看 Harness 日志里是否有面板路由注册相关的错误。

## 10. 日志与诊断信息在哪里

| 位置 | 内容 |
|---|---|
| `/time-router` | 当前时刻、路由与原因、下次切换、两条路由与冷却状态、今日用量、日历告警、最近 3 条回退通知、`fakeNow` 状态（零 token） |
| `/time-router probe` | 发一条 16 token 的最小请求，报告实际路由、原因与模型回复（会消耗极少量 token） |
| `GET /api/time-router/status` | 完整快照：`plugin`、`now`、`calendar`、`routes`、`breakers`、`notices`、`events`、`usage`、`configWarnings`、`clockSkewMs`、`cacheFiles`（不返回密钥） |
| `%DSH_HOME%/plugins/time-router/events.jsonl` | 路由事件日志（JSONL，5 MB × 3 轮转）；`status.logFile: false` 时不存在 |
| `%DSH_HOME%/plugins/time-router/holidays.cache.json` | 节假日缓存与抓取时间 |
| `%DSH_HOME%/plugins/time-router/keys/` | 面板保存的密钥（`peak.key` / `offPeak.key`） |
| Harness 日志 | 插件通过 `ctx.logger` 输出的 info/warn：虚拟 provider 注册、节假日同步、回退通知、能力解析失败 |

`%DSH_HOME%` 默认是 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`），可用环境变量覆盖。

常用诊断命令（PowerShell）：

```powershell
# 最近的 5 条路由事件
Get-Content "$env:DSH_HOME\plugins\time-router\events.jsonl" -Tail 5
# 节假日缓存摘要
Get-Content "$env:DSH_HOME\plugins\time-router\holidays.cache.json" -TotalCount 8
# 密钥是否存在（只列文件，不打印内容）
Get-ChildItem "$env:DSH_HOME\plugins\time-router\keys" | Select-Object Name, Length
```

## 11. 其他常见告警

**`unknown configuration key "..."`**
配置里有插件不认识的键（拼写错误、或把 direct 字段写在了 delegated 路由里）。不影响加载，但该键被忽略。常见来源：把 offPeak 改成直连后，内置默认值里的 `offPeak.provider` 会留下一条无害告警。

**`peakWindows[i] ... overlap; the union is used`**
窗口重叠。判定按并集生效，一般无需处理；想消除告警就改成不重叠的区间。

**`peak.provider and offPeak.provider name the same route; time routing has no effect until they differ`**
两条委托路由指向同一个 provider，切换没有效果。改成不同路由或改用 direct。

**`virtual.models.chat and virtual.models.reasoner are identical`**
两个虚拟模型 id 相同，一个就够了。

**`peak.apiKey stores a secret in the profile patch; prefer apiKeyEnv or a key file`**
密钥被内联进配置。建议改用环境变量或密钥文件，或让面板保存。

**`peak has no key source; until one is configured this route fails with MISSING_CREDENTIAL and turns fall back`**
`apiKey` / `apiKeyEnv` / `apiKeyFile` 全为空。补一个密钥来源（第 1 节）。

**`No holiday data for <year>; only Monday–Friday is treated as a workday`**
该年完全没有数据（内置缺失且在线失败）。执行 `/time-router sync`，或用 `holidays.overrides` 手工修正关键日期。

**`Holiday sync failed: ...`**
在线同步失败，路由仍使用内置/缓存数据。检查网络能否访问 jsDelivr/Fastly/GitHub raw/timor.tech；插件自身不处理代理设置（如需代理，请在运行 Harness 的 Node 环境中配置，或把 `holidays.sources` 换成可达的镜像 URL）；该告警在下次同步成功前保留。

**上下文超限错误没有被回退掩盖**
这是设计行为：`CONTEXT_WINDOW_EXCEEDED` 不重试也不换路由。处理方式是缩短会话/压缩历史，或换一个上下文窗口更大的模型档位（虚拟模型广告的是两条路由的**较小**上下文窗口）。
