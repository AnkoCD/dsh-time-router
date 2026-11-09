# 贡献指南

感谢参与 `dsh-time-router`。这是一个零运行时依赖的 DeepSeek Harness 插件，代码量不大，但“路由不打断会话”“不重复投影”“不泄漏隐私”这几条语义比较硬，改动前请先读 [docs/DESIGN.md](docs/DESIGN.md)。

## 开发环境

- Node **≥ 22**（仓库 `engines` 要求，CI 用 Node 22）。
- **不需要安装任何依赖**：插件不 import `@deepseek-ai/*` 包，测试只用 `node:test` + `node:assert`。
- 编辑器遵循 [`.editorconfig`](.editorconfig)：UTF-8、LF、2 空格缩进。

```bash
git clone <repo-url> dsh-time-router
cd dsh-time-router
node --version   # 需要 v22+
```

```bash
# 跑全部测试（推荐逐文件，沙箱环境里 node --test test/ 可能不可用）
for f in test/*.test.js; do node "$f"; done

# 或
node --test test/*.test.js
node --test test/
```

当前基线是 **43 个测试全部通过**。CI（`.github/workflows/ci.yml`）在 Node 22 上做两件事：对每个 `test/*.test.js` 逐个执行，以及对每个 JS 文件执行 `node --check`。

本地加载插件（可选）：把仓库目录以 `link:` 方式装进某个 profile，再把默认模型指向 `time-router` / `auto-chat`，即可在 Harness 里手测：

```bash
dsh plugin --profile <profile> add C:\path\to\dsh-time-router
```

## 代码布局

| 路径 | 职责 | 约束 |
|---|---|---|
| `index.js` | Host 半：注册虚拟 provider、挂 `llm/stream`、注册命令与面板 API、启动节假日同步 | 只做装配，不做路由决策 |
| `client.js` | Client 半：composer dock 的 chip 与内联面板 | 只依赖 Harness 的 React 与 `/api/time-router/*`，不读其他插件的 DOM |
| `src/config.js` | 默认值、校验、direct/delegated 判定 | 非法值抛错，未知键告警；不在这里做 I/O |
| `src/schedule.js` | 当前时刻的纯函数判定与下次切换 | 不做 I/O、不读全局时间（`now` 可注入） |
| `src/holidays.js` | 内置/在线/缓存/覆盖的数据链 | 网络只在 `sync()` 里；路由路径永不等待网络 |
| `src/router.js` | 拦截、轮次分类、能力投影、回退状态机 | 不原地修改请求；首 token 后不改变路由 |
| `src/openai.js` | direct 路由的 SSE 客户端 | `never throws`：失败一律变成终止 chunk；密钥不落日志 |
| `src/adapter.js` | 虚拟 provider 的 `LlmAdapter` | `stream()` 只是防御路径 |
| `src/{locks,breakers,status,failure,time}.js` | 锁、熔断、状态、失败分类、时间换算 | 保持可注入 `now`，便于测试 |
| `data/holidays-YYYY.json` | 内置节假日数据 | 修改需同步 [docs/holiday-sources.md](docs/holiday-sources.md) 并说明来源 |
| `test/*.test.js` | 单元测试 | 测试文件即入口，直接 `node <file>` 可跑 |
| `docs/` | 配置参考、设计说明、故障排查、节假日来源 | 行为变更必须同步 |

## 代码不变量

改动任何模块时，请确认以下不变量仍然成立（review 时也会逐条看）：

1. **不原地改请求。** `options`、`options.messages` 及其中的消息对象都可能被 Harness 复用/冻结；需要变化时一律 spread 或 `map()` 出新对象。`retargetMessages()` 在无变化时必须返回原数组引用。
2. **首 token 不可逆。** 只有在第一个 chunk 被 yield 之前才允许重试或换路由；之后一律只透传，不再回退或重发。
3. **一次投影。** 路由决策必须留在 `llm/stream` waterfall 里完成，不要在虚拟 adapter 内再做一层会触发第二次能力投影的转发。
4. **每条路由都能承载本轮。** 交给目标路由的 `reasoningEffort` 必须是它支持的档位；虚拟模型广告的能力必须是两条路由的交集/并集规则（`mergeCapabilities`）。
5. **密钥不出边界。** 任何日志、状态快照、HTTP 响应、错误信息都不得包含密钥本体；只允许来源标记与存在性。
6. **事件不含内容。** 事件日志只记路由事实、失败事实、耗时、用量与哈希前缀；不得写入 prompt、补全、工具参数/结果、原始 session id。
7. **路由路径不做网络 I/O。** 节假日同步必须异步、失败降级，不阻塞 `llm/stream`。
8. **判定是纯函数。** `Scheduler.evaluate()` 只依赖时刻、配置与日历；不要引入隐藏状态（缓存、随机、环境变量）。
9. **错误可解释。** 吞掉错误时必须留下可诊断信息（回退通知、`notice`、日志 warn 或状态快照字段之一）。
10. **零运行时依赖。** 不新增 `dependencies`；不 import `@deepseek-ai/*` 包；只用 `node:` 内置模块与 `fetch`。
11. **回退只切一次。** `attemptedRoutes` 的语义是“本次请求已经尝试过的路由集合”，不要绕过它。
12. **跨窗口计费是刻意行为。** 不要为“避免高峰计价”而在轮次中途换路或打断流。

## 常见改动提示

- **新增配置字段**：`src/config.js` 的 `CONFIG_DEFAULTS` + 校验 + 文档（[docs/CONFIGURATION.md](docs/CONFIGURATION.md) 字段表与告警表），并补 `test/config.test.js`。
- **改变路由/回退语义**：同步更新 [docs/DESIGN.md](docs/DESIGN.md) 的“回退状态机”与 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) 对应条目，并补 `test/router.test.js`。
- **修改节假日数据**：保持 schema（`year`、`source`、`verifiedAt`、`holidays`、`makeupWorkdays`），升序去重、两个列表不相交，并在 [docs/holiday-sources.md](docs/holiday-sources.md) 记录来源与核验日期。
- **新增 UI 元素**：面板只通过 `/api/time-router/*` 拿数据；不要读其他插件 DOM；样式用 Harness 的 `--dsw-alias-*` token；文案同时加 `locale/en.json`、`locale/zh.json` 与 `client.js` 的内联兜底字典。
- **涉及用户可见行为**：更新 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 段。

## PR 检查清单

提交前逐项确认：

- [ ] `for f in test/*.test.js; do node "$f"; done` 全部通过（新增行为有对应测试）。
- [ ] `node --check` 覆盖到的 JS 文件无语法错误；没有遗留 `console.log` 调试输出。
- [ ] 没有修改与本次改动无关的文件；没有提交密钥、token、本机绝对路径或临时文件。
- [ ] 未新增运行时依赖；未 import `@deepseek-ai/*` 包。
- [ ] 不变量 1、2、5、6 已自查（不改请求、首 token 提交、密钥不出边界、事件不含内容）。
- [ ] 配置变更已同步 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)；行为变更已同步 README（中文与英文）、[docs/DESIGN.md](docs/DESIGN.md)、[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。
- [ ] `README.zh.md` 与 `README.md` 内容一致（中英镜像）。
- [ ] 在 PR 描述里写明：改了什么、为什么、如何验证（命令或步骤）、对用户可见的影响（路由/计价/隐私）。
- [ ] 如果改动会影响已安装用户（配置语义、默认值、事件字段），在 PR 描述里标注为需要注意的变更，并更新 CHANGELOG。

## 提交与评审

- 一个 PR 只做一件事；重构与行为变更分开提交。
- 提交信息用祈使句说明结果，例如 `fix: keep the turn lock on auxiliary requests`。
- 评审关注点排序：正确性（路由/回退/隐私）> 可解释性（通知与日志）> 可测试性 > 风格。
- 文档与代码在同一个 PR 里更新；`docs/holiday-sources.md` 只由了解数据来源的人修改。
