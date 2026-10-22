# Garmin Personal API 大陆与国际端点测试报告

测试日期：2026-10-22。本文时间均为 Asia/Shanghai（UTC+8）。

## 结论

- **大陆端点暂时无法访问**：本次使用大陆站创建的 API Key 请求对应 `.cn` 端点，在换取令牌阶段返回 **HTTP 526 / `TOKEN_EXCHANGE_FAILED`**。没有取得 token，尚未验证大陆账号的数据读取成功。
- **国际端点 SDK 读取已跑通**：国际站创建的 30 天 Key 请求 `.com`，token 交换及 8 项只读操作全部 HTTP 200；HRV、血氧和含呼吸摘要的每日汇总均取得响应。
- **国际端点真实 MCP 验证通过**：Personal 模式不要求邮箱，提供 15 项读取及分析工具；profile、活动、HRV、血氧、呼吸 5 项最终均通过。没有暴露 Garmin 写操作工具，呼吸正确标为每日摘要。

## 1. 测试对象与版本

| 项目 | 本次版本 |
| --- | --- |
| 独立 SDK | [`@likenttt/connect-personal-api-ts@0.1.0`](https://github.com/Likenttt/connect-personal-api-ts)，源码 `417a4f2b8fd453f8cdcc68ef4e5dfd8f926c0549` |
| 插件 | `dsh-plugin-garmin-connect@0.1.19-dev.0`，开发提交 `610d8b7f8061b4a256b65ea17f5b54d13ef67bb8` |
| 插件内 SDK 源码 | 固定快照 `0692c714c59bc05929ff5420238beb7c527287de`；与上述 SDK 的运行时代码一致，后续提交只修改文档 |
| 执行环境 | 本机 Node.js `v26.3.0`，真实 stdio MCP 进程，真实 Garmin API Key；无健康数据模拟替代网络验证 |
| 发布状态 | 开发验证，尚未发布包含 Personal 接入功能的 npm 插件版本 |

## 2. 区域与端点

| 区域参数 | 凭据来源（独立保存） | Personal API 基地址 | 本次观察 |
| --- | --- | --- | --- |
| `region: 'cn'` | 大陆账号此前在 `connect.garmin.cn` 创建的独立 30 天 Key | `https://personal.connectapi.garmin.cn` | 令牌交换 HTTP 526，暂时无法访问 |
| `region: 'global'` | 国际账号本轮在 `connect.garmin.com` 新建的独立 30 天 Key | `https://personal.connectapi.garmin.com` | token 与 SDK 8 项读取全部 HTTP 200；MCP 5 项最终均通过 |

**国际端点使用国际 Key，大陆端点使用大陆 Key。**两份 Key 分别保存在两个本机私密文件中；测试使用独立客户端、各自固定的 `region` 与目标主机。本轮没有跨区混用 Key，也没有在失败后回退到另一个区域。本文结论只依据上述对应区域的验证。

## 3. 只读测试方法

1. 在对应区域创建测试 API Key，优先选择最短的 30 天有效期。密钥只保存在本机权限为 `0600` 的私密文件中。
2. 独立 SDK 显式指定 `region`，使用 API Key 换取 token，再调用 `getUserProfileSettings()` 验证认证和读取链路。
3. 启动插件真实 stdio MCP，设置 `provider=personal`、相同区域和私密 Key 文件，不配置邮箱。
4. 检查工具列表，再调用只读 profile 工具；认证成功后才继续进行健康数据接口抽查。
5. 保存脱敏结果，仅记录时间、区域、目标主机、HTTP 状态、错误码、工具数量与读取成功标记。报告不记录 API Key、token、邮箱、账户资料或健康数值。

本轮不执行训练库、日历或其他 Garmin 写操作。API Key 的创建是验证准备步骤。

## 4. 大陆端点实测

| 时间 | 层级 / 操作 | 结果 | 能证明什么 |
| --- | --- | --- | --- |
| 同日此前准备阶段 | 大陆站创建 30 天 Key，并刷新页面 | 创建成功，Key 记录保留 | 大陆站密钥管理页能创建并保留记录 |
| 11:17:21 | 独立 SDK，`region='cn'`，调用 `getUserProfileSettings()` | token 交换返回 HTTP 526 / `TOKEN_EXCHANGE_FAILED` | SDK 使用对应大陆端点；此次认证链路无法完成 |
| 11:19:52 | 真实 MCP 初始化与工具列表 | 15 项工具，包含 HRV，无 Garmin 写操作工具；没有配置邮箱 | Personal 模式能独立挂载正确能力 |
| 11:19:52 | 真实 MCP profile 读取 | 安全返回 HTTP 526；未返回交互认证 challenge | 插件保留端点失败含义，不误报读取成功 |
| 11:32:22 | 独立 SDK，同期复测大陆 profile | token 交换再次返回 HTTP 526 / `TOKEN_EXCHANGE_FAILED` | 国际读取成功的同轮测试中，大陆端点仍暂时无法访问 |

**大陆端点暂时无法访问。**本次故障发生于 token 交换，不能用它判断 HRV、血氧等具体数据接口是否可用；也不能仅凭 526 推断所有大陆账号永久不受支持。需要待端点恢复后，重新验证 token 与资源读取。

## 5. 国际端点实测

| 时间 | 层级 / 操作 | 结果 |
| --- | --- | --- |
| 本轮准备阶段 | 国际站创建 30 天 Key | 创建成功，刷新后状态为 Active，页面显示 2026-11-21 到期 |
| 11:32:22 | SDK token 交换 | HTTP 200；整个客户端测试只交换 1 次 token |
| 11:32:22 | SDK profile 与健康数据读取 | 8 项全部 HTTP 200，响应容器非空；每日汇总包含呼吸摘要 |
| 11:32:22 | 主机范围检查 | `onlyConfiguredHost=true`，所有请求均发往配置的 `personal.connectapi.garmin.com` |
| 11:33:47 | MCP 工具列表 | 15 项工具，包含 HRV，无 Garmin 写操作工具；没有配置邮箱 |
| 11:33:47 | MCP profile、HRV、血氧、呼吸读取 | 4 项通过；呼吸标为 `daily_summary` 且含呼吸摘要 |
| 11:33:47 | MCP 活动列表首轮脚本 | 错用 SDK 的 `start` 参数，被 MCP 严格参数校验拒绝 |
| 11:35:09 | MCP 活动列表更正参数后重测 | 使用工具公布的 `offset: 0, limit: 1`，通过并返回非空数组 |

数据接口抽查日期为 **2026-10-21**。本轮 SDK 结果如下：

| 读取操作 | HTTP | 响应类型 | 响应容器非空 | 操作耗时（ms） |
| --- | --- | --- | --- | --- |
| 账户设置 `profile` | 200 | object | 是 | 2258，包含首次 token 交换 |
| 活动列表 `activities` | 200 | array | 是 | 332 |
| 步数 `steps` | 200 | array | 是 | 275 |
| 睡眠 `sleep` | 200 | object | 是 | 351 |
| 心率 `heartRate` | 200 | object | 是 | 524 |
| HRV `hrv` | 200 | object | 是 | 273 |
| 血氧 `spo2` | 200 | object | 是 | 395 |
| 每日汇总与呼吸 `dailySummariesAndRespiration` | 200 | object | 是，含呼吸摘要 | 253 |

“响应容器非空”表示已获得 API 返回结构，不表示其中每个时序点都有测量值。呼吸在此次验证中读取的是每日汇总摘要。

真实 MCP 的最终结果：

| 工具 | 最终结果 | 观察 |
| --- | --- | --- |
| `get_garmin_profile` | 通过 | 返回正常工具内容，无交互认证 challenge |
| `get_garmin_activities` | 通过 | 使用 `offset: 0, limit: 1`，返回非空数组 |
| `get_garmin_hrv` | 通过 | 返回正常工具内容 |
| `get_garmin_spo2` | 通过 | 返回正常工具内容 |
| `get_garmin_respiration` | 通过 | 返回呼吸摘要，分辨率标为 `daily_summary` |

活动列表首轮结果保留为脚本调用失败：测试脚本把底层 SDK 的 `start` 参数传给了只接受 `offset` 的 MCP 工具，严格 schema 正确拒绝了该参数。按工具公布的 schema 更正后，单项重测通过；这次参数更正不涉及产品代码修改，也不是国际服务故障。

## 6. 证据与复测条件

测试结果已根据本机脱敏记录核对：

- `cn-sdk-canary-result.json`：2026-10-22 11:17:21，大陆 SDK 请求返回 526。
- `plugin-mcp-canary-result.json`：2026-10-22 11:19:52，真实 MCP 的工具能力与 526 处理。
- `validation-report.md`：大陆 Key 创建、地区路由和前后诊断过程。
- `global-sdk-canary-result.json`：2026-10-22 11:32:22，国际 Key 的 token、8 项 SDK 读取、单次 token 交换与主机范围检查。
- `cn-recheck-result.json`：2026-10-22 11:32:22，同期大陆端点再次返回 526。
- `global-plugin-mcp-canary-result.json`：2026-10-22 11:33:47，国际真实 MCP 的 15 项工具及首轮 4 项成功、活动参数被拒绝的完整脱敏结果。
- `global-mcp-activities-result.json`：2026-10-22 11:35:09，使用公布的 `offset` 参数更正活动列表脚本后，单项重测成功。

这些原始记录保存在本机私密研究目录，本文只整理脱敏结论。

复测大陆端点时须继续使用大陆 Key 和 `.cn` 主机，先检查 token 交换，再验证实际数据读取；取得成功响应前，不将“域名已支持”或“Key 已创建”写成“大陆数据已接通”。

## 7. 后续迭代：别名与 API Key 两项设置

同日 12:19:24（Asia/Shanghai）对本次 `codex/personal-api` 工作分支构建补充验证，继续只使用国际账号 Key 和 `.com` 端点：

| 验证层级 | 本次结果 |
| --- | --- |
| 真实 stdio MCP 进程 | 15 项工具；profile、HRV 读取通过；返回的本地别名、稳定 ID、provider、region 均匹配配置 |
| DSH 工具适配器 | 从 ID 绑定的私密账号槽取 Key，提供 15 项工具；profile、HRV 实际读取通过；无需邮箱，profile 未包含 Key |
| 设置页组件预览 | Personal 表单只有必填别名与 API Key 两个输入；保存后密钥框清空，修改别名保留 Key；新建账号默认国际端点 |
| 旧大陆账号组件预览 | 保存别名仍保留 `cn`；不改发国际端点，显示大陆端点暂不可访问提示 |
| 桌面／手机布局 | 两输入桌面顶部对齐；390px 手机视口无横向溢出 |

设置页检查使用实际 React 组件和隔离演示配置，DSH 后端检查使用实际工具适配器及真实 Garmin 请求；本轮未将新 UI 安装到完整 Harness 外壳中验证。相关设置、配置、MCP 和工具逻辑共 108 项单元测试通过，完整构建与打包通过。

Personal 账号在 DSH 设置页填写必填别名与 API Key；MCP 使用 `GARMIN_ALIAS` 及私密 Key 文件或秘密环境变量。`GARMIN_ACCOUNT` 继续作为稳定机器 ID，修改别名不改变账号路由与凭据归属。脱敏结果保存在本机 `live-provider-result.json`。

## 8. 官方参考

- [Garmin Personal API 说明](https://developer.garmin.com/gc-developer-program/personal/personal-api/)
- [Garmin Personal API FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)
- [Garmin 官方 Python 客户端](https://github.com/garmin/connect-personal-api-python)
- [独立 TypeScript SDK](https://github.com/Likenttt/connect-personal-api-ts)
