# dsh-plugin-garmin-connect

> 一个基于 TypeScript、包含**安全浏览器 MFA 认证**的 Garmin Connect 插件与 MCP 服务器：为 DeepSeek Harness 打造，也适用于更多 AI Agent。

[![npm version](https://img.shields.io/npm/v/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![CI](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml)
[![测试报告](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95%E6%8A%A5%E5%91%8A-%E6%9F%A5%E7%9C%8B-blue.svg)](TEST_REPORT.zh-CN.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[English](README.md)** | 中文 | **[测试报告](TEST_REPORT.zh-CN.md)** | **[更新日志](CHANGELOG.md)**

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coding-agents-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coding-agents-light.png">
    <img src="docs/assets/coding-agents-light.png" width="720" alt="DeepSeek Harness、WorkBuddy、千问办公、ZCode、Claude Code、Codex、Cursor 与 Windsurf">
  </picture>
</p>
<p align="center">
  <strong>支持主流 Coding Agent 与 AI 工作台</strong><br>
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> ·
  <a href="https://www.codebuddy.cn/work/">WorkBuddy</a> ·
  <a href="https://qwenwork.cn/">千问办公</a> ·
  <a href="https://zcode.z.ai/">ZCode</a> ·
  <a href="https://www.anthropic.com/claude-code">Claude Code</a> ·
  <a href="https://openai.com/codex/">Codex</a> ·
  <a href="https://www.cursor.com/">Cursor</a> ·
  <a href="https://windsurf.com/">Windsurf</a><br>
  <sub>根据客户端能力，通过 MCP 或 <code>SKILL.md</code> 工作流接入。</sub>
</p>

> [!NOTE]
> **0.1.6 MFA 支持状态：** dsh 本机网页、`garmin-connect-auth serve` 系统浏览器流程与
> MCP URL elicitation 均可为中国区和国际区账号初始化同一种 owner-only session。
> 2026-08-29 已在本机完成两个区域的真实 MFA：中国区跑通了浏览器到 session
> 落盘及只读调用全链路，国际区跑通了系统浏览器、DI 交换与 owner-only session
> 落盘。个别浏览器策略仍可能阻断单次流程。旧的
> `login --browser` 命令仅保留用于诊断。

---

## 我的更多应用

| 图标 | 应用 | 一句话介绍 |
|---|---|---|
| [<img src="https://wristtale.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristTale" />](https://wristtale.com) | [WristTale](https://wristtale.com) | 在手表上阅读 TXT 和 Markdown 电子书 |
| [<img src="https://jiake.app/app-icon.png" width="32" height="32" alt="JiaKe.app" />](https://jiake.app) | [JiaKe.app](https://jiake.app) | 把 Garmin 截图做成精美宣传图 |
| [<img src="https://gamerasnap.com/static/images/appicon.png" width="32" height="32" alt="GameraSnap" />](https://gamerasnap.com) | [GameraSnap](https://gamerasnap.com) | 用佳明手表远程控制手机拍照/录像 |
| [<img src="https://wristalbum.wristtale.com/app-icon.svg" width="32" height="32" alt="WristAlbum" />](https://wristalbum.wristtale.com) | [WristAlbum](https://wristalbum.wristtale.com) | 在佳明手表上保存私人照片相册 |
| [<img src="https://wristpass.li2niu.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristPass" />](https://wristpass.li2niu.com) | [WristPass](https://wristpass.li2niu.com) | 把会员卡、票券装进手腕,随时出示 |
| [<img src="https://2fa4g.li2niu.com/static/branding/app-icon.png" width="32" height="32" alt="2FA4G" />](https://2fa4g.li2niu.com) | [2FA4G](https://2fa4g.li2niu.com) | 在佳明手表上保存离线两步验证码 |

---

## 这个插件做什么？

安装本插件后，DeepSeek Harness 或任何兼容 MCP 的 AI Agent 都可以通过自然语言**自动调用** Garmin Connect 数据。你只需要说一句话，比如：

- *"我昨晚睡得怎么样？"*
- *"帮我看一下最近 5 次跑步的配速变化。"*
- *"我今天走了多少步？"*

代理会自动选择合适的工具调用 Garmin API，并将结果格式化后反馈给你。

### 注册的工具

插件共注册 **10 个工具**。其中 8 个只返回 Garmin 数据；
`download_garmin_activity_fit` 会在 MCP/dsh 所在主机写入一个本地文件，
`create_garmin_workout` 会修改用户的 Garmin 训练库。

| 工具名 | 用途 | 参数示例 |
|---|---|---|
| `get_garmin_activities` | 获取近期运动记录，默认返回完整详情；可选 `compact` 精简模式 | `{"limit": 5}` |
| `get_garmin_sleep` | 获取指定日期或日期范围的睡眠评分、时长与阶段分布 | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_steps` | 获取指定日期或日期范围的步数；仅当 Garmin 上游提供时才包含目标与步行距离 | `{"startDate": "2023-10-01"}` |
| `get_garmin_heart_rate` | 查询指定日期或日期范围的静息、最高与最低心率 | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight`     | 查询指定日期或日期范围的身体成分（体重、BMI、体脂率、骨骼肌等） | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts`   | 查询 Garmin 训练库中的可复用训练模板（不是日历排期） | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile`    | 获取经过字段白名单过滤的个人资料摘要 | `{}` 或省略 |
| `get_running_skill_advice` | 讲解 8 种课型与 4 套训练理念，或先完成必问信息再提供个性化建议 | `{"mode": "explain", "query": "丹尼尔斯", "language": "zh-CN"}` |
| `download_garmin_activity_fit` | 下载活动的原始归档，并把其中唯一的 FIT 文件安全提取到所配置父目录下的账号目录 | `{"activityId": 123456789}` |
| `create_garmin_workout` | 预览结构化训练；仅在显式确认后创建 | `{"name": "门槛巡航3×8分钟", "steps": [...]}` |

Harness 配置多个账号时，访问账号数据的工具调用需添加 `account` 参数，值为设置页
显示的稳定账号 ID；只有一个账号时可省略。显示别名帮助识别账号，区域决定 Garmin
服务，两者都不会替代账号 ID；同一区域可以配置多个账号。

创建训练采用两次调用流程。首次调用只返回预览和一次性
`confirmationId`；用户确认未更改的预览后，再使用相同训练定义、
`confirmed: true` 及该 `confirmationId` 调用。确认 ID 10 分钟后失效，且不可复用。

### 个性化跑步训练问询

`get_running_skill_advice` 明确区分“知识讲解”和“个性化规划”：

- `mode: "explain"` 只讲解课型或训练理念，不生成针对某位跑者的日程。
- 任何针对个人的建议或计划都必须使用 `mode: "personalized"`。下列六组信息
  必须全部回答；如果缺失，工具只返回需要追问的问题，不读取 Garmin 活动，也不得
  先猜测训练量、强度或生成逐日/逐周计划。

| 问询字段 | 助手必须询问的内容 |
|---|---|
| `goal` | 目标距离/赛事、未来的 ISO `YYYY-MM-DD` 日期，以及完赛目标或理想/最低可接受成绩 |
| `currentPerformance` + `performanceBasis` | 过去两年内代表性比赛/计时测试的距离、成绩、不晚于今天的日期、努力程度与条件，或明确填写 `no_recent_benchmark` |
| `trainingBackground` | 跑龄、最近 4–8 周跑量/时长、频率、最长跑、质量课和中断情况 |
| `availability` | 每周可训练天数和时长、固定休息/长跑日、场地限制、力量训练时间，以及是否具备双练条件 |
| `healthConstraints` + `hasWarningSymptoms` | 当前/过去一年伤病、疼痛、相关疾病/用药、睡眠和恢复，并明确回答是否存在健康警示症状 |
| `trainingPreference` + 偏好细节 | `steady`、`hard_easy` 或 `mixed`，并填写 `maxQualitySessionsPerWeek`（0–7）与 `intensityGuidancePreference`（`pace`、`heart_rate`、`rpe` 或 `mixed`） |

如果 `hasWarningSymptoms` 为 `true`（例如当前胸部不适、轻微活动异常气短、
晕厥/眩晕或异常心悸），工具会直接返回安全停止结果，不返回课型素材，也不读取
Garmin 活动；它只建议先取得医疗专业人员许可，不自行诊断。如果
`performanceBasis` 为 `no_recent_benchmark`，则只建议先建立轻松跑基础或完成
低风险基准测试，不能凭空给出精确门槛/间歇配速。

精简的训练理念层包括：

- **汉森法**：高频、较均匀的周跑量，强调配速纪律和累积疲劳；不能脱离整套
  训练量单独照抄“16 英里长跑”。
- **丹尼尔斯法**：用近期真实成绩估计当前 VDOT，再组合 E/M/T/I/R 强度；
  不能用目标成绩反推训练配速。
- **挪威阈值法**：可借鉴受控、非力竭的阈值训练和难易日分离；默认不安排
  双阈值，也不照搬精英跑量或固定乳酸值。
- **极化训练**：大部分训练真正轻松，少量训练明确艰苦；80/20 是方向，
  不是必须精确凑出的比例。

近期 Garmin 跑步数据只能补充上述问询，不能代替用户回答。方法来源、证据边界和
适用限制见[训练方法研究说明](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/docs/research/running-training-methods.md)。
每条训练理念和课型卡还会把相应内容标成 `system_principle`（体系理念）、
`research_evidence`（研究证据）或 `application_inference`（应用推断），避免把
方法定义误写成优越性证据。

---

## 快速开始

### 1. 安装本插件 — 从 npm registry(推荐)

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add dsh-plugin-garmin-connect
```

这一条命令会同时安装依赖并激活插件层,首次运行会自动初始化 `web` profile。你只需要 `pnpm` 在你的 `PATH` 中:

```bash
npm install -g pnpm
```

> `--legacy-peer-deps=false` 让 npm 正常解析 peer 依赖。如果你的 npm 配置了 `legacy-peer-deps=true`(会跳过 peer 包),dsh 会因缺少 `@deepseek-ai/cordis-plugin-group` 而报 `ERR_MODULE_NOT_FOUND`;没有该配置的机器上,这个参数是无害的默认行为。

不启动即可验证插件层是否已组合进配置:

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh --profile web --dump-config | grep -A 2 garmin-connect
```

其他安装方式:

```bash
# 本地源码调试
cd garmin-connect-plugin-for-dsh && npm install
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add .

# GitHub 源码安装
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>
```

### 2. 安装 Harness CLI(如果还没有)

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

默认在 `http://127.0.0.1:3080` 打开 Web 界面。如果通过 `npx` 启动,下面的命令同样加上 `npx --legacy-peer-deps=false @deepseek-ai/dsh` 前缀;如果已全局安装 `dsh`,则可以去掉 `npx @deepseek-ai/` 前缀。

### 3. 准备登录时再配置 Garmin 账号

Harness 插件安装和启动时可以不填 Garmin 邮箱。在本机 Harness 的**插件**页面打开
**dsh-plugin-garmin-connect**，找到**Garmin 账号配置**，点击 **+** 逐个添加账号，
最多五个。每个账号分别选择中国区（cn）或国际区（global），同一区域可添加多个账号，
也可设置显示别名。保存后，在同一设置页点击该账号的**登录**，Harness 会在内嵌页面
打开 Garmin 登录流程；密码和 MFA 验证码仍输入在 Garmin 官方页面。已保存的邮箱不会
回填到配置表单。每个账号都有独立会话和设置页可见的稳定账号 ID；配置多个账号时，
工具调用需指定该 ID 作为 `account` 参数，以免读取或写入错误的账号。

CLI、MCP 或无界面运行时可以通过环境变量（或启动器提供的密钥存储）配置账号，
请确保 `.env` 不进入版本控制。本机 Web MFA 流程会在用户确认 profile 后，由
Host 原子保存仅所有者可访问的 DI session 文件，但绝不会保存密码、MFA 验证码或
CAPTCHA 答案。

```bash
# 仅源码目录：复制随仓库提供的模板
cp .env.example .env

# 仅在使用 CLI/MCP 或环境变量配置时编辑 .env
```

如果通过 registry 安装且选择环境变量配置，请在运行 `dsh` 的目录（工作区根目录）
新建 `.env`，再按下表填写变量；包内模板不会出现在当前工作目录。插件启动时会自动
加载该文件。插件设置中明确保存的邮箱优先于 `GARMIN_USERNAME`。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `GARMIN_USERNAME` | CLI/MCP | Garmin 账号邮箱；Harness 用户可在安装后通过插件设置填写 |
| `GARMIN_ACCOUNT` | ❌ | Web/CLI/MCP 隐式 session 路径使用的小写本地别名（未设置时为 `default`） |
| `GARMIN_PASSWORD` | ✅* | 旧版直接登录密码；不要用于下方的 MFA 交互式初始化 |
| `GARMIN_SESSION_TOKEN` | ✅* | 内联预认证令牌（仍支持，但 session 文件更安全） |
| `GARMIN_SESSION_TOKEN_FILE` | ✅* | 本地认证命令生成的 owner-only DI v2（或兼容的旧 OAuth）session 文件路径 |
| `GARMIN_REGION` | ❌ | `global`（默认，国际版）或 `cn`（佳明中国） |
| `GARMIN_FIT_DOWNLOAD_DIR` | 仅 FIT | 用户为 FIT 导出显式选择的主机父目录；无默认值，生成的账号目录会包含 `GARMIN_REGION` |
| `GARMIN_CACHE_TTL` | ❌ | 缓存有效期，单位秒（默认 `300`） |
| `GARMIN_REQUEST_TIMEOUT_MS` | ❌ | Garmin 请求超时，单位毫秒（默认 `15000`） |
| `GARMIN_LOG_LEVEL` | ❌ | 日志级别：`debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `full`（默认，保留活动列表中可用的扩展字段；仅当 Garmin 提供时才包含圈数和分段摘要，且可能包含精确路线/位置）或 `compact`（精简输出）。凭据及无关账号/社交标识会被过滤。 |

> \* 正常读取数据时，`GARMIN_PASSWORD`、`GARMIN_SESSION_TOKEN`、
> `GARMIN_SESSION_TOKEN_FILE` 三选一即可；本机 Web、`auth:serve` 和独立 MCP
> 可以在三者都没有时启动，并创建隐式账号 session 文件。开始登录前仍需配置账号邮箱；
> Harness 用户可以安装后在插件设置中填写。受保护的 session 文件比内联
> token 更安全，尤其适合隔离多个进程。如果同时配置，内联 token
> 会优先于文件，直到 Garmin 明确拒绝它；此后新写入且账号匹配的 session 文件可在重试
> 时接管。有效 session 优先于密码登录。
>
> ⚠️ 如果密码包含 `#` 等特殊符号，请用**双引号**包裹，否则 `#` 后的内容会被当作注释截断：
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```
>
> `GARMIN_SESSION_TOKEN` 与 `GARMIN_SESSION_TOKEN_FILE` 的内容都和密码一样敏感。
> Token 导出不会作为 AI 可调用工具提供，也绝不要把 Token 粘贴进 AI 对话。

#### 两步验证——浏览器 MFA

当 dsh 与它的 Web UI 运行在同一台本机时，先在插件的**Garmin 账号配置**中保存
对应区域和邮箱，再在设置页点击该账号的**登录**。每个账号分别使用自己的登录流程和
会话。Harness 内嵌页面会打开随机 `127.0.0.1` 端口上的自定义桥页；Garmin 官方
GAuth 页面嵌入这个独立
桥页，而不是直接嵌入 dsh 页面。账号邮箱会保存在本机 Harness 插件配置中；Garmin
登录页上再次输入的邮箱、密码、MFA 验证码和任何 CAPTCHA 都留在 Garmin iframe 中。

让这套流程既可用又安全，远不是增加一个“验证码”输入框那么简单。我们首先把 Garmin
官方 GAuth 页面保留在本地 iframe 中，让 Garmin 登录表单字段留在 Garmin origin；
随后逐一处理了跨域消息、官方样式缺失、CSP/Trusted Types、第三方 frame 策略、MFA 重定向和
精确 ticket/service 绑定。受 Zhitao 在 [DailySync](https://dailysync.cn) 中“用新标签页完成 Garmin SSO”思路的
启发，我们又为 CLI 和 MCP 客户端加入了系统浏览器 loopback broker。新标签页返回的只是一次性、
短期 service ticket；Host 会立即将它交换为更长期的 DI session/refresh 凭据，复核 Garmin profile，
并以 owner-only 方式落盘。因此“可能长期（包括约一年）可用”的是交换后的 session/refresh 凭据，
不是 service ticket 本身；实际有效期始终由 Garmin 决定。

Garmin 产生的短期 service ticket 只会到达隔离的 loopback 桥页。桥页会校验预期区域、
消息来源、iframe 来源、service 与 ticket，然后立即交给插件 Host 执行严格绑定区域的
DI token 交换。中国区 Garmin 在 MFA 后可能把 ticket 绑定到本次精确的
`http://127.0.0.1:<端口>` 桥页，而不是固定的 Garmin embed URL；插件会原样保留
ticket/service 配对，并在请求 DI 前拒绝其他 loopback 主机、端口、路径、查询参数或区域。
一次性 ticket 不会被改写 service 或用后备 service 重试。Host 探测 Garmin profile，向用户显示安全化后的 profile 供确认。只有
用户确认该 Garmin 账号与配置邮箱对应后，才原子写入绑定配置账号与区域、且仅所有者可访问
的 session。外层 dsh 页面会收到公开的登录进度；账号完成身份验证后，设置页可显示
该账号邮箱。模型上下文和 AI 可调用工具返回都拿不到 ticket、DI token、密码、
MFA 验证码或 CAPTCHA 答案。

当 Host 已通过密码登录、绑定 profile 的 DI session 或刚完成的 Web 登录确认账号身份时，
插件设置中对应账号会显示已登录。仅加载但尚未验证身份的旧版 OAuth token 不会显示为
已登录；状态接口也不会返回 ticket 或 token。登录对话框只在用户点击该账号的设置页
登录操作时打开。缺失或过期的 session 不会自动弹窗。

打开对话框前需在对应账号卡片中保存邮箱。该 Web 流程可不设置
`GARMIN_SESSION_TOKEN_FILE`：Host 会为每个账号使用各自独立、仅所有者可访问的
session 文件，迁移后的旧账号沿用原路径。用户确认并成功落盘后，当前插件会清除之前
的 session 拒绝状态；下一次工具调用即可读取新文件，不需要重启 dsh。

该受支持的 Web 流程有意只支持 dsh 的 loopback 本机网页，不是远程、托管或隧道登录端点。
浏览器的第三方 Cookie 与 iframe 策略可能让 Garmin GAuth 无法完成。2026-08-29 已在
本机跑通真实中国区 MFA 的浏览器、DI 交换、profile 确认、owner-only 落盘和只读 session
使用链路；国际区真实账号 MFA 也已跑通系统浏览器挑战、DI 交换、profile 确认和
owner-only session 落盘。这并不把同机
流程扩展成远程或无限期 session 恢复保证。登录、MFA 与 profile 确认必须在桥页的
10 分钟有效期内完成。

完整的信任边界与数据流见[两步验证登录目标架构](#两步验证登录目标架构)。

#### 本机系统浏览器认证

CLI 与 MCP 客户端推荐使用 loopback broker MFA 流程，并显式选择账号别名与区域。
该命令强制同时提供两个参数，不会从 `GARMIN_ACCOUNT`/`GARMIN_REGION` 推断，以免双账号
环境把 session 写到错误账号：

```bash
# 已安装的可执行命令
garmin-connect-auth serve --account personal --region global --open
garmin-connect-auth serve --account personal-cn --region cn --open

# 源码目录
npm run auth:serve -- --account personal --region global
npm run auth:serve -- --account personal-cn --region cn
```

`serve` 会在随机 `127.0.0.1` 端口启动一次性桥页，并用系统默认浏览器打开。它不会创建
或管理隔离的 Chrome/Playwright profile；操作系统可能复用已经运行的默认浏览器，也可能
启动已配置的默认浏览器。CLI 可能读取已配置的账号邮箱，但密码、MFA
验证码和 CAPTCHA 始终只在 Garmin 页面中输入，不能通过命令行参数、环境变量、MCP
工具参数或模型输入传入。桥页只接收短期 service ticket，并交给本地 runtime 完成区域
绑定的 DI exchange；页面显示安全化 profile 供确认后，runtime 才写入 owner-only session。
登录、MFA 与 profile 确认未在 10 分钟内完成时，本次流程会过期，需要重新发起。

未配置 `GARMIN_SESSION_TOKEN_FILE` 时，输出路径由 `GARMIN_ACCOUNT`/`--account` 推导：
POSIX 常规配置路径为
`~/.config/dsh-plugin-garmin-connect/accounts/<alias>.session.json`（其他平台使用对应配置根
目录）。随后进程只需下列非密码配置：

```dotenv
GARMIN_USERNAME=your-email@example.com
GARMIN_ACCOUNT=personal
GARMIN_REGION=global
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent
```

该浏览器初始化已正式支持中国区和国际区的同机认证。2026-08-29 已在本机跑通
两个区域的真实 MFA。真实 refresh token 轮换仍会纳入持续兼容性覆盖，但不再影响
MFA 的正式支持状态。

#### 旧版浏览器诊断

`garmin-connect-auth login --browser` 仅保留用于开发和诊断，不再是 `serve` 或 MCP 认证的
推荐后备。它通过 Playwright 启动隔离 Chrome，仍可能遇到重定向拦截。无落盘 canary 也
使用这条旧链路：

```bash
garmin-connect-auth login --browser --account personal --region global
garmin-connect-auth login --browser --account personal-cn --region cn
npm run auth:canary -- --region global
npm run auth:canary -- --region cn
```

为兼容旧用法，不带 `--browser` 的终端密码尝试仍保留。密码提示处直接回车会打开共享的
系统浏览器流程；检测到明确的 MFA／CAPTCHA 页面标记时也会转到同一流程，不再在终端询问
MFA 验证码。含糊的密码、网络或 no-ticket 错误不会自动打开浏览器。这些诊断入口与
正式支持的系统浏览器 MFA 初始化相互独立。

DI v2 文件会通过不可逆摘要绑定规范化 username、region，以及刚探测到的 Garmin
profile（包括 `profileIdHash`）；绑定信息不会重复保存明文邮箱。运行时会在发布刷新后的
凭据前拒绝 username、region 或 profile 不匹配的文件。access token 会在到期前提前刷新，
轮换后的 refresh token 会先安全写回再投入使用；认证失败时只允许幂等 GET 最多重放一次，
训练创建等写请求绝不会自动重放。

为保持向后兼容，只有 `oauth1`、`oauth2` 两个字段的旧 session 文件仍可读取。旧文件
没有可校验的 profile 绑定；预期替代方案是浏览器生成、带错账号保护且经过验证的
DI v2 session。在 POSIX
系统中，旧文件本身
仍须通过当前 owner-only 文件权限检查（通常为 `0600`）、完整安全祖先链校验，以及最终
私有父目录校验（通常为 `0700`）。

POSIX 上会在打开 Garmin 认证前准备默认账号目录。如需自定义 session 文件，可添加
`--output /absolute/private/path/personal.session.json`。预检会规范化已有且安全的链接目标、
拒绝可被他人写入的不安全祖先，并要求最终父目录属于当前有效 UID、owner 具备写入和执行
权限且 group/other 无任何权限（通常为 `0700`）；缺失层级会逐级以 `0700` 创建。写入器
使用规范化后的目标，并在原子替换前再次核验父目录、已有目标和 no-follow 临时文件句柄。
macOS 上还会拒绝每个已检查祖先、父目录、已有文件和空临时文件中的授权型扩展 ACL；仅有
看似私有的 `0700`/`0600` mode 并不能绕过该校验。
如果常规配置根目录或其任一祖先目录可由 group/other 写入，预检会有意拒绝启动认证。
请自行修复该目录权限，或把 `GARMIN_SESSION_TOKEN_FILE`/`--output` 指向全新的 owner-only
应用目录；插件不会静默 `chmod` 共享或宽松权限的配置目录树。

Windows 上，隐式账号路径会优先使用当前用户的本机 `LOCALAPPDATA`，而不是可能被重定向的
漫游 `APPDATA`。显式目标也请放在当前用户的本机系统 profile/config 根目录之下，并使用
全新的专用子目录树；不支持 UNC/网络目录。从最长匹配的 Windows 特殊目录根到 session 父目录，每一级都必须使用受保护
DACL：owner 是当前 SID，且只有一条当前 SID 的 `FullControl` 规则。缺失层级会以该
DACL 原子创建；已有但不精确的层级和任何重解析点都会被拒绝，不会被改写。空临时文件也
会在写入凭据字节前应用同样严格的文件 DACL，读取 session 时还会重新验证整条目录链和
文件 ACL。早期实现中仅靠标记的目录不再可信；请迁移到全新的专用子目录树。

#### 多账号：每个账号使用独立进程

当前支持的运行时模型是“每账号每进程隔离”：每个 dsh、Codex、Claude Code 或其他
MCP 进程分别设置自己的 `GARMIN_USERNAME`、`GARMIN_REGION` 与 `GARMIN_ACCOUNT`（或
显式的 `GARMIN_SESSION_TOKEN_FILE`）。每个进程都可延迟读取自己的隐式账号 session
路径并使用正式支持的浏览器 MFA 初始化；真实中国区账号链路已完成端到端验证。

不要把一个 session 文件复制给其他进程，也不要让并发进程共享同一文件。Garmin 的
refresh token 可能轮换，否则并发写入可能互相覆盖或使凭据失效。例如分别使用
`personal-dsh`、`personal-codex`、`personal-claude` 别名，并为每个进程使用独立初始化
的 session。不要通过符号链接或大小写不同的路径别名，让另一个运行时指向同一个物理
文件。

多个进程可以共享同一个 `GARMIN_FIT_DOWNLOAD_DIR` 父目录，插件会按各自配置的区域和邮箱
自动建立独立账号子目录，因此同一邮箱的 `cn` 与 `global` 账号也不会冲突。只有一个 MCP
条目时，普通 Garmin 查询默认使用该条目；有两个条目时命名为 `garmin-cn` 和
`garmin-global`，仅在目标账号有歧义时才需要在提问中指出服务器名。

这是进程隔离，不是单进程账号选择器，也不是多租户授权系统。不要把同一个 MCP
进程共享给互不信任的用户；当前尚未实现按用户访问控制。在同一对话中切换账号和
自动跨账号同步仍属于路线图能力。

#### 下载 FIT

`download_garmin_activity_fit` 只接受 activity ID，模型不能指定任意输出路径。工具先把
Garmin 原始活动 ZIP 下载到私有临时位置，执行大小限制，并要求归档中恰好存在一个有效
FIT 文件。假设用户配置的父目录是 `<base>`，最终路径为
`<base>/GARMIN_FIT_<cn|global>_<规范化邮箱>/<activityId>.fit`，且不会覆盖已有文件。
`cn` 或 `global` 来自 `GARMIN_REGION`。`<规范化邮箱>` 会经过安全规范化：普通邮箱保持可读，
路径分隔符、控制字符等不安全文件名字符会先被处理，再创建账号目录。用户根据自己配置的父目录和此规则定位文件。工具只
返回 `activityId`、`fileName`、`sizeBytes` 和 `sha256`，不会返回父目录、账号子目录、
邮箱或完整路径；ZIP/FIT 二进制内容也不会进入模型上下文。

父目录没有默认值，必须由用户通过 `GARMIN_FIT_DOWNLOAD_DIR` 显式选择。它只在调用此
工具时必需；未设置时工具会在写入任何文件前失败，其他 Garmin 工具仍可正常使用。
多个账号进程可以安全共享同一个父目录，因为“区域+规范化邮箱”子目录会自动隔离，
即使中国区与国际区使用同一邮箱也不会冲突。
已有的 `GARMIN_FIT_<邮箱>` 目录不会自动迁移；新下载使用带区域前缀的目录，旧文件保留在原位。

Garmin 的“原始文件”并不保证一定是 FIT。如果归档中没有唯一有效的 FIT 条目，工具会
安全失败，不会把其他格式伪装成 `.fit`。

### 4. 启动

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

打开 `http://127.0.0.1:3080`。当 **设置 → 插件 → 插件列表** 中显示 `plugin-garmin-connect` 为 *已挂载、已启用* 时,说明插件已成功加载。然后直接对话:*"我昨晚睡得怎么样?"* 或 *"帮我看一下最近 5 次跑步。"*

### 5. 集成测试（可选，仅限源码目录）

集成测试脚本仅用于开发，不包含在 npm 包中。在已安装开发依赖的源码目录里配置好
`.env` 后，可以运行它验证 API 连通性：

```bash
npm run test:integration
```

脚本只检查读取接口；任一检查失败都会以非零状态退出。它不会创建、更新或删除
训练及其他 Garmin 数据。

默认会隐藏账号标识，并只输出数量/状态，不显示活动或健康数值。只有在明确希望把
规范化详情输出到本地终端时，才设置 `GARMIN_INTEGRATION_VERBOSE=true`。

<details>
<summary>📋 点击展开完整示例输出</summary>

```
🔌 Garmin Connect Integration Test
   Domain : garmin.com
   User   : configured (identifier hidden)
   Date   : 2026-08-18
   Scope  : read-only (workout creation/update/deletion is not tested)

── 1. Authentication ──
  ✅ Password login successful

── 2. Activities ──
  ✅ Got 3 activities

── 3. Sleep ──
  ✅ Sleep data loaded

── 4. Steps ──
  ✅ Step data loaded

── 5. Heart Rate ──
  ✅ Heart-rate data loaded

── 6. Weight / Body Composition ──
  ✅ Body-composition data loaded

── 7. Workout Library ──
  ✅ Got 5 workout templates

── 8. User Profile ──
  ✅ Profile loaded

🏁 Integration test complete: 8 passed, 0 failed.
   Write operations were intentionally not tested.
```

</details>

---

## 🔐 安全设计

> **凭据只在本地用于直接登录 Garmin Connect，且绝不会由 AI 工具返回。**

### 凭据解析优先级

```
1. 插件配置值（本机 Garmin 账号配置表单、profile patch 或 --patch 中指定的 config）
   ↓ 回退
2. 环境变量（.env 文件 / Shell 环境）
   ↓ 回退
3. Schema 中定义的默认值
```

### 安全措施一览

| 措施 | 状态 |
|---|---|
| 支持环境变量及标记为 secret 的配置 | ✅ |
| `.env` 已加入 `.gitignore`，不会被提交到 Git | ✅ |
| 账号标识与凭据字段均标记为 `role('secret')` | ✅ |
| dsh 本机 Web MFA 桥页 | ✅ 已支持；仅 loopback；真实中国区 MFA 链路已在本机通过 |
| CLI `serve` 与 MCP URL elicitation | ✅ 已支持；同机共享 runtime 与 owner-only session 落盘 |
| 旧 CLI `login --browser` / `canary` | ⚠️ 仅 Playwright 诊断，不作为认证后备 |
| DI v2 session 绑定 username、region 与 `profileIdHash`；旧两字段 session 保持兼容 | ✅ |
| 每进程独立初始化的 session 文件支持进程隔离多账号 | ✅ |
| access token 提前刷新；幂等 GET 最多重放一次，写请求不重放 | ✅ |
| 工具返回值中不包含任何原始凭据 | ✅ |
| FIT 二进制及本地/账号路径留在主机，模型只收到活动 ID、文件名、大小与 hash | ✅ |
| 内存缓存减少 API 调用次数，防止触发 Garmin 限流 | ✅ |

### Session Token

仍然支持 Session Token 登录，但 Token 本身就是凭据，不能出现在代理输出或轨迹日志中。
因此，本插件不会把认证、MFA 提交或 Token 导出暴露为 AI 可调用工具。如果已经拥有
经过验证的 owner-only DI v2 或兼容旧 session 文件，dsh/MCP 可以通过
`GARMIN_SESSION_TOKEN_FILE` 读取它，运行时不再需要账号密码。DI 文件会绑定规范化
username、region 和 `profileIdHash`；为兼容旧版本，无绑定的 `oauth1`/`oauth2` 两字段
文件仍可读取。通过上方 dsh Web 桥页、`serve` 或 MCP URL elicitation 创建新的 MFA session
是正式支持的同机工作流。Garmin refresh token
可能轮换，因此 dsh、Codex、Claude Code 或其他进程之间不得并发共享或复制同一文件。

---

## 在其他 AI 编程助手中使用（MCP 协议）

本插件同时提供了一个独立的 **MCP (Model Context Protocol) 服务器**，让你可以在 OpenAI Codex、Claude Code、Claude Desktop、Cursor、Windsurf、WorkBuddy、ZCode 等任何支持 MCP 的客户端中使用相同的 Garmin 工具 — **无需安装 DeepSeek Harness**。

> **当前可用性：** npm `0.1.5` 及之后版本已包含独立 MCP 入口；本地源码方式仍适合开发。

先构建本地服务器：

```bash
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm install
npm run build
```

请把示例中的 `/absolute/path/to/garmin-connect-plugin-for-dsh` 替换为本地源码目录的
真实绝对路径。

MCP 进程需要邮箱、显式区域和本地账号别名。session 文件路径可以不配置；此时服务会
根据 `GARMIN_ACCOUNT` 推导 owner-only 路径。让客户端进程获得这些值及可选 FIT 父目录：

```bash
export GARMIN_USERNAME='你的佳明邮箱'
export GARMIN_REGION='cn'
export GARMIN_ACCOUNT='personal-cn'
export GARMIN_FIT_DOWNLOAD_DIR='/absolute/path/to/garmin-fit-parent'
# 可选覆盖；否则使用 accounts/personal-cn.session.json。
# export GARMIN_SESSION_TOKEN_FILE='/absolute/path/to/personal-cn.session.json'
```

不要在这些环境变量中放密码或 MFA 验证码。工具遇到 session 缺失、过期、被拒绝或明确的
MFA／CAPTCHA 浏览器挑战，
且客户端声明支持 MCP URL elicitation 时，本次工具调用会返回一个随机的本机
`127.0.0.1` 登录链接。打开链接，在浏览器中完成 Garmin 登录/MFA 与 profile 确认，
等待完成通知后，再重试原请求。服务端不会自动重放，因此不会借认证流程重复执行写入。
不支持 URL elicitation 的客户端会收到等价的可信终端回退命令：

若环境中仍保留旧的 `GARMIN_PASSWORD`，无需 MFA 的密码登录仍可继续工作。只有 Garmin
响应中出现明确的 MFA 输入／表单或活动 CAPTCHA 标记，才会转换成同一个可由浏览器恢复的
MCP 认证状态；SDK 含糊的 no-ticket 文本、错误密码、HTTP 401 与网络错误不会被当作 MFA。
密码和上游错误文本都不会进入工具结果。

```bash
garmin-connect-auth serve --account personal-cn --region cn --open
```

如果该 MCP 条目显式设置了 `GARMIN_SESSION_TOKEN_FILE`，请在可信终端导出同一个值，或
给命令追加 `--output` 并使用相同目标。回退错误不会把本机路径回显到模型上下文。
`serve` 成功写入内容已变化且账号匹配的 session 后，重新调用工具即可让仍在运行的 MCP
进程热加载同一个安全文件快照，无需重启 MCP。内容未变化的已拒绝文件、refresh 已过期
的替换文件或其他账号的文件都不会被再次发给 Garmin 探测。如果内联
`GARMIN_SESSION_TOKEN` 已被明确拒绝，这个安全替换也会在内存中接管，旧内联凭据不会重试。

密码和 MFA 验证码只进入 Garmin 页面，不进入 MCP 工具或模型。session 文件与 FIT
父目录都需要保护，因为它们可能授予账号访问能力或包含精确位置与健康数据。每个同时
运行的客户端进程都要使用独立别名/session，不得在 Codex、Claude Code、dsh 等进程间
复制或并发共享同一文件。浏览器 MFA 已按上文正式支持，真实中国区账号链路已完成端到端验证。

### OpenAI Codex（桌面端、CLI 与 IDE 扩展）

同一主机上的 Codex 客户端共用 `~/.codex/config.toml`。推荐只在配置中声明需要转发的
环境变量名，不把凭据值复制到 TOML。确保 Codex 进程能够读取上面的变量后，把以下
内容加入 `~/.codex/config.toml`：

```toml
[mcp_servers.garmin-connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_REGION", "GARMIN_ACCOUNT", "GARMIN_SESSION_TOKEN_FILE", "GARMIN_FIT_DOWNLOAD_DIR"]

# 只读工具可正常运行；写本地文件或 Garmin 数据前由 Codex 请求批准。
default_tools_approval_mode = "writes"
```

此配置使用单独分配给该 Codex 进程的 session。若 Codex 声明 URL elicitation 能力，
它可以显示上文的本机登录链接；否则用同一别名执行可信终端 `serve` 命令。密码/MFA
仍只进入 Garmin 页面。不要复用已经分配给 dsh、Claude Code 或其他运行中进程的
session。国内与国际账号可分别新增 `garmin-cn`、`garmin-global` 等服务器表。它们可
复用同一个 FIT 父目录，输出会自动
进入该账号的“区域+规范化邮箱”子目录。

Codex 进程必须继承上面导出的变量。如果桌面端不是从该终端启动，请在
**Settings → MCP servers** 中添加服务器并提供环境变量，或通过你日常使用的密钥注入
环境启动它。设置界面中填写的值属于本地凭据，请保护生成的配置文件。

如果只希望当前可信项目使用，可把同一配置写入项目内的 `.codex/config.toml`。
修改后重启 Codex 客户端，并检查已保存的配置：

```bash
codex mcp list
codex mcp get garmin-connect
```

在 Codex CLI 内输入 `/mcp`，确认服务器已经连接并查看工具。设置界面及
`codex mcp add` 的更多用法见
[Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。

### Claude Code

Garmin 通常属于个人服务，因此推荐使用 user scope。下面的 bash/zsh 示例不会把
session 内容写入 `~/.claude.json`，只配置 owner-only 文件路径：

```bash
claude mcp add-json --scope user garmin-connect \
  '{"type":"stdio","command":"node","args":["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],"env":{"GARMIN_USERNAME":"${GARMIN_USERNAME}","GARMIN_REGION":"${GARMIN_REGION:-global}","GARMIN_ACCOUNT":"${GARMIN_ACCOUNT:-default}","GARMIN_SESSION_TOKEN_FILE":"${GARMIN_SESSION_TOKEN_FILE}","GARMIN_FIT_DOWNLOAD_DIR":"${GARMIN_FIT_DOWNLOAD_DIR}"}}'
```

该服务器使用单独分配给此 Claude Code 进程的 session。客户端若未显示 MCP URL
elicitation，就用可信终端 `serve` 命令初始化；密码/MFA 仍只进入 Garmin 页面。每增加
一个进程或账号，都以不同名称注册服务器并提供另一个
独立初始化的 session 文件；不要复制其他进程的 session。
这些服务器可以复用同一个 FIT 父目录。

如果只希望当前项目使用，把 `--scope user` 改为 `--scope local`。以后每次启动
Claude Code 时都要保证这些路径变量可用，然后检查连接：

```bash
claude mcp get garmin-connect
claude mcp list
```

在 Claude Code 内输入 `/mcp` 可以查看连接状态和工具。作用域与 `.mcp.json` 的更多
说明见 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/zh-CN/mcp)。
不要把个人 Garmin 凭据提交到项目级配置。

### 在 Codex 或 Claude Code 中实际使用

当 `garmin-connect` 显示已连接后，直接用自然语言提问即可，客户端会自动选择 MCP
工具。如果工具选择不明确，可以明确说“使用 garmin-connect MCP 服务器”。例如：

- “使用 garmin-connect 查看我最近五次跑步。”
- “对比我最近七天的睡眠和静息心率。”
- “把 activity 123456789 的 FIT 下载到我配置的 Garmin FIT 父目录下。”
- “预览一个门槛跑训练，把步骤展示给我；在我确认前不要创建。”

创建训练仍然执行强制的两次调用确认流程：第一次只返回预览；只有用户批准并带上返回的
一次性 `confirmationId` 后，第二次调用才会创建。

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`（macOS）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）：

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "你的佳明邮箱",
        "GARMIN_REGION": "cn",
        "GARMIN_ACCOUNT": "personal-cn",
        "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
        "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
      }
    }
  }
}
```

重启 Claude Desktop 后，你会看到 🔌 图标表示工具已加载。试试说：*"帮我看下最近 5 次跑步记录"* 或 *"帮我预览一个门槛跑训练"*。

### Cursor

把上方相同的 `mcpServers.garmin-connect` 对象写入工作区
`.cursor/mcp.json`，并使用 `lib/mcp.js` 的绝对路径。

### Windsurf

打开 **Windsurf Settings → Cascade → MCP Servers**，或编辑
`~/.codeium/windsurf/mcp_config.json`，加入上方相同的
`mcpServers.garmin-connect` 对象。

### WorkBuddy

WorkBuddy 桌面端支持用户级和项目级的本地 MCP。Garmin 属于个人健康数据，推荐使用
用户级 `~/.workbuddy/mcp.json`。打开 **插件 → MCP 服务器 → 配置 MCP**，或直接编辑
该文件，加入：

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
      "env": {
        "GARMIN_USERNAME": "你的佳明邮箱",
        "GARMIN_REGION": "cn",
        "GARMIN_ACCOUNT": "personal-cn",
        "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
        "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
      }
    }
  }
}
```

macOS/Linux 用 `command -v node`、Windows 用 `where node` 查找 Node.js 的绝对
路径；GUI 应用不一定继承 `nvm` 的 shell 路径。Windows JSON 路径请使用
`C:/.../node.exe` 形式，或把每个反斜杠写成 `\\`。WorkBuddy 的本地命令格式不要
添加 `type`。保存后确认服务器状态变绿，再从只读查询开始测试。参见
[WorkBuddy 官方 MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)。

这里的 session 文件必须独立初始化；客户端若未显示 URL elicitation，就使用可信终端
`serve` 命令。WorkBuddy 与模型不会接收密码/MFA 验证码。每增加一个账号，就新增一个
命名的 `mcpServers` 条目，并使用独立的
session 文件；多个条目可共享同一个 FIT 父目录，“区域+邮箱”账号子目录会自动生成。

#### 随包附带的技能

从 **0.1.7** 起，npm 包内附带 `skills/garmin-connect/`。将这个完整目录复制到
`~/.workbuddy/skills/garmin-connect/`，保留其中的 `references/`。如果已安装该技能，
也需要同步更新已安装副本；仅升级 npm 包不会自动更新技能。重新加载 WorkBuddy 的
技能与 MCP 服务，再新开会话使用。

技能可按用户请求调用 `create_garmin_workout`，先预览训练，经用户确认后创建。
使用 `download_garmin_activity_fit` 下载指定活动时，需在 MCP 服务的 `env` 中设置
`GARMIN_FIT_DOWNLOAD_DIR`，值为可信本地父目录的绝对路径。完整配置步骤见随包附带的
`references/workbuddy-setup.md`。

### ZCode

打开 **设置 → MCP 服务器 → 新建 MCP 服务器**，选择**用户**作用域和 `stdio`，填写
同样的 Node.js 绝对路径、`lib/mcp.js` 参数及 Garmin 环境变量。也可以直接编辑用户级
原生配置 `~/.zcode/cli/config.json`：

若要直接从 npm 验证本正式版，把 command 设为 `npx` 的绝对路径，并使用下列
参数代替本地 checkout 的 `lib/mcp.js`：

```text
-y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

不要配置 `GARMIN_PASSWORD`；在 session 缺失时，第一次只读工具调用即可验证 ZCode
的 URL elicitation 链路。请保留下方显式的 owner-only `GARMIN_SESSION_TOKEN_FILE`。

```json
{
  "mcp": {
    "servers": {
      "garmin-connect": {
        "command": "/absolute/path/to/node",
        "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
        "env": {
          "GARMIN_USERNAME": "你的佳明邮箱",
          "GARMIN_REGION": "cn",
          "GARMIN_ACCOUNT": "personal-cn",
          "GARMIN_SESSION_TOKEN_FILE": "/absolute/path/to/personal.session.json",
          "GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-parent"
        }
      }
    }
  }
}
```

ZCode 也可以导入已有的 Codex 或 Claude Code MCP 配置。它兼容使用 `mcpServers`
结构的 `~/.agents/mcp.json`，但同一作用域的 `.zcode` 配置只要包含任意 MCP 服务，
ZCode 就会整体跳过该 `.agents` 文件，而不是合并。参见
[ZCode 官方 MCP 指南](https://zcode.z.ai/cn/docs/mcp-services)。

这里的 session 文件必须独立初始化；客户端若未显示 URL elicitation，就使用可信终端
`serve` 命令。ZCode 与模型不会接收密码/MFA 验证码。每增加一个账号，就新增一个命名
服务器，并使用独立的 session 文件；多个
服务器可共享同一个 FIT 父目录，“区域+邮箱”账号子目录会自动生成。

以上配置已与两款客户端公布的 schema 核对，但尚未记录使用真实 Garmin 账号完成的
WorkBuddy/ZCode 端到端冒烟测试。

Claude Desktop、Cursor、Windsurf、WorkBuddy 与 ZCode 的 JSON 示例会保存敏感的
session 文件路径，但不会保存 session 内容、密码或 MFA 验证码。请限制配置文件权限，
且不要提交它们。上面的 Codex 与 Claude Code 示例只转发路径变量。MCP 结果可能把睡眠、
心率、体重、运动及位置数据送入所选模型的上下文；请检查客户端的数据处理设置。运动详情
默认使用 `full`，可能包含精确路线/位置；如需减少输出，可在单次调用中选择 `compact`，
或设置 `GARMIN_ACTIVITY_DETAIL=compact`。FIT 二进制与完整本地/账号路径
仍留在 MCP 主机；只有活动 ID、文件名、大小和 hash 会进入模型上下文。请按自己配置的
父目录和文档中的账号目录规则定位文件。

使用 npm `0.1.5` 或之后版本时，可以把本地的 `node …/lib/mcp.js` 替换为：

```bash
npx -y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

### 手动运行

```bash
# 运行 MCP 服务器（stdio）；账号 session 路径会被懒推导。
GARMIN_USERNAME=xxx \
GARMIN_ACCOUNT=personal-cn \
GARMIN_REGION=cn \
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent \
node lib/mcp.js
```

MCP 服务器通过标准协议暴露与 dsh 插件**相同的 10 个工具及参数语义**：运动记录、
睡眠、步数、心率、体重、训练库模板、个人资料、跑步技能、本地 FIT 下载，以及训练
预览/创建。任何 AI 可调用工具都不接收密码/MFA，也不导出 Session Token；浏览器认证
通过对话之外的本机 URL elicitation 完成，完成后由用户重试原工具。

---

## 架构概览

```
┌─────────────────────────────────────────┐
│         DeepSeek Harness (dsh)          │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │     dsh-plugin-garmin-connect     │  │
│  │                                   │  │
│  │  ┌─────────┐    ┌─────────────┐  │  │
│  │  │  配置    │───▶│ Garmin 客户端│  │  │
│  │  │ (Schema) │    │  (含缓存)   │  │  │
│  │  └─────────┘    └──────┬──────┘  │  │
│  │                        │         │  │
│  │  ┌─────────────────────▼───────┐ │  │
│  │  │      工具注册中心 (10)     │ │  │
│  │  │  • get_garmin_activities    │ │  │
│  │  │  • get_garmin_sleep         │ │  │
│  │  │  • get_garmin_steps         │ │  │
│  │  │  • get_garmin_heart_rate    │ │  │
│  │  │  • get_garmin_weight        │ │  │
│  │  │  • get_garmin_workouts      │ │  │
│  │  │  • get_garmin_profile       │ │  │
│  │  │  • get_running_skill_advice │ │  │
│  │  │  • 下载活动 FIT              │ │  │
│  │  │  • create_garmin_workout    │ │  │
│  │  └─────────────────────────────┘ │  │
│  └───────────────────────────────────┘  │
│               Cordis 运行时              │
└────────────────┬────────────────────────┘
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
connect.garmin.com    MCP Server (stdio)
connect.garmin.cn     → Claude Desktop / Claude Code /
                        Codex / Cursor / Windsurf /
                        WorkBuddy / ZCode
```

### 两步验证登录目标架构

这套架构让 dsh Web、MCP 客户端和命令行共用同一个本机认证 runtime，同时把
Garmin 凭据与 AI 对话彻底分开：

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Harness 设置页   │  │ MCP 工具调用     │  │ CLI serve        │
│ 账号卡片内登录   │  │ URL elicitation  │  │ 系统默认浏览器   │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
          LocalAuthBroker + EmbeddedAuthController
                               │
                               ▼
          随机 127.0.0.1 一次性桥页
          flowId + CSRF + 严格 CSP + 10 分钟有效期
                               │ 嵌入与区域严格匹配的页面
                               ▼
          Garmin 官方 GAuth iframe（cn / global）
          Garmin 登录表单字段留在这里
                               │
                               │ 一次性 ticket + 原始精确 service
                               ▼
          Host 校验 origin / iframe / CSRF / ticket / service
                               │
                               ▼
          对应区域 DI 交换 → profile 探测 → 用户确认账号
                               │
                               ▼
          owner-only DI v2 session 原子落盘
          绑定账号、区域和 profile；不在进程间共享
                               │
                               ▼
          GarminClient 热加载 / 安全刷新
                               │
                               ▼
          用户显式重试原来的工具调用
```

关键约束如下：

- 认证期间，dsh 外层页面会收到本机一次性 URL 和粗粒度进度；独立的本机插件配置
  表单处理用户输入的账号邮箱。MCP 客户端和模型只会收到 URL、完成通知或不含
  敏感数据的粗粒度状态；ticket、DI token、session 内容和 session 路径不会进入
  模型上下文或 AI 工具参数/结果。
- bridge 只接受预期 Garmin SSO origin、对应 iframe window、CSRF 和严格匹配的
  `ticket/service`。一次性 ticket 不改写 service、不跟随重定向，也不做后备重试。
- 写入 session 前先探测 Garmin profile，并由用户确认账号；随后以私有权限原子
  写入。运行中的客户端只热加载内容已变化、账号匹配且验证通过的 session。
- 认证完成后不自动重放原工具，避免 FIT 下载或创建训练等写操作重复执行。失败、
  取消或超时会结束当前 flow；再次认证必须创建新的 flow。
- refresh 只允许为安全的 GET 请求最多重放一次；刷新后先复核同一 profile 并
  持久化轮换后的 token，写请求绝不因刷新而自动重放。

> [!NOTE]
> 这是目标架构，也是当前正式支持的实现所遵循的边界。真实中国区 MFA → 精确
> ticket/service → DI 交换 → profile 确认 → 私有 session 落盘 → 新客户端只读查询
> 已在本机验证；国际区真实 MFA → DI 交换 → profile 确认 → 私有 session 落盘也已通过。
> 真实 refresh-token 轮换以及更多 MCP 客户端的完整 URL elicitation 体验仍属于持续
> 兼容性覆盖。它仅支持同机 loopback，不是远程、多用户或托管认证服务。

---

## 开发

```bash
# 克隆仓库
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm install

# 编译
npm run build

# 监听模式
npm run dev

# 运行测试
npm test
```

### 目录结构

```
src/
├── index.ts          # 插件入口（Cordis apply 函数）
├── config.ts         # 配置 Schema（schemastery），支持环境变量自动解析
├── client.ts         # Garmin API 封装，含缓存层
├── account-session.ts # 按账号别名推导 session 落盘位置
├── auth.ts           # 私有 SSO 认证流程与本地 MFA 回调
├── auth-cli.ts       # 可信本地 CLI：serve 与旧版诊断命令
├── browser-auth-canary.ts # 隔离 Chrome DI 初始化/canary 核心
├── embedded-auth-runtime.ts # Web/CLI/MCP 共用 ticket-to-session runtime
├── local-auth-broker.ts # 一次性 loopback/系统浏览器 broker
├── di-session.ts     # DI 运行时校验、刷新与安全 GET 重放
├── session-store.ts  # 严格读取 session 文件并原子私有写入
├── darwin-private-acl.ts # Darwin 扩展 ACL 校验
├── windows-private-acl.ts # Windows 当前用户 SID/DACL 私有化
├── fit-export.ts     # 从原始 ZIP 限量、无覆盖地提取 FIT
├── tool-service.ts   # dsh 与 MCP 共用的工具行为
├── mcp.ts            # 独立 MCP 适配器（用于 Codex/Claude Code 等客户端）
├── mcp-auth.ts       # URL elicitation、完成通知与回退说明
├── mcp-shutdown.ts   # MCP 认证的有界 stdio/信号清理
├── knowledge/
│   ├── running-skills.ts  # 8 种课型 + 4 套精简训练理念
│   └── workout-schema.ts  # 训练定义 → Garmin JSON 构建器
├── tools/
│   └── index.ts      # 工具定义与注册（10 个工具）
└── utils/
    ├── errors.ts      # 安全错误输出与上游日志脱敏
    ├── cache.ts       # 内存 TTL/LRU 缓存与 single-flight 刷新
    ├── date.ts        # 本地日历日期解析
    ├── path.ts        # FIT 父目录展开与绝对路径解析
    └── format.ts      # 原始数据 → LLM 友好格式转换器
```

---

## 发布与分发

本包是一个标准的 dsh bundle:`package.json` 声明了 `dsh.bundle.patch` → `cordis.patch.yml`,`files` 会带上编译后的 `lib/`、`.env.example`、中英 README 和 patch 文件。

```bash
npm run build   # prepublishOnly 也会自动执行
npm publish --registry=https://registry.npmjs.org/ --access public
```

发布后,用户只需一条命令即可安装:

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add dsh-plugin-garmin-connect
```

分发说明:

- **npm registry(推荐)** — 包内自带编译好的 `lib/`,安装时无需任何构建授权。
- **本地源码** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add .` 会链接源码目录,先执行 `npm install`。
- **GitHub 安装** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>` 拉取源码并执行包的 `prepare` 脚本，使用本地安装的 TypeScript 编译器构建；pnpm ≥ 10 默认拒绝执行构建脚本，`dsh` 会打印需要在 profile 的 `pnpm-workspace.yaml` 中填写的 `allowBuilds` 键。
- 给 GitHub 仓库加上 `dsh-plugin` topic,方便用户发现。

---

## 路线图

- [x] **身体成分** — 体重、BMI、体脂率
- [x] **训练库** — 查询可复用的 Garmin 训练模板
- [x] **创建训练** — 安全预览并创建训练库条目
- [x] **MCP 服务器** — 支持 Codex、Claude Code/Desktop、Cursor、Windsurf、WorkBuddy、ZCode
- [x] **跑步教练** — 8 种课型、4 套训练理念与强制个性化问询
- [x] **浏览器 MFA 初始化** — 已通过 dsh 本机网页、系统浏览器 `serve` 与 MCP URL elicitation 正式支持中国区和国际区账号；两区真实 MFA 均已通过，并持续扩展兼容性测试
- [x] **进程隔离多账号** — 每个 dsh/MCP 进程使用单独初始化的 session 文件；不支持并发共享文件
- [x] **FIT 下载** — 从原始归档安全提取一个 FIT 到用户所选父目录下自动生成的“区域+规范化邮箱”子目录
- [ ] **训练状态** — VO2 Max、训练负荷、恢复时间
- [ ] **单进程账号注册表** — 每个账号别名使用独立的客户端、缓存、限流器和已绑定 session
  - [ ] `list_garmin_accounts` — 只列出别名、区域和连接状态，不暴露邮箱、Token 或 session 路径
  - [ ] 为所有账号相关工具增加可选 `account` 参数；没有安全选择时要求显式别名
  - [ ] `use_garmin_account` — 在 dsh 能提供可信对话标识时，为当前对话选择账号
  - [ ] 否则由模型在每次工具调用中继续传入别名；永不使用进程全局“当前账号”
  - [ ] 在宣称多租户隔离前，增加按用户的账号访问白名单
- [ ] **多账号活动同步** — 在中国区和国际版账号之间按一个明确方向复制活动
  - [ ] 上传前预览源账号、目标账号、日期范围、候选活动、重复项及隐私影响
  - [ ] 将短期、一次性确认绑定到确切的账号对和不可变活动清单
  - [ ] 在私有临时目录中暂存并验证 FIT，只上传一次到显式选择的目标；永不删除源活动
  - [ ] 持久化同步 ledger，用于精确去重、重启恢复和上传结果未知处理；超时 POST 永不盲目重试
  - [ ] 增加有上限的批量任务及 `status`、`pause`、`resume`
  - [ ] 增加显式开启的单向轮询同步；dsh 运行时定期检查，重启后补查
  - [ ] 首版不做双向同步、自动删除或 Garmin 全量元数据镜像
- [ ] **Webhook 推送** — 活动上传实时通知
- [ ] **OAuth 2.0** — 等待 Garmin 开放个人用途的官方 API 后迁移

---

## 许可证

[MIT](LICENSE)

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — AI 代理编码运行时
- [Cordis](https://github.com/cordiverse/cordis) — 插件生命周期框架
- [garmin-connect](https://www.npmjs.com/package/garmin-connect) — 非官方 Garmin Connect Node.js 客户端
- 感谢 Zhitao 的 [DailySync](https://dailysync.cn) 所带来的启发

<sub>产品名称和图标归各自权利人所有，仅用于说明互操作兼容性。</sub>
