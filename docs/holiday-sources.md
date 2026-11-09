# 节假日数据来源与说明

本文档说明 `dsh-time-router` 内置的节假日数据文件、运行时可选在线数据源、回退链和核验记录。

- 核验日期：**2026-11-09**（Asia/Shanghai）
- 数据文件：[holidays-2025.json](../data/holidays-2025.json)、[holidays-2026.json](../data/holidays-2026.json)

## 1. 数据文件 schema 与语义

```json
{
  "year": 2025,
  "source": ["https://...", "https://..."],
  "verifiedAt": "2026-11-09",
  "holidays": ["2025-01-01", "..."],
  "makeupWorkdays": ["2025-01-26", "..."]
}
```

- `year`：数据所属自然年。
- `source`：数据出处 URL（官方通知 + 至少一个第三方交叉源）。
- `verifiedAt`：人工核验日期，格式 `YYYY-MM-DD`。
- `holidays`：**该年国务院通知中"放假"的全部日历日**。按"完整官方放假区间"列出，**包含落在周六/周日的日期**（例如 2025 春节区间内的 2025-02-01/02 是周六周日，仍然列入），也包含通知写明"调休放假 N 天"的整个 N 天区间。若两个节日合并放假（如 2025 国庆+中秋 8 天），按通知给出的完整区间逐日列出。
- `makeupWorkdays`：**通知中写明的"上班/调休上班/补班"日期**，通常是被挪用的周六或周日。这些日期虽然是周末，但按工作日处理。
- 所有日期为 `Asia/Shanghai` 本地日历日，格式 `YYYY-MM-DD`；两个列表均**升序、去重**，且互不重叠。

**路由上的用法**（与项目计划 Q6 一致）：

- 某天是 `holidays` → 休息日，全天走非高峰 provider。
- 某天是 `makeupWorkdays` → **工作日**（补班日算高峰日，按 `peakWindows` 正常判断）。
- 其余日期 → 周一至周五为工作日，周六周日为休息日。

**规模**：2025 年 28 个放假日 + 5 个补班日；2026 年 33 个放假日 + 6 个补班日；2027 年 29 个放假日 + 5 个补班日。

## 2. 官方依据

自 2025-01-01 起施行 2024-11 修订的《全国年节及纪念日放假办法》，全体公民放假的节日共 13 天（元旦 1、春节 4、清明 1、劳动 2、端午 1、中秋 1、国庆 3），比修订前增加 2 天（春节、劳动节各 +1）。

| 年份 | 文号 | 成文日期 | 官方 URL |
|---|---|---|---|
| 2025 | 国办发明电〔2024〕12号 | 2024-11-12 | <https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm>（政策文件库）<br><https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html>（国务院公报） |
| 2026 | 国办发明电〔2025〕7号 | 2025-11-04 | <https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>（政策文件库）<br><https://www.gov.cn/zhengce/content/202511/content_7047090.htm>（政策页） |
| 2027 | 国办发明电〔2026〕10号 | 2026-11-05 | <https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm><br><https://www.gov.cn/zhengce/content/202611/content_7085101.htm> |

> 2027 年数据**已经公布**，见第 6 节。项目计划里"2027 年安排尚未公布"的前提已过时。

## 3. 运行时在线源

### 3.1 NateScarlet/holiday-cn（首选）

- 仓库：<https://github.com/NateScarlet/holiday-cn>　许可：**MIT**（可商用，保留版权声明）。数据由 CI 每日抓取国务院公告生成。
- 单年 JSON 地址（二选一，`{YYYY}` 为四位年份）：
  - GitHub raw：`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{YYYY}.json`
  - jsDelivr：`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{YYYY}.json`
  - jsDelivr Fastly 备用：`https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{YYYY}.json`
  - ghproxy 形式（需自备代理服务）：`https://{ghproxy}/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{YYYY}.json`
- JSON 形状（实际字段，2025/2026 均已在 2026-11-09 抓取核对）：

```json
{
  "$schema": "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/schema.json",
  "$id": "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json",
  "year": 2026,
  "papers": ["https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm"],
  "days": [
    { "name": "元旦", "date": "2026-01-01", "isOffDay": true },
    { "name": "元旦", "date": "2026-01-04", "isOffDay": false }
  ]
}
```

  - `year`：整数年份；`papers`：所用国务院文件 URL 列表；`days[]`：`name`（节日名）、`date`（ISO 8601 `YYYY-MM-DD`）、`isOffDay`（`true`=放假，`false`=补班）。
  - 解析时只需 `year` + `days`；`$schema`/`$id`/`papers` 可忽略。
  - **`days` 只包含通知点名的日期**（放假区间内每一天 + 补班日），不包含"与周末连休"但未被点名的相邻周末；对本项目 `holidays` 语义正好对齐（通知区间逐日展开）。
- 注意事项：
  - **年份按国务院文件标题年份而非日期年份**，12 月附近的日期可能被下一年文件覆盖，**应同时检查 `{YYYY}.json` 和 `{YYYY+1}.json`**。
  - 内容随官方公告变化，缓存在客户端要有 TTL 或 ETag/`Last-Modified` 校验。
  - `raw.githubusercontent.com` 在中国大陆常不可直连；本机核验时该域名 `fetch failed`，而 jsDelivr/Fastly 镜像返回 200 且内容一致，故运行时优先用镜像。
  - jsDelivr `@master` 有 CDN 缓存（通常数小时），公告刚更新时可能短暂滞后。
  - 尚未发布 2028 年文件（按惯例次年 11 月才发布），请求 2028 会 404。

**已核验的具体地址（HTTP 200，2026-11-09）**：

- `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2025.json`
- `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json`
- `https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json`
- `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2027.json`（2027 数据已就绪，与官方通知逐日一致）

### 3.2 timor.tech（备选）

- 单年接口：`https://timor.tech/api/holiday/year/{YYYY}`（官方文档建议年份后加斜杠：`https://timor.tech/api/holiday/year/2026/`；不加斜杠同样可用）
- 响应形状（`{MM-DD}` 为键，`date` 字段给出完整日期）：

```json
{
  "code": 0,
  "holiday": {
    "01-01": { "holiday": true, "name": "元旦", "wage": 3, "date": "2026-01-01", "rest": 50 },
    "01-04": { "holiday": false, "name": "元旦后补班", "wage": 1, "after": true, "target": "元旦", "date": "2026-01-04", "rest": 1 }
  }
}
```

  - `code`：`0` 正常，`-1` 出错。
  - `holiday[].holiday`：`true`=放假，`false`=**补班**；`name` 中文名；`wage` 工资倍数；`date` 完整日期（**以 `date` 字段为准，不要用 `MM-DD` 键拼年份**）；`rest` 距该日天数。
  - 仅补班项有 `after`（`true`=假期后补班，`false`=节前补班）和 `target`（所属节日）。
  - 只返回通知点名的节日/补班日期，不返回普通周末；未配置的年份返回 `{"code":0,"holiday":{}}`。
- 限额与许可：
  - 免费、无需登录；**限额 10000 次/IP/24 小时**（窗口 24h 重置），超限返回 **HTTP 429**；此前受 CC 攻击、已接入 CDN，命中缓存不重复计数。
  - 站点作品采用 **CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享）**，**商业用途受限**，开源项目分发时需注意或改用 holiday-cn 数据。
  - 维护者曾多次修正历史数据（如 2025-09-07 修复 2025 劳动节、2024-11-26 修复 2025-02-08），消费方应做基本校验而不是无条件信任。
- 已知滞后：**2027 年数据尚未更新**，2026-11-09 请求 `https://timor.tech/api/holiday/year/2027` 返回 `{"code":0,"holiday":{}}`（其 changelog 最新为 2025-11-17 更新 2026 数据）。因此 2027 及以后不能依赖 timor。

## 4. 回退链建议

优先级：**手动覆盖 > 本地内置 JSON > 在线源（holiday-cn → timor）> 本地缓存 > 仅按周一到周五**

1. 内置数据（`data/holidays-YYYY.json`，本目录这两份）永远可用、零延迟；跨年且下一年内置缺失时，从 11 月 1 日起每日尝试在线补。
2. 在线拉取顺序：holiday-cn raw → jsDelivr → Fastly 镜像 →（可选）ghproxy → timor.tech。任一成功即止，单源超时 3–5 s，整体不超过 ~10 s，失败不阻塞请求。
3. 成功结果写入缓存（`%USERPROFILE%\.dsh\plugins\time-router\holidays.cache.json`，先写临时文件再 rename），断网时使用缓存；缓存需记录来源、抓取时间，超期（如 7 天）降级为"陈旧可用 + 面板警告"。
4. 校验在线结果：`year` 匹配、日期格式合法、升序去重、`date` 落在该年、补班日应为周六/周日；不合法则视为该源失败，继续下一个源。
5. 同时检查 `{YYYY}.json` 与 `{YYYY+1}.json`（holiday-cn 的年份归属规则），合并时以命中该日所在年份的文件为准。
6. 三个源都拿不到且内置缺该年数据时，退化为"只按周一至周五判断"，面板显示红色警告（计划 §3.4）。
7. 遵守 `HTTPS_PROXY`；hitting GitHub/jsDelivr 在国内可能需要代理。

## 5. 核验记录（2026-11-09）

三源逐日比对，**2025、2026 完全一致，无冲突**：

| 年份 | 来源 | 放假日数 | 补班日数 | 结论 |
|---|---|---|---|---|
| 2025 | gov.cn 政策文件库 / 国务院公报 | 28 | 5 | 基准 |
| 2025 | timor.tech `/year/2025` | 28 | 5 | 一致 |
| 2025 | holiday-cn `2025.json` | 28 | 5 | 一致（`name` 用"国庆节、中秋节"） |
| 2026 | gov.cn 政策文件库 / 政策页 | 33 | 6 | 基准 |
| 2026 | timor.tech `/year/2026` | 33 | 6 | 一致 |
| 2026 | holiday-cn `2026.json` | 33 | 6 | 一致 |

- 逐日明细（官方原文）：
  - 2025：元旦 1/1（1 天，不调休）；春节 1/28–2/4（8 天），补班 1/26、2/8；清明 4/4–6；劳动节 5/1–5，补班 4/27；端午 5/31–6/2；国庆+中秋 10/1–8（8 天），补班 9/28、10/11。
  - 2026：元旦 1/1–3，补班 1/4；春节 2/15–23（9 天），补班 2/14、2/28；清明 4/4–6；劳动节 5/1–5，补班 5/9；端午 6/19–21；中秋 9/25–27；国庆 10/1–7，补班 9/20、10/10。
- 全部补班日经校验均为周六或周日；放假列表与补班列表无交集；日期均升序去重。
- **无"仅有单一来源"的可疑日期**；2025/2026 的每一天都同时有官方通知与两个独立第三方源支持。
- 仅有的差异是**文本归属/标签**，不影响日期：
  - 2026-09-20：官方通知把它写在"国庆节"段落；holiday-cn 记为 `国庆节`；timor 记为"中秋节前补班"。三者的"是否上班"结论一致（补班）。
  - 2025-10-06 中秋节落在国庆假期内：timor 标 `中秋节`，其余标 `国庆节、中秋节`；日期与放假属性一致。

## 6. 2027 年与更新状态（重要）

- **2027 年放假安排已公布**：国办发明电〔2026〕10号，2026-11-05 发布（<https://www.gov.cn/zhengce/content/202611/content_7085101.htm>）。因此"2027 数据尚未公布"的旧前提**已失效**。
- 2027 官方安排：元旦 1/1–3（3 天，不调休）；春节 2/5–13（9 天），补班 1/31、2/14；清明 4/3–5；劳动节 5/1–5，补班 5/8；端午 6/9（周三，1 天）；中秋 9/15（周三，1 天）；国庆 10/1–7，补班 9/26、10/9。
- `NateScarlet/holiday-cn` 已有 `2027.json`，内容与官方一致（已抓取核对）；`timor.tech` 尚无 2027 数据。
- **2028 年安排尚未公布**（按惯例 2027 年 11 月发布）。2026-11-09 实测：holiday-cn `2028.json` 返回 **404**，timor `/year/2028` 返回 `{"code":0,"holiday":{}}`。因此跨年逻辑应面向"下一年数据缺失"的一般情况，而不是写死某个年份。
- 建议：本轮已补一份 2027 内置数据（见 §7），并把计划 §3.4 的年份假设改为"每年 11 月起探测下一年数据"。

## 7. 2027 内置数据（新增）

- 已新增 [holidays-2027.json](../data/holidays-2027.json)：**29 个放假日 + 5 个补班日**，schema 与 2025/2026 完全一致，`verifiedAt` = 2026-11-09。
- 依据：国办发明电〔2026〕10号（2026-11-05，<https://www.gov.cn/zhengce/zhengceku/202611/content_7085102.htm>）；交叉源 `NateScarlet/holiday-cn` 的 `2027.json`（<https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2027.json>，HTTP 200）。两源逐日一致，**无冲突、无单源日期**；timor.tech 尚无 2027 数据，故未作为该年来源。
- 核对时另用日历复核了通知中每一天的星期，全部吻合（1/1 周五、2/5 周五、2/13 周六、1/31 周日、2/14 周日、4/3 周六、4/5 周一、5/1 周六、5/5 周三、5/8 周六、6/9 周三、9/15 周三、10/1 周五、10/7 周四、9/26 周日、10/9 周六）。
- 2027 结构特征：春节 9 天（除夕 2/5 起，节前 1/31、节后 2/14 补班）；元旦 3 天且不调休；清明 3 天、劳动节 5 天、国庆 7 天均为含补班的连休；端午 6/9 与中秋 9/15 都逢周三，按规则只放 1 天且不调休。放假日数为 29，与 2025（28）、2026（33）不同，**不要假设每年放假日数固定**。
- **2028 年安排截至 2026-11-09 仍未公布**：holiday-cn `2028.json` = HTTP 404，timor `/year/2028` = 空对象。
- 插件行为建议：2027 应与 2025/2026 一样作为"已确认年份"处理——优先用内置数据，在线源仅用于校验/覆盖；**注意 timor 目前对 2027 返回空对象，不能把空结果当作"全年无休"**。同时保留每年 11 月 1 日起探测下一年（当前为 2028）数据的逻辑，12 月 1 日后仍缺数据时黄色警告，彻底缺数据时退化为仅按周一到周五判断并红色警告。

