---
name: garmin-connect
description: 使用已连接的 Garmin DSH/MCP 工具分析活动、睡眠、心率、HRV、压力、Body Battery、训练准备度和训练趋势，也可在 WorkBuddy 配置插件、按用户要求创建训练或下载 FIT。适用于 Garmin 数据查询、恢复分析和跑步计划；不用于医疗诊断。
metadata:
  agent_created: "true"
---

# Garmin Connect

**Credit：李二牛**

使用 npm 官方仓库中的社区维护、非 Garmin 官方软件包
`dsh-plugin-garmin-connect`。该包不指定版本，始终跟随 npm 当前的
`latest` 正式版本。不要抓取 Garmin 网页，也不要擅自替换成其他 Garmin
库。

## 连接工具

首先检查当前会话实际暴露的 Garmin 工具及其参数 schema。已连接的 DSH 或
MCP 服务可直接使用；WorkBuddy 的初次连接按下列参考文档配置。

首次读取账号数据或所选账号变化时，调用 `get_garmin_profile` 核对目标账号和
只读连接；当前连接已核对且账号未变时继续使用。概念解释无需连接账号。
缺少所需工具时，在用户授权更新并重载连接器后重新检查工具 schema；只有所需
工具已出现且只读查询成功，才报告对应能力可用。

恢复与训练工具的可用性以当前会话为准。仅升级独立 SDK 不会给旧插件增加工具，
更新 skill 也不会注册工具。查询 HRV、压力、Body Battery、训练准备度、负荷、
VO₂ max 或比赛预测时，读取
[references/recovery-analysis.md](references/recovery-analysis.md)，按用户的问题
选择工具和所需日期，不按插件版本号猜测功能。

- 如果工具不可用，读取
  [references/workbuddy-setup.md](references/workbuddy-setup.md)。仅下载软件包
  不会给正在运行的会话增加工具；必须在 WorkBuddy 中注册 stdio MCP 服务并
  重新加载。
- 如果 Garmin 工具提示凭据缺失、过期或需要浏览器认证，在展示或打开任何
  内容前，先阅读同一参考文档中的认证部分。
- 将配置视为两个阶段：先配置并重新加载 WorkBuddy，再请用户重新调用本技能
  进行分析。不要承诺在原会话内同时完成配置和分析。
- 在以下操作发生前分别获得用户授权：① 下载并执行 npm 软件包；② 修改
  WorkBuddy 配置；③ 打开会写入会话文件的浏览器认证。不要把这些副作用
  混入用户对数据分析的授权中。
- 不要在对话中索取 Garmin 密码、MFA 验证码、OAuth 令牌、会话内容或 npm
  令牌。回环页面由本社区插件提供；账号、密码和验证码只能输入其嵌入的
  Garmin 表单。插件会以程序方式把 frame 服务地址限定为
  `https://sso.garmin.cn/sso/embed` 或
  `https://sso.garmin.com/sso/embed`，并校验对应的 Web origin。浏览器地址栏
  仍会显示 `127.0.0.1`，因此不要声称用户可仅凭地址栏独立验证 iframe 来源。
  如果 Garmin 表单缺失或被拦截，立即停止输入。

DSH 多账号调用使用设置页中的稳定账号 ID 作为 `account`；别名用于识别账号，
地区不是账号 ID。MCP 使用对应服务进程配置的账号，不向其工具添加 `account`。
用户没有指定账号时，使用明确的默认账号或服务；有歧义时确认账号别名，再映射
到该客户端的账号选择方式。同一份趋势分析使用同一账号。

## 获取最少必要数据

查询和分析数据时使用以下只读工具：

- `get_garmin_activities`
- `get_garmin_sleep`
- `get_garmin_steps`
- `get_garmin_heart_rate`
- `get_garmin_weight`
- `get_garmin_workouts`
- `get_garmin_profile`
- `get_running_skill_advice`

可用时，恢复与训练数据还包括 `get_garmin_hrv`、`get_garmin_hrv_summaries`、
压力、Body Battery、训练准备度、训练状态、负荷平衡、Max Metrics 和比赛预测
工具；精确名称和调用示例见
[恢复分析参考](references/recovery-analysis.md)。

根据用户的问题选择工具，不要一次获取所有数据。按照用户 Garmin 账号或本地
日历时区，把相对日期换算成明确的 `YYYY-MM-DD`。确认是否需要包含尚未结束的
当天；否则优先使用完整日历日，并说明起止日期均包含在内。睡眠、步数、心率、
体重等原有范围工具超过 30 天时分批查询。新增恢复工具按其 schema 使用原生
范围；比赛预测历史的首尾日期差最多 366 天，不给其他恢复范围工具套用 30 天
上限。较长时序按问题缩小范围，避免无必要地逐日拉取夜间读数。

查询活动时默认显式传入 `detail="full"`，保留 Garmin 活动列表中可用的扩展字段；圈数和分段摘要只在
Garmin 提供时出现。若用户希望减少输出，可显式指定 `detail="compact"`。
`full` 可能包含精确路线或位置，应向用户说明。小表格或摘要足以回答时，不要
复述原始响应。

## 分析时避免过度推断

结果应明确区分：

1. 数据范围以及缺失的日期或字段；
2. 带日期和单位的直接观察；
3. 明确标为推断的谨慎解释；
4. 与用户目标匹配的可行下一步；
5. 局限性，以及哪些补充数据可能改变结论。

至少比较多次测量后再称其为趋势。不要把相关性解释为因果关系，不要诊断疾病，
也不要把 Garmin 估算值当成医学结论。出现警示症状或异常测量时，应建议降低
训练强度，并在适当情况下寻求专业医疗帮助。

HRV 趋势优先使用摘要，再按需查询单日的基线和夜间读数；当天训练决策结合可用的
训练准备度、睡眠、近期活动与用户感受。按参考文档处理多个设备、多个准备度
快照和空数据。工具缺失、正常无数据和认证失败分别处理；缺少 HRV 时只说明现有
数据能支持的结论，不从心率推算 HRV，也不自行合成恢复评分。

解释训练方法时，调用 `get_running_skill_advice` 并设置 `mode="explain"`。
提供个性化建议或计划时，使用 `mode="personalized"`，收集工具返回的全部缺失
信息，并遵守其安全停止条件。Garmin 历史数据可以补充，但不能代替用户的目标、
当前成绩、训练背景、可用时间、健康与恢复情况以及训练负荷偏好。

## 写操作

用户明确要求创建、删除 Garmin 课表、取消日历排期或下载活动 FIT 时，可以使用下列工具。仅请求
分析、建议或生成计划时，不自动向 Garmin 训练库写入，也不自动下载文件。

### 创建 Garmin 训练

使用 `create_garmin_workout`，遵循工具已有的预览与确认流程：

1. 将用户指定的训练编码为工具支持的 `name`、`steps`，以及必要的
   `description`、`sport`。如果训练内容由本技能个性化制定，先完成上文
   `get_running_skill_advice` 的信息收集；用户直接给出的明确训练可直接编码。
2. 首次调用省略 `confirmed` 或设置为 `false`，取得预览和 `confirmationId`。
   展示目标账号、训练名称、步骤与强度，供用户确认。
3. 用户明确确认该预览后，使用完全相同的训练定义，以及 `confirmed: true`
   和对应的 `confirmationId` 再次调用，提交创建。
4. 确认 ID 为一次性使用；预览过期、服务重启、账号切换或训练内容改变时，
   重新预览并取得用户确认。创建失败或返回结果不明确时，不自动重放写请求；
   先查询训练库核对是否已创建，再决定是否重新预览，避免重复训练。

成功后报告工具实际返回的训练名称和 ID（如有）。此工具只创建 Garmin Connect
训练库中的训练，不会为新训练自动安排日历日期或主动推送手表。

### 删除课表或取消日历排期

先检查当前会话实际提供以下工具，再区分目标：

- 删除训练库模板：用 `get_garmin_workouts` 找到真实 `workoutId`，再调用
  `delete_garmin_workout`；此操作不用于删除已完成活动。
- 取消某次日历排期：用 `get_garmin_scheduled_workouts` 查询用户指定日期，
  使用真实 `scheduleId` 调用 `unschedule_garmin_workout`，保留训练库模板。
  排期查询包含首尾，每次最多 31 天；不要用模板 ID 代替排期 ID。

首次删除调用省略 `confirmed`，展示返回的账号、课表或排期预览。用户确认后，
使用相同目标 ID、`confirmed: true` 和对应的 `confirmationId` 再调用。每个确认
绑定账号、动作与目标详情，10 分钟内一次有效。目标变化、令牌失效或结果不明确时，
先只读核对再决定是否重新预览；不要自动重放删除或将一个确认用于多个目标。
仅调整建议或计划文本时，不自动删除 Garmin 中的课表和排期。

### 下载活动 FIT

用户明确要求下载某次活动时，使用 `download_garmin_activity_fit`：

- 先用 `get_garmin_activities` 核对用户指定的活动，传入其正整数 `activityId`。
  多条活动可能匹配时，先确定具体活动，不擅自扩大下载范围。
- MCP 服务必须已设置 `GARMIN_FIT_DOWNLOAD_DIR`，值为用户选择的可信本地
  父目录的绝对路径；缺失时按
  [references/workbuddy-setup.md](references/workbuddy-setup.md) 配置并重新加载。
  不向工具传入额外的保存路径参数。
- 文件按区域和账号保存到独立子目录。插件不覆盖已有文件；遇到 `OUTPUT_EXISTS`
  时报告文件已存在，不删除或覆盖文件来重试。
- 根据返回的文件元数据报告结果，不将 FIT 二进制或原始活动数据塞入对话。
