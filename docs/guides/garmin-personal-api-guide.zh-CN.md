# 佳明官方个人数据接入API保姆级指南

作者：李二牛 · 更新于 2026 年 11 月 6 日

佳明终于推出了官方 **Personal API 模式**，还提供了 [Python 版 SDK](https://github.com/garmin/connect-personal-api-python)。我很快参考官方实现移植了 [TypeScript 版本](https://github.com/Likenttt/connect-personal-api-ts)，并接入 [dsh-plugin-garmin-connect](https://github.com/Likenttt/garmin-connect-plugin-for-dsh)，让 DeepSeek Harness 和 MCP 都能使用。**TS 版代码已经开源，欢迎点个 Star。** [SDK 0.1.0 已发布到官方 npm](https://www.npmjs.com/package/@likenttt/connect-personal-api-ts)。

我是李二牛，TypeScript SDK 和插件由我在社区维护，**TS 版并非 Garmin 官方 SDK**。这次是在已有插件中增加官方 Personal API 接入：官网生成 Key，插件换取令牌、读取数据，佳明密码不用交给 AI。插件同时提供 DSH 和 MCP 形态，用户无需另装底层 SDK；项目介绍见 [gc.li2niu.com](https://gc.li2niu.com/)。

**国际版已完成真实读取验证；大陆 Personal API 现也已开放，插件可直接选择中国区接入。** 下面以国际版截图为主，带你申请 Key，再连接 DeepSeek Harness 或其他 Agent。大陆入口与配置方式放在文末；2026-10-22 的历史测试结果见[完整测试报告](../research/personal-api-endpoint-test-report-2026-10-22.md)。

## 一、先弄清它能做什么

Personal API 用于个人读取自己的数据。官方当前公开 26 个 GET 数据接口，覆盖活动、步数、睡眠、心率、HRV、血氧、压力、身体电量等，也能下载原始活动文件。呼吸数据包含日汇总、睡眠等字段，<span style="color: #b42318; font-weight: 600;">暂无独立的完整全天呼吸曲线接口</span>。[官方 FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/) · [接口文档](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)

同一个 `dsh-plugin-garmin-connect` 插件有两种接入方式：

| 比较维度 | 账号密码／Connect 网页会话 | Personal API Key |
|---|---|---|
| 登录输入 | 在 Garmin 官方表单输入账号、密码，按需完成验证码 | 在 Garmin 官网申领 Key，后续由 Key 换取 token |
| 插件配置 | 账号备注、邮箱、区域，再完成网页登录 | 账号备注、地区 + 对应区域生成的 Key |
| 密码处理 | 密码只填 Garmin 官方表单；当前插件设置保存邮箱和会话，不保存密码 | 插件不需要密码；Key 是敏感凭据，保存在本机 |
| 读取范围 | 活动、健康与训练相关数据，以工具和设备实际记录为准 | 官方开放的读取，包括 HRV、血氧、呼吸摘要等 |
| 训练库／日历写操作 | 按已提供工具创建、删除课表或取消排期，需预览确认 | <span style="color: #b42318; font-weight: 600;">暂不支持（Personal API 当前只读）</span> |
| 有效期与撤销 | 会话有效期和刷新由 Garmin 控制；可停用本机账号并清理会话，远端撤销规则以 Garmin 为准 | Key 可选 30／90／180 天或一年；token 最长 24 小时；官网 Delete 撤销 Key 和关联 token |
| MFA | 登录时在 Garmin 官方页完成 | 申领 Key 时按账号要求验证，后续用 Key 获取 token |
| 账号地区 | 原有方式支持中国区和国际区 | 支持中国区 `.cn` 与国际区 `.com`，Key 不跨区使用 |
| 适用场景 | 已有账号继续使用，需要训练库和排期管理 | 希望通过官方个人 API 做数据读取与分析 |

**插件的课表与日历管理能力继续由 Connect 网页会话提供**，写操作仍需预览和确认。Personal 模式当前只读，<span style="color: #b42318; font-weight: 600;">其公开范围也未包含 Webhook</span>。

![Garmin 官方 Personal API 说明](../assets/personal-api-guide/01-official-instructions.png)

*图 1：官方说明列出了申请步骤，以及 API Key 换取令牌的方法。*

## 二、打开国际版密钥页面

在浏览器打开 [国际版 Personal API Key 页面](https://connect.garmin.com/app/settings/personalApiToken)，使用你的**国际版 Garmin 账号**完成登录。也可以从 [Garmin 官方说明](https://developer.garmin.com/gc-developer-program/personal/personal-api/)中的链接进入。

进入后，设置列表中会出现 **Personal API Key**，右侧点击 **Create Key**。

![国际版 Personal API Key 页面](../assets/personal-api-guide/global-01-key-page.png)

*图 2：国际版设置页有正式入口，点击 Create Key 开始申请。*

## 三、阅读条款，先选 30 天

阅读 **Garmin Connect Personal API Supplemental Terms**，确认后点击 **Accept**。这把 Key 用来访问你自己的数据，请为个人使用的程序配置，不要分享给其他人。

![国际版申请条款](../assets/personal-api-guide/global-02-terms.png)

*图 3：国际版条款可以正常显示，阅读后自行决定是否接受。*

下一步选择有效期。官方提供 30 天、90 天、180 天和一年；首次体验建议选 **30 days**，再点击 **Create**。本次国际 Key 的有效期为 2026 年 10 月 22 日至 11 月 21 日。

![国际版选择30天有效期](../assets/personal-api-guide/global-03-validity.png)

*图 4：这里选择 30 days，然后点击 Create。*

## 四、保存 Key，再检查 Active 状态

**完整 API Key 只显示一次。** 创建后先复制并妥善保存，再点击完成；如果丢失，需要删除旧 Key、重新生成。不要把 Key 发给 AI、粘贴到评论区或留在截图里。本文不展示一次性密钥画面。

保存后刷新页面，检查状态是否为 **Active**，以及到期日是否正确。下图是真实刷新后的管理页面，**它显示密钥记录，不显示完整 Key**。

![国际密钥刷新后显示Active](../assets/personal-api-guide/global-04-active-key.png)

*图 5：状态为 Active，到期日为 2026 年 11 月 21 日；需要停止授权时可在这里 Delete。*

## 五、在 DeepSeek Harness 里接入

**以下步骤对应 dsh-plugin-garmin-connect 0.1.21。** 新版通过 Garmin 工作台管理账号，不设固定账号数量上限。macOS 用户先退出 DeepSeek Harness，再使用应用内置 CLI 从官方 npm 安装：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-plugin-garmin-connect@0.1.21 \
  --ignore-scripts --registry=https://registry.npmjs.org/
```

安装后重新打开 Harness。原用户可以保留已有网页会话账号，再新增 Personal 账号。按顺序操作：

1. 打开一个 Harness 会话，点击右下角 **Garmin 工作台**，进入**账号**页。
2. 点击**添加账号**，接入方式选择 **Personal API**，再选择中国区或国际区。
3. 填写**账号备注**，例如“我的佳明中国区”；再填写该区域官网刚生成的 **API Key**。
4. 点击**保存账号**，随后点击**检查连接**；验证成功后即可开始查询。也可使用**检查全部连接**查看所有账号的进度与结果，并随时取消。

**新建 Personal 账号需要地区、账号备注和 API Key。** 不填邮箱或密码，也不需要再次打开佳明登录页。Key 只在本机账号表单中输入，保存后不回填完整内容。切换已有 Personal 账号的地区时，需要同时填写新地区生成的 Key。

账号备注可按自己、家人或其他用途自由填写。Connect 网页会话账号可显示佳明头像；Personal API 未返回头像时显示备注首字。时间线、备注和导出功能可在同一工作台访问。

建议用 **+ 添加账号**保留两种方式。若修改已有账号的接入方式，需要提供新方式的凭据：Personal 填 API Key，网页会话重新完成对应登录。

![真实 Harness 桌面 Personal 账号连接成功](../assets/personal-api-guide/global-06-harness-connected.png)

*图 6：0.1.19 的历史桌面验收截图：保存别名和 Key 后连接成功，重启后仍可验证；0.1.21 的账号入口已迁至 Garmin 工作台。*

### 本机 DSH 怎么验收？

安装并重新加载插件后，依次检查：

1. Personal 账号点击**检查连接**成功，目标账号备注正确。
2. 在对话中指定该账号备注，先查询 profile，再读取有记录日期的单日 HRV；多账号时由 Agent 使用 `list_garmin_accounts` 查找稳定账号 ID。
3. 返回账号编辑表单，确认完整 Key 没有回填。
4. 再明确选择原有网页会话账号查询 profile，核对账号隔离，避免混用数据。

历史验证中，本机从官方 npm 安装 **0.1.19** 后 Personal 连接复核成功。其发布前的 **0.1.19-dev.0** 已在真实 Harness 桌面完成：5 次 Personal 工具读取与 1 次原大陆网页会话读取均成功，重启后的连接验证也通过。HRV 时序与血氧测量值有空缺，呼吸为每日摘要。见[桌面验收报告](../testing/personal-api-harness-desktop-2026-10-22.md)。
具体操作见[本机 DSH／MCP 验证指南](personal-api-local-validation.zh-CN.md)。

### 开发者：安装当前源码版

源码体验者可先构建本地安装包：

```bash
git clone --branch main --single-branch https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd garmin-connect-plugin-for-dsh
npm ci
npm run build
npm pack --ignore-scripts
```

macOS 桌面版先**退出 DeepSeek Harness**，再使用应用内置 CLI 安装到 `desktop` profile。
本机核实的内置 CLI 版本为 **0.2.1-rc.2**。
将下方安装包路径换成生成文件的绝对路径：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add /absolute/path/dsh-plugin-garmin-connect-0.1.21.tgz \
  --ignore-scripts --registry=https://registry.npmjs.org/
```

安装后重新打开桌面版，再进入插件账号设置。`web` 是另一份 profile，不会自动更新桌面
`desktop` 的插件；桌面版体验使用上述内置 CLI。

## 六、其他 Agent：用 MCP 接入

Codex、Claude Code 等支持 stdio MCP 的客户端，运行的是**同一插件包 `dsh-plugin-garmin-connect` 的 `lib/mcp.js`**。0.1.21 推荐使用共享工作区模式，与 Harness 共用账号、时间线和备注：

```bash
npx -y --package dsh-plugin-garmin-connect@0.1.21 garmin-connect-mcp --workspace
```

先启动一次升级后的 Harness 登记既有工作区，再通过 `open_garmin_workspace` 获取管理页入口。SQLite 工作台需要 Node 22.13+；完整配置见[共享本机工作区](../../README.zh-CN.md#共享本机工作区0121)。

下方为继续兼容的**旧版单账号环境变量模式**（仍支持 Node 20）。该模式需分别配置 Harness 与独立 MCP 账号，在 Harness 保存的备注和 Key 不会自动同步过去。

先创建一个仅自己可读的 UTF-8 纯文本文件，**内容只放 API Key，不加引号或 JSON 包装**。macOS／Linux 文件权限设为 `600`，父目录设为 `700`；Windows 使用仅当前用户可访问的权限。这属于文件权限保护，不等于加密。

在客户端的 MCP 配置中添加以下内容，并替换两个绝对路径：

```json
{
  "mcpServers": {
    "garmin-personal": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"],
      "env": {
        "GARMIN_PROVIDER": "personal",
        "GARMIN_ACCOUNT": "my-garmin",
        "GARMIN_ALIAS": "我的佳明国际版",
        "GARMIN_REGION": "global",
        "GARMIN_PERSONAL_API_KEY_FILE": "/absolute/private/path/garmin-personal.key"
      }
    }
  }
}
```

`GARMIN_ALIAS` 是便于辨认的别名，`GARMIN_ACCOUNT` 是稳定的机器 ID；不要把两者当作邮箱。国际 Key 使用 `global`，请求 `personal.connectapi.garmin.com`。也可以通过客户端私密环境注入 `GARMIN_PERSONAL_API_KEY`，但不要把真实 Key 写进可分享的 JSON。此模式无需 `GARMIN_USERNAME`，也无需另外安装 SDK。

保存配置后，重新加载 MCP，确认 Garmin 工具出现，再让 Agent 执行：

**“先读取我的 Garmin 账号资料确认连接，再查看昨天的 HRV、血氧和呼吸摘要；暂时不用制定计划。”**

本次已验证 MCP 的 profile、活动、HRV、血氧、呼吸 5 项读取。呼吸返回的是每日摘要。先用小查询确认账号与日期，再逐步分析趋势；工具存在和读取成功要分别确认。

### 令牌有效期与 SDK 安装

访问令牌最长有效 24 小时，且不超过 Key 的到期时间；过期后用 Key 重新获取，没有 refresh token。[认证 FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/)

底层 [connect-personal-api-ts](https://github.com/Likenttt/connect-personal-api-ts) 专注 Personal Key、token 与数据读取。开发者可从官方 npm 安装已发布的 SDK 0.1.0：

```bash
npm install @likenttt/connect-personal-api-ts@0.1.0
```

**插件用户不必单独安装 SDK。** dsh-plugin-garmin-connect 0.1.19 已集成 Personal API；Harness 和 MCP 均通过同一个插件包使用。

## 七、中国大陆站与端点现状：现已开放

截至 **2026 年 11 月 2 日**，大陆 Personal API 已开放。大陆账号可从 [Personal API Key 页面](https://connect.garmin.cn/app/settings/personalApiToken)创建 Key；在插件中选择“中国区”，会固定请求 `personal.connectapi.garmin.cn`，不会回退到国际端点。以下截图和 HTTP 526 结果记录的是 **2026 年 10 月 22 日的旧状态**。

### 1. 密钥页面能打开，部分文案仍是键名

设置页能加载，但本应显示为标题和按钮的内容，仍出现 `personal_api_key`、`create_key` 等键名。<span style="color: #b42318; font-weight: 600;">页面标题和按钮文案尚未完善。</span>

![大陆 Personal API Key 页面显示未替换的文案键名](../assets/personal-api-guide/02-cn-key-page.png)

*图 7：大陆密钥页面可以打开，部分标题和按钮文案尚未正常显示。*

### 2. 条款页面尚未显示可读正文

申请时出现的条款页面，标题与正文仍显示 `personal_api_terms_*` 占位符。<span style="color: #b42318; font-weight: 600;">本次页面未能显示可正常阅读的条款内容。</span>

![大陆 Personal API 条款显示占位符](../assets/personal-api-guide/03-cn-terms.png)

*图 8：大陆申请条款的标题和正文仍是占位符，页面文案尚未完善。*

### 3. 旧测试记录与当前使用方式

2026 年 10 月 22 日创建的 **30 天有效期大陆 Key** 在刷新后仍能看到记录，但当时日期标签未正常呈现。

![大陆 Key 创建后刷新仍显示记录](../assets/personal-api-guide/06-key-list.png)

*图 9：大陆 Key 创建后刷新仍有记录，日期标签未正常显示；对应令牌交换返回 HTTP 526。*

当时使用**大陆 Key 请求对应 `personal.connectapi.garmin.cn`**，换取令牌返回 HTTP 526／`TOKEN_EXCHANGE_FAILED`。这是旧状态，完整过程仍保留在[端点实测报告](../research/personal-api-endpoint-test-report-2026-10-22.md)中。

现在新建 Harness Personal 账号时可直接选择中国区；独立 MCP 使用 `GARMIN_REGION=cn`。国际用国际 Key，大陆用大陆 Key，分开保存、不跨区回退。已有 Personal 账号切换地区时必须填写新地区生成的 Key。

## 八、连接后，用这个插件问两句

1. “用 dsh-plugin-garmin-connect 读取我最近 7 天的 HRV 和睡眠，按日期整理，并标出缺失的数据。”
2. “用这个插件对比最近两次跑步的配速和心率，再汇总昨天的血氧和呼吸摘要，只解释实际返回的数据。”

**让 AI 分析数据，把密钥留在你控制的本机配置里。**
