# 血氧与呼吸：本机两区 Session 验收

测试日期：2026-10-21。对象为 `codex/spo2-respiration-readers` 分支的本地编译代码，包含尚未发布的两个读取工具。npm 依赖仍为 `@likenttt/garmin-connect@1.7.0`。

## Session 与工具执行链结果

| 账号 | 查询日期 | 工具 | HTTP | Garmin 返回的数据 |
| --- | --- | --- | --- | --- |
| 大陆主账号（cn） | 2026-10-20、2026-10-19 | `get_garmin_spo2` | 均为 200 | 返回 26 个字段的对象；血氧测量摘要、单次记录、小时汇总字段均为 `null` |
| 大陆主账号（cn） | 2026-10-20、2026-10-19 | `get_garmin_respiration` | 均为 200 | 返回 24 个字段的对象；呼吸测量摘要、原始时序、汇总时序字段均为 `null` |
| 国际服主账号（global） | 2026-10-20 | `get_garmin_spo2` | 200 | 存在数值摘要及 2 条小时汇总；单次测量列表为 `null` |
| 国际服主账号（global） | 2026-10-20 | `get_garmin_respiration` | 200 | 存在数值摘要、676 条原始时序及 24 条汇总时序 |

最终检查共执行 6 次 DSH 工具读取和 6 次 MCP 工具调用，全部通过。每次 MCP 返回均在内存中与对应 DSH 完整响应进行深度比较，结果一致，且缓存命中未增加 HTTP 请求。DSH 与 MCP 均发现 28 个工具。

大陆两项接口的路由与鉴权已实际通过，所选账号和日期未返回测量记录。该结果不能用于判定国内服整体不支持血氧或呼吸，也没有确定空数据的设备、同步或服务端原因。

## 测试方法与边界

- 直接读取本机 Harness 配置中的两个已配置主账号，使用现有、绑定账号身份的 DI Session。
- 首轮测试中，两区访问令牌通过现有刷新流程成功刷新：刷新与资料验证均为 HTTP 200，随后正常持久化到原 Session 文件。执行前确认本机 Harness 进程未运行。
- 测试配置不提供密码和内联令牌，另将 SDK 密码登录入口设为受控失败，未重新发起浏览器登录。
- 通过真实 `GarminClient → GarminToolService → DSH 注册工具 execute` 发起 Garmin 请求，再使用同一客户端验证内存 MCP `tools/list` 与 `tools/call`。
- 原始响应只留在测试进程内存中。私密测试报告仅保存区域、账号别称/稳定 ID、日期、HTTP 状态、字段类型、数量、认证阶段和一致性结果；未保存邮箱、密码、令牌或测量数值。
- 上述 Session 验收覆盖 DSH 工具执行链与 MCP 协议链；桌面安装和模型会话另见下节。

本机最终脱敏报告：`~/.codex/garmin-release-checks/2026-10-21/spo2-respiration/results-2.json`。

## Harness 桌面安装与模型会话验收

使用 Computer Use 操作本机真实 DeepSeek Harness，在“添加插件”界面安装本地测试包。此阶段不发布 npm。

| 检查项 | 结果 |
| --- | --- |
| 安装来源 | 本机 `dsh-plugin-garmin-connect-0.1.18-dev.20261021.1.tgz` 测试包 |
| 安装日志 | `pnpm add` 使用 `--registry=https://registry.npmjs.org/`，安装成功 |
| 安装版本 | `0.1.18-dev.20261021.1` |
| 安装内容核验 | 本机 `node_modules/dsh-plugin-garmin-connect` 的 182 个 `lib` 编译文件与候选包逐字节一致；manifest 版本和维护 SDK 精确依赖均一致 |
| 插件运行状态 | 1 个组件运行中 |
| 大陆主账号 | 保持已登录 |
| 国际服主账号 | 保持已登录 |
| 模型会话发现与调用新工具 | 4 次调用均正常返回，无工具缺失、鉴权失败或接口错误 |

### 模型对话与调用轨迹

真实新对话标题为“Garmin 血氧呼吸只读验收”，使用 `DeepSeek-V4.1-Flash 1017`、`High`。本机时间 18:14 发起、18:15 完成，UI 显示耗时 29 秒。

工具轨迹确认两次 `get_garmin_spo2` 和两次 `get_garmin_respiration`，分别显式使用大陆主账号和国际服主账号的稳定 ID，`date` 均为 `2026-10-20`。四次调用均正常返回，最终对话表格与前述 Session 验收一致：

| 账号 | 工具 | 桌面对话结果 |
| --- | --- | --- |
| 大陆主账号 | `get_garmin_spo2` | 测量摘要和数组字段为 `null` |
| 大陆主账号 | `get_garmin_respiration` | 测量摘要和数组字段为 `null` |
| 国际服主账号 | `get_garmin_spo2` | 摘要非空，`spO2HourlyAverages` 为 2 条 |
| 国际服主账号 | `get_garmin_respiration` | 摘要非空，`respirationValuesArray` 为 676 条，`respirationAveragesValuesArray` 为 24 条 |

本次模型对话未调用终端、本机文件、登录或数据修改工具。记录仅包含工具发现、调用状态、数据是否存在及条数，不保存原始健康数据或凭证。

桌面 GUI 工具响应不附带 HTTP 状态，因此本节的正常返回不单独视为 HTTP 200 观测；HTTP 200 的直接证据来自前述 Session 验收。
