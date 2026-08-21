# dsh-plugin-garmin-connect

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Garmin Connect 插件 — 让 AI 代理直接读取你的运动和健康数据。

[![npm version](https://img.shields.io/npm/v/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-garmin-connect.svg?logo=npm)](https://www.npmjs.com/package/dsh-plugin-garmin-connect)
[![CI](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/actions/workflows/ci.yml)
[![测试报告](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95%E6%8A%A5%E5%91%8A-%E6%9F%A5%E7%9C%8B-blue.svg)](TEST_REPORT.zh-CN.md)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**[English](README.md)** | 中文 | **[测试报告](TEST_REPORT.zh-CN.md)**

---

## 我的更多应用

| 图标 | 应用 | 一句话介绍 |
|---|---|---|
| [<img src="https://gamerasnap.com/static/images/appicon.png" width="32" height="32" alt="GameraSnap" />](https://gamerasnap.com) | [GameraSnap](https://gamerasnap.com) | 用佳明手表远程控制手机拍照/录像 |
| [<img src="https://wristalbum.wristtale.com/app-icon.svg" width="32" height="32" alt="WristAlbum" />](https://wristalbum.wristtale.com) | [WristAlbum](https://wristalbum.wristtale.com) | 在佳明手表上保存私人照片相册 |
| [<img src="https://wristtale.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristTale" />](https://wristtale.com) | [WristTale](https://wristtale.com) | 在手表上阅读 TXT 和 Markdown 电子书 |
| [<img src="https://wristpass.li2niu.com/static/favicons/apple-touch-icon.png" width="32" height="32" alt="WristPass" />](https://wristpass.li2niu.com) | [WristPass](https://wristpass.li2niu.com) | 把会员卡、票券装进手腕,随时出示 |
| [<img src="https://2fa4g.li2niu.com/static/branding/app-icon.png" width="32" height="32" alt="2FA4G" />](https://2fa4g.li2niu.com) | [2FA4G](https://2fa4g.li2niu.com) | 在佳明手表上保存离线两步验证码 |
| [<img src="https://jiake.app/app-icon.png" width="32" height="32" alt="JiaKe.app" />](https://jiake.app) | [JiaKe.app](https://jiake.app) | 把 Garmin 截图做成精美宣传图 |

---

## 这个插件做什么？

安装本插件后，DeepSeek Harness 的 AI 代理可以通过自然语言**自动调用** Garmin Connect 数据。你只需要说一句话，比如：

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
| `get_garmin_activities` | 获取近期运动记录，可选择精简或完整详情 | `{"limit": 5, "detail": "compact"}` |
| `get_garmin_sleep` | 获取指定日期或日期范围的睡眠评分、时长与阶段分布 | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_steps` | 获取指定日期或日期范围的步数；仅当 Garmin 上游提供时才包含目标与步行距离 | `{"startDate": "2023-10-01"}` |
| `get_garmin_heart_rate` | 查询指定日期或日期范围的静息、最高与最低心率 | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight`     | 查询指定日期或日期范围的身体成分（体重、BMI、体脂率、骨骼肌等） | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts`   | 查询 Garmin 训练库中的可复用训练模板（不是日历排期） | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile`    | 获取经过字段白名单过滤的个人资料摘要 | `{}` 或省略 |
| `get_running_skill_advice` | 讲解 8 种课型与 4 套训练理念，或先完成必问信息再提供个性化建议 | `{"mode": "explain", "query": "丹尼尔斯", "language": "zh-CN"}` |
| `download_garmin_activity_fit` | 下载活动的原始归档，并把其中唯一的 FIT 文件安全提取到所配置父目录下的账号目录 | `{"activityId": 123456789}` |
| `create_garmin_workout` | 预览结构化训练；仅在显式确认后创建 | `{"name": "门槛巡航3×8分钟", "steps": [...]}` |

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
适用限制见[训练方法研究说明](docs/research/running-training-methods.md)。
每条训练理念和课型卡还会把相应内容标成 `system_principle`（体系理念）、
`research_evidence`（研究证据）或 `application_inference`（应用推断），避免把
方法定义误写成优越性证据。

---

## 快速开始

> **测试当前未发布源码：** `Unreleased` 中的加固改动尚未发布，也没有提升版本号。
> 如需测试这些改动，请使用下方“本地源码调试”方式；registry 命令安装的仍是已发布的
> `0.1.4`。

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

### 3. 配置凭据

插件自身不会持久化凭据。请使用环境变量（或启动器提供的密钥存储），并确保
`.env` 不进入版本控制。

```bash
# 仅源码目录：复制随仓库提供的模板
cp .env.example .env

# 编辑 .env，填入你的 Garmin 账号信息
```

如果使用 registry 安装，请直接在运行 `dsh` 的目录（工作区根目录）新建 `.env`，
再按下表填写变量；包内模板不会出现在当前工作目录。插件启动时会自动加载该文件。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Garmin 账号邮箱 |
| `GARMIN_PASSWORD` | ✅* | 旧版直接登录密码；不要用于下方的 MFA 交互式初始化 |
| `GARMIN_SESSION_TOKEN` | ✅* | 内联预认证令牌（仍支持，但 session 文件更安全） |
| `GARMIN_SESSION_TOKEN_FILE` | ✅* | 本地认证命令生成的 owner-only DI v2（或兼容的旧 OAuth）session 文件路径 |
| `GARMIN_REGION` | ❌ | `global`（默认，国际版）或 `cn`（佳明中国） |
| `GARMIN_FIT_DOWNLOAD_DIR` | 仅 FIT | 用户为 FIT 导出显式选择的主机父目录；无默认值，生成的账号目录会包含 `GARMIN_REGION` |
| `GARMIN_CACHE_TTL` | ❌ | 缓存有效期，单位秒（默认 `300`） |
| `GARMIN_REQUEST_TIMEOUT_MS` | ❌ | Garmin 请求超时，单位毫秒（默认 `15000`） |
| `GARMIN_LOG_LEVEL` | ❌ | 日志级别：`debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `compact`（默认）或 `full`（扩展运动数据，可能包含精确路线/位置；凭据及账号/社交标识会被过滤） |

> \* `GARMIN_PASSWORD`、`GARMIN_SESSION_TOKEN`、`GARMIN_SESSION_TOKEN_FILE`
> 三选一即可。MFA 和多账号场景推荐 session 文件。如果同时配置，内联 token
> 优先于文件；有效 session 优先于密码登录。
>
> ⚠️ 如果密码包含 `#` 等特殊符号，请用**双引号**包裹，否则 `#` 后的内容会被当作注释截断：
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```
>
> `GARMIN_SESSION_TOKEN` 与 `GARMIN_SESSION_TOKEN_FILE` 的内容都和密码一样敏感。
> Token 导出不会作为 AI 可调用工具提供，也绝不要把 Token 粘贴进 AI 对话。

#### 开启两步验证的账号（当前未发布源码）

请在可信的本地终端中亲自执行推荐的浏览器认证，并显式选择账号所属区域：

```bash
# Garmin 国际区
npm run auth:setup -- --browser --account personal --region global

# 佳明中国区
npm run auth:setup -- --browser --account personal --region cn
```

`auth:setup` 只是源码仓库中的 npm script 别名。安装包对外稳定的系统命令名是
`garmin-connect-auth`，因此 Codex、Claude Code（CC）及其他本地客户端都可以引导用户
使用同一个认证入口：

```bash
garmin-connect-auth --help
garmin-connect-auth login --browser --account personal --region global
garmin-connect-auth login --browser --account personal --region cn
```

直接运行裸命令的前提是 npm 可执行文件已进入 `PATH`，通常需要全局安装；
dsh 的嵌套依赖或普通本地依赖不会自动暴露这个系统命令。如需在当前源码上测试系统
命令，可先在仓库目录中显式执行 `npm install -g .`。未来包含该命令的版本发布后，
可全局安装该版本，或在用户自己的终端中按以下格式运行，并替换
`PUBLISHED_VERSION`：

```bash
npx -y --package dsh-plugin-garmin-connect@PUBLISHED_VERSION \
  garmin-connect-auth login --browser --account personal --region global
```

当前 npm registry 上的 `0.1.4` 早于这个可执行命令；在后续包含该命令的预发布版或
正式版安装前，请继续使用上方源码方式
`npm run auth:setup -- --browser ...`。无论使用哪种入口，命令都会打开隔离、可见的系统
Google Chrome。邮箱、密码、MFA 验证码和 CAPTCHA 只能在 Garmin 页面中输入；CLI
不会读取这些表单值，也不接受通过命令行参数、环境变量、MCP 工具参数或模型输入传入。

浏览器关闭后，CLI 会交换短期 service ticket，并探测与区域绑定的 Garmin DI profile
接口。随后本地终端会并列显示经过安全化处理的 Garmin profile label、请求的账号别名和
配置的 username。只有确认它们属于目标账号时才键入完全一致的 `yes`；其他任何输入都
会取消写入。确认成功后才会写入 owner-only 的 DI v2 session 并输出路径。Codex、
Claude Code、模型及其他代理不得读取或复制 session 内容或凭据。

为兼容旧用法，省略 `--browser` 的终端认证流程仍然保留；它在本地终端中隐藏密码/MFA
输入，但不能处理 CAPTCHA 等仅浏览器挑战，因此不再是 MFA 的推荐方式。

如需诊断同一套浏览器/DI 链路，但不希望生成凭据，当前源码还保留一个明确“不落盘”
的实验命令：

```bash
# 必须显式选择账号所属区域。
npm run auth:canary -- --region global
npm run auth:canary -- --region cn
```

该 canary 会打开隔离、可见的系统 Google Chrome 窗口。邮箱、密码、MFA 或 CAPTCHA
只在 Garmin 页面中输入，CLI 不读取这些表单值。程序只捕获一张短期 service ticket，
随后立即关闭临时浏览器，再执行一次严格绑定区域的 DI token 交换并验证 profile API；
不会保存 Cookie、Token、截图、trace、视频、HAR 或 session 文件。因此 canary 通过
只代表登录链路可用。需要为 dsh/MCP 创建 session 时，请使用
`auth:setup -- --browser ...`，而不是 canary。

Canary 需要系统 Google Chrome，以及普通依赖安装时提供的可选 `playwright-core` 驱动。
如果安装依赖时使用了 `--omit=optional`，canary 将不可用，但普通登录、dsh 和 MCP
运行不受影响。

浏览器认证及显式 profile 确认成功后，命令只保存 DI v2 session 并输出文件路径；
POSIX 上 session 文件权限为仅文件所有者可读写的 `0600`；Windows 上使用当前用户配置
目录，但尚未显式校验 Windows ACL。它不会保存密码或 MFA 验证码。运行时使用该路径
并删除 `GARMIN_PASSWORD`：

```dotenv
GARMIN_USERNAME=your-email@example.com
GARMIN_REGION=cn
GARMIN_SESSION_TOKEN_FILE=/absolute/path/to/personal.session.json
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent
```

DI v2 文件会通过不可逆摘要绑定规范化 username、region，以及刚探测到的 Garmin
profile（包括 `profileIdHash`）；绑定信息不会重复保存明文邮箱。运行时会在发布刷新后的
凭据前拒绝 username、region 或 profile 不匹配的文件。access token 会在到期前提前刷新，
轮换后的 refresh token 会先安全写回再投入使用；认证失败时只允许幂等 GET 最多重放一次，
训练创建等写请求绝不会自动重放。

为保持向后兼容，只有 `oauth1`、`oauth2` 两个字段的旧 session 文件仍可读取。旧文件
没有可校验的 profile 绑定；条件允许时建议重新运行
`auth:setup -- --browser ...`，获得 DI v2 的错账号保护。在 POSIX 系统中，旧文件本身
仍须通过当前 owner-only 文件权限检查（通常为 `0600`）。

POSIX 上默认账号目录会以 owner-only 权限创建。如需自定义 session 文件，可添加
`--output /absolute/private/path/personal.session.json`。在 POSIX 系统中，已经存在的父目录
不能授予 group/other 任何权限（通常为 `0700`）；不存在的父目录会以 owner-only 权限
创建。遇到不安全父目录时命令会拒绝写入，不会擅自放宽或修改其权限。

MFA 初始化依赖 Garmin 私有 SSO/DI 流程，当前仍属于实验能力。2026-08-21 已用真实
中国区账号验证“浏览器 MFA → DI exchange → profile probe”链路；把 session 持久化后再
通过运行时使用的端到端链路，仍需用户再次明确授权浏览器验证；国际区浏览器链路尚未
验证。在这些检查完成前，请继续保持未发布状态。

#### 多账号：每个账号使用独立进程

当前支持的模型是“每账号每进程隔离”：每个 dsh、Codex、Claude Code 或其他 MCP
进程都要单独执行一次浏览器认证，并使用不同的 `--account` 别名；必要时再通过不同的
`--output` 指定独立文件。每个进程分别设置自己的 `GARMIN_USERNAME`、`GARMIN_REGION`
和 `GARMIN_SESSION_TOKEN_FILE`。

不要把一个 session 文件复制给其他进程，也不要让并发进程共享同一文件。Garmin 的
refresh token 可能轮换，否则并发写入可能互相覆盖或使凭据失效。例如分别使用
`personal-dsh`、`personal-codex`、`personal-claude` 别名，并为每个进程重新完成浏览器
认证。请使用初始化命令打印的直接路径；不要通过符号链接或大小写不同的路径别名，让另一
运行时指向同一个物理文件。

多个进程可以共享同一个 `GARMIN_FIT_DOWNLOAD_DIR` 父目录，插件会按各自配置的区域和邮箱
自动建立独立账号子目录，因此同一邮箱的 `cn` 与 `global` 账号也不会冲突。例如把两个服务器命名为 `garmin-personal` 和
`garmin-family`，调用时明确选择目标服务器。

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
1. 插件配置值（profile patch / --patch 中为该插件行指定的 config）
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
| 浏览器 MFA 初始化只保存经确认的 DI v2 session（POSIX 为 `0600`） | ✅（实验性 DI） |
| DI v2 session 绑定 username、region 与 `profileIdHash`；旧两字段 session 保持兼容 | ✅ |
| 每进程独立初始化的 session 文件支持进程隔离多账号 | ✅ |
| access token 提前刷新；幂等 GET 最多重放一次，写请求不重放 | ✅ |
| 工具返回值中不包含任何原始凭据 | ✅ |
| FIT 二进制及本地/账号路径留在主机，模型只收到活动 ID、文件名、大小与 hash | ✅ |
| 内存缓存减少 API 调用次数，防止触发 Garmin 限流 | ✅ |

### Session Token

仍然支持 Session Token 登录，但 Token 本身就是凭据，不能出现在代理输出或轨迹日志中。
因此，本插件不会把认证、MFA 提交或 Token 导出暴露为 AI 可调用工具。请使用上方本地
浏览器 `auth:setup` 命令，再由 dsh/MCP 通过 `GARMIN_SESSION_TOKEN_FILE` 读取 owner-only
DI v2 文件；运行时不再需要账号密码。文件会绑定规范化 username、region 和
`profileIdHash`；为兼容旧版本，无绑定的 `oauth1`/`oauth2` 两字段文件仍可读取。Garmin
refresh token 可能轮换，因此 dsh、Codex、Claude Code 或其他进程之间不得并发共享或
复制同一 session 文件。

---

## 在其他 AI 编程助手中使用（MCP 协议）

本插件同时提供了一个独立的 **MCP (Model Context Protocol) 服务器**，让你可以在 OpenAI Codex、Claude Code、Claude Desktop、Cursor、Windsurf、WorkBuddy、ZCode 等任何支持 MCP 的客户端中使用相同的 Garmin 工具 — **无需安装 DeepSeek Harness**。

> **当前可用性：** npm `0.1.4` 早于 MCP 入口加入。新的 MCP 版本发布前，
> 请使用本地源码；下文 registry `npx` 命令明确仅供未来发布后使用。

先构建本地服务器：

```bash
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm install
npm run build
```

请把示例中的 `/absolute/path/to/garmin-connect-plugin-for-dsh` 替换为本地源码目录的
真实绝对路径。

MFA 账号请先完成上方的本地浏览器 `auth:setup`。随后只需让客户端进程获得非密码的账号/
区域信息，以及 session 文件路径与 FIT 父目录。下面的占位路径替换为本机绝对路径后，
同样适用于 Codex、Claude Code、WorkBuddy 和 ZCode：

```bash
export GARMIN_USERNAME='你的佳明邮箱'
export GARMIN_REGION='cn'
export GARMIN_SESSION_TOKEN_FILE='/absolute/path/to/personal.session.json'
export GARMIN_FIT_DOWNLOAD_DIR='/absolute/path/to/garmin-fit-parent'
```

不要在这些环境变量中放密码或 MFA 验证码。MCP 服务器不会提示 MFA，而是直接读取已确认
的 DI v2 session。session 文件和 FIT 父目录都需要保护，因为活动文件可能包含精确位置与
健康数据。每个同时运行的客户端进程都需要单独初始化的 session 文件；Codex、
Claude Code、dsh 或其他客户端之间不得复制或并发共享同一文件。

### OpenAI Codex（桌面端、CLI 与 IDE 扩展）

同一主机上的 Codex 客户端共用 `~/.codex/config.toml`。推荐只在配置中声明需要转发的
环境变量名，不把凭据值复制到 TOML。确保 Codex 进程能够读取上面的变量后，把以下
内容加入 `~/.codex/config.toml`：

```toml
[mcp_servers.garmin-connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_REGION", "GARMIN_SESSION_TOKEN_FILE", "GARMIN_FIT_DOWNLOAD_DIR"]

# 只读工具可正常运行；写本地文件或 Garmin 数据前由 Codex 请求批准。
default_tools_approval_mode = "writes"
```

此配置只读取专门为该 Codex 进程执行浏览器 `auth:setup` 所生成的 DI v2 session；
Codex 不会接收或询问密码/MFA 验证码。不要复用已经分配给 dsh、Claude Code 或其他
运行中进程的 session。第二个账号请新增 `[mcp_servers.garmin-family]` 等服务器表，并
使用不同的别名/输出文件重新执行浏览器认证。它可以复用同一个 FIT 父目录，输出会自动
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
  '{"type":"stdio","command":"node","args":["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],"env":{"GARMIN_USERNAME":"${GARMIN_USERNAME}","GARMIN_REGION":"${GARMIN_REGION:-global}","GARMIN_SESSION_TOKEN_FILE":"${GARMIN_SESSION_TOKEN_FILE}","GARMIN_FIT_DOWNLOAD_DIR":"${GARMIN_FIT_DOWNLOAD_DIR}"}}'
```

该服务器只读取专门为此 Claude Code 进程执行本地浏览器认证生成的 DI v2 session；
Claude Code 不会接收或询问密码/MFA 验证码。每增加一个进程或账号，都以不同名称注册
服务器，并用不同的别名/输出文件重新完成浏览器认证；不要复制其他进程的 session。
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

这里的 session 文件必须由单独一次浏览器 `auth:setup` 流程生成；WorkBuddy 不会接收密码/
MFA 验证码。每增加一个账号，就新增一个命名的 `mcpServers` 条目，并使用独立的
session 文件；多个条目可共享同一个 FIT 父目录，“区域+邮箱”账号子目录会自动生成。

### ZCode

打开 **设置 → MCP 服务器 → 新建 MCP 服务器**，选择**用户**作用域和 `stdio`，填写
同样的 Node.js 绝对路径、`lib/mcp.js` 参数及 Garmin 环境变量。也可以直接编辑用户级
原生配置 `~/.zcode/cli/config.json`：

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

这里的 session 文件必须由单独一次浏览器 `auth:setup` 流程生成；ZCode 不会接收密码/MFA
验证码。每增加一个账号，就新增一个命名服务器，并使用独立的 session 文件；多个
服务器可共享同一个 FIT 父目录，“区域+邮箱”账号子目录会自动生成。

以上配置已与两款客户端公布的 schema 核对，但尚未记录使用真实 Garmin 账号完成的
WorkBuddy/ZCode 端到端冒烟测试。

Claude Desktop、Cursor、Windsurf、WorkBuddy 与 ZCode 的 JSON 示例会保存敏感的
session 文件路径，但不会保存 session 内容、密码或 MFA 验证码。请限制配置文件权限，
且不要提交它们。上面的 Codex 与 Claude Code 示例只转发路径变量。MCP 结果可能把睡眠、
心率、体重、运动及位置数据送入所选模型的上下文；请检查客户端的数据处理设置，非必要
保持 `compact`，只有确需精确扩展数据时才使用 `full`。FIT 二进制与完整本地/账号路径
仍留在 MCP 主机；只有活动 ID、文件名、大小和 hash 会进入模型上下文。请按自己配置的
父目录和文档中的账号目录规则定位文件。

等包含 MCP 可执行入口的版本发布到 npm 后，可以把本地的 `node …/lib/mcp.js`
替换为：

```bash
npx -y --package dsh-plugin-garmin-connect garmin-connect-mcp
```

### 手动运行

```bash
# 完成浏览器 auth:setup 后，运行 MCP 服务器（标准输入输出）
GARMIN_USERNAME=xxx \
GARMIN_SESSION_TOKEN_FILE=/absolute/path/to/personal.session.json \
GARMIN_FIT_DOWNLOAD_DIR=/absolute/path/to/garmin-fit-parent \
node lib/mcp.js
```

MCP 服务器通过标准协议暴露与 dsh 插件**相同的 10 个工具及参数语义**：运动记录、
睡眠、步数、心率、体重、训练库模板、个人资料、跑步技能、本地 FIT 下载，以及训练
预览/创建。两个 AI 接口均不会提供认证、MFA 提交或 Session Token 导出。

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
├── auth.ts           # 私有 SSO 认证流程与本地 MFA 回调
├── auth-cli.ts       # 可信本地 CLI：浏览器 DI 或旧版终端认证
├── browser-auth-canary.ts # 隔离 Chrome DI 初始化/canary 核心
├── di-session.ts     # DI 运行时校验、刷新与安全 GET 重放
├── session-store.ts  # 严格读取 session 文件并原子私有写入
├── fit-export.ts     # 从原始 ZIP 限量、无覆盖地提取 FIT
├── tool-service.ts   # dsh 与 MCP 共用的工具行为
├── mcp.ts            # 独立 MCP 适配器（用于 Codex/Claude Code 等客户端）
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
npm publish
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
- [x] **浏览器 MFA 初始化（实验性）** — 隔离 Chrome 输入、终端 profile 确认及私有 DI v2 session（POSIX 为 `0600`）；2026-08-21 真实中国区“浏览器 → DI → profile”链路通过，持久化 session/运行时和国际区验证仍待完成
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
