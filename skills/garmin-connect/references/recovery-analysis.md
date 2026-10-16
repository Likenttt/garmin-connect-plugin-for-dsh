# 恢复、HRV 与训练数据

用于 HRV、压力、Body Battery、训练准备度、训练负荷、VO₂ max 和比赛预测查询。
先按问题选取数据；简单的 HRV 查询不需要获取整套恢复指标或收集完整训练计划信息。

## 确认当前能力与账号

检查当前会话实际暴露的工具与 schema；客户端支持时用 MCP `tools/list` 发现。
以下是维护版插件新增的能力，不表示 npm 上任意旧版插件都具备这些工具。独立
SDK 已发布，插件升级、MCP 重载与 skill 文件更新分别影响各自的能力。

- DSH：单账号可省略 `account`，多账号使用设置页显示的稳定账号 ID；别名用于
  查找对应 ID。多个账号可以在同一区域，不按 `cn` / `global` 区分身份。
- MCP：选择已配置目标账号的 MCP 服务，不传 `account` 或 `displayName`。
- 后续所有查询保持同一账号。用户指定比较不同账号时，分别查询并清楚标注。

先将相对日期换算为用户账号或本地日历时区的明确日期，再显式传入参数。宿主
默认的“今天”可能与用户所在时区不同。以返回的 `calendarDate`、时间戳和偏移
核对归属，不擅自把夜间记录平移到前一天。

## 按问题选工具

| 问题 | 工具 | 参数与用途 |
| --- | --- | --- |
| 某晚 HRV、个人基线、夜间曲线 | `get_garmin_hrv` | `date`；摘要及可用的全部夜间读数 |
| 最近一周或数周 HRV 趋势 | `get_garmin_hrv_summaries` | `startDate`、`endDate`；每日摘要，无夜间曲线 |
| 某天压力变化 | `get_garmin_stress` | `date`；全天压力及可用的 Body Battery 时序 |
| 一段时间压力变化 | `get_garmin_stress_summaries` | `startDate`、`endDate`；每日摘要 |
| Body Battery 充电、消耗与曲线 | `get_garmin_body_battery` | `startDate`、`endDate`；每日报告 |
| 今天的训练准备情况 | `get_garmin_training_readiness` | `date`；准备度快照及可用恢复因素 |
| 某天训练状态、急慢性负荷 | `get_garmin_daily_training_status` | `date`；返回设备映射与负荷 |
| 聚合训练状态 | `get_garmin_training_status` | `date`；按实际返回字段分析 |
| 截至某日的四周负荷平衡 | `get_garmin_training_load_balance` | `date`；有氧/无氧负荷及目标范围 |
| 单日 Max Metrics / VO₂ max | `get_garmin_max_metrics` | `date`；按实际返回的项目和单位分析 |
| 一段时间 Max Metrics | `get_garmin_max_metrics_range` | `startDate`、`endDate` |
| 当前比赛预测 | `get_garmin_race_predictions` | `{}`；当前认证账号最新预测，无日期参数 |
| 比赛预测历史 | `get_garmin_race_predictions_range` | `startDate`、`endDate`、`aggregation` |

参数规则：

- 日期为真实的 `YYYY-MM-DD`。单日工具使用 `date`，范围工具使用
  `startDate` / `endDate`，不要混用。
- 单日日期与范围起点默认宿主本地今天；终点默认等于起点。范围包含首尾。
- 比赛预测历史 `aggregation` 为 `daily`（默认）或 `monthly`，首尾日期差
  不得超过 366 天。其他新增范围工具没有代码层面的 30 天上限。
- 以当前工具 schema 为准传参，不给这些工具添加 `detail`、`limit` 或保存路径。
  它们返回完整数据；按问题输出摘要，不把全部原始时序塞进回复。

## 常见查询流程

以下日期是参数示例，实际调用替换为用户所需日期；DSH 多账号再加稳定 `account`。

### “最近一周 HRV 怎么样？”

先调用 `get_garmin_hrv_summaries`：

```json
{"startDate":"2026-10-09","endDate":"2026-10-15"}
```

报告实际有记录的日期、缺失日期、夜间均值、Garmin 的七日均值、基线与状态中
实际存在的项目。需要核对某晚偏离或用户要求夜间曲线时，再调用 `get_garmin_hrv`：

```json
{"date":"2026-10-15"}
```

HRV 摘要里的 `weeklyAvg` 是 Garmin 返回的七日均值，`lastNightAvg` 是单晚均值，
`lastNight5MinHigh` 是最高五分钟值，不能互相替代。自己计算所选日期的均值时
另行标注样本数和缺失日，不把它命名为 Garmin 七日均值。

优先对照同一人的 `baseline.balancedLow` / `balancedUpper` 和状态。Garmin 的
HRV 状态比较七日均值与个人基线；超出基线可能向上，也可能向下。新用户可能
尚未积累建立状态所需的连续睡眠记录，不能因没有状态就判为恢复差。
依据：[Garmin HRV 状态说明](https://www8.garmin.com/manuals/webhelp/GUID-AC520B63-3C82-4266-90F6-6E9F22D5F76E/EN-US/GUID-9282196F-D969-404D-B678-F48A13D8D0CB.html)。

### “今天适合跑间歇吗？”

先明确目标日期与账号，读取当天 `get_garmin_training_readiness`，再按需要补充
最近完整睡眠日的 `get_garmin_sleep` 和 `get_garmin_activities`。需要看恢复变化
时查 HRV 摘要；需要解释压力、充电或负荷因素时再查对应工具。不要为每次提问
固定拉取全部 13 个接口。

准备度会随时间变化，并综合睡眠、恢复时间、HRV、急性负荷和近期睡眠/压力。
因此区分起床时、运动前、运动后的快照，说明所选时间和设备；不能把旧快照
称为“现在”的准备度。依据：[Garmin 训练准备度说明](https://www8.garmin.com/manuals/webhelp/GUID-31D23DBB-57C2-4DF7-A0C9-8D1A00AB4BE7/EN-GB/GUID-C21BE0C8-A08E-4DA1-B6C6-2E0E2DDDB372.html)。

区分直接观察和训练建议，不用单次 HRV 或单个分数自动决定强度。若需要个性化
制定或调整训练，使用 `get_running_skill_advice(mode="personalized")`，遵守其
信息收集流程；这些指标可补充恢复和负荷背景，仍需用户目标、训练经历、可用
时间、主观疲劳和伤痛情况。仅解释 HRV 或准备度时无需启动完整计划流程。

### “最近训练负荷、能力或比赛预测有变化吗？”

按问题选择每日/聚合训练状态、四周负荷平衡、Max Metrics 或比赛预测历史。
训练库中的 `get_garmin_workouts` 是训练模板，不是已完成的训练负荷；近期完成
活动从 `get_garmin_activities` 获取。VO₂ max 和比赛预测保留 Garmin 估算的
性质，按响应核对字段、项目及单位，不据此保证比赛成绩。

## 读取数据时的关键区别

- 所有字段可能缺失或为 `null`。`null`、空数组和缺少某个因素均不等于零；真实
  的零值要保留。先报告覆盖范围，再描述趋势，不插值补成连续好转或恶化。
- HRV 的夜间序列在 `hrvReadings`；保留记录自带的本地/GMT 时间。
- 压力和 Body Battery 的序列按各自 descriptor 的 `index` / `key` 映射列，
  不假设固定列顺序。压力响应使用 `bodyBatteryValueDescriptorsDTOList`，
  Body Battery 报告使用 `bodyBatteryValueDescriptorDTOList`，两者名称不同。
  负数哨兵不能直接混入均值或当作实际压力/能量读数；含义不明时标为未知。
- 准备度可能返回单个对象或多个快照，训练状态/负荷可能返回多个设备；不能
  默认取第一个。按时间、设备和主设备标记选择，并保留冲突或不一致的说明。
- 准备度的 `recoveryTime` 单位为分钟，转小时需除以 60，并注明原记录时间。
  其他估算指标与预测字段按响应核对，不凭字段名字猜单位。

## 缺少能力或数据

| 情况 | 处理 |
| --- | --- |
| 当前会话无 HRV 等工具 | 说明当前连接未提供该能力；继续回答现有数据覆盖的部分。需要升级时按所用客户端更新插件/MCP 并重载，不自动切 Git、预发布包或另一套 Garmin 库 |
| 有摘要工具，无单日工具 | 只分析每日摘要，不声称拿到了夜间曲线 |
| 工具成功返回 `null` / `[]` | 说明该账号、设备和日期没有可用记录；不能据此断言设备不支持或用户未佩戴 |
| 缺少个人基线或状态 | 说明当前响应未提供该项目，仍可报告已有测量；不据此断定尚未建立基线，不设通用 HRV 好坏阈值 |
| 工具返回认证错误 | 使用所用客户端的既有登录流程；与正常无数据分开，登录后重试只读查询 |
| 其他 HTTP / 超时错误 | 报告查询未完成，不改写成“无数据”，不绕过工具读取 session 或直接抓取 Garmin 网页 |

HRV 是恢复分析的一项输入。围绕同一个人、同一测量口径比较趋势，不跨人用绝对
数值排名，也不把这些 Garmin 估算值用于诊断或自行生成医学结论。
