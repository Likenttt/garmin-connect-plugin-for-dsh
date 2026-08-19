# dsh-plugin-garmin-connect

> [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 Garmin Connect 插件 — 让 AI 代理直接读取你的运动和健康数据。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**[English](README.md)** | 中文

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

| 工具名 | 用途 | 参数示例 |
|---|---|---|
| `get_garmin_activities` | 获取近期运动记录（跑步、骑行、游泳等），含配速、心率、卡路里 | |
| `get_garmin_sleep` | 获取睡眠数据：睡眠评分、总时长、深睡/浅睡/REM 分段 | |
| `get_garmin_steps` | 获取每日步数、目标完成度、步行距离 | |
| `get_garmin_heart_rate` | 查询心率（静息心率、最高心率、最低心率） | `{"startDate": "2023-10-01", "endDate": "2023-10-02"}` |
| `get_garmin_weight`     | 查询身体成分（体重、BMI、体脂率、骨骼肌等） | `{"startDate": "2023-10-01"}` |
| `get_garmin_workouts`   | 查询近期日历计划中的训练课表 | `{"limit": 10, "offset": 0}` |
| `get_garmin_profile`    | 获取个人的基础统计和勋章汇总 | `null` |
| `export_garmin_session` | 导出用于 `.env` 鉴权的持久化 Token | `null` |
| `get_running_skill_advice` | 跑步训练专家：8 大核心技能（心率区间、练法、避坑指南） | `{"query": "门槛", "includeRecentActivities": true}` |
| `create_garmin_workout` | 创建结构化训练计划（热身/间歇/重复组/放松，支持配速和心率目标），自动同步到手表 | `{"name": "门槛巡航3×8分钟", "steps": [...]}` |

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
cd dsh-plugin-garmin-connect && npm install
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

本插件**绝不**将密码写入配置文件或日志。凭据通过环境变量加载。

```bash
# 复制模板
cp .env.example .env

# 编辑 .env，填入你的 Garmin 账号信息
```

请把 `.env` 放在你运行 `dsh` 的目录(工作区根目录),插件启动时会自动加载。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Garmin 账号邮箱 |
| `GARMIN_PASSWORD` | ✅* | 账号密码 |
| `GARMIN_SESSION_TOKEN` | ✅* | 预认证令牌（可替代密码） |
| `GARMIN_REGION` | ❌ | `global`（默认，国际版）或 `cn`（佳明中国） |
| `GARMIN_CACHE_TTL` | ❌ | 缓存有效期，单位秒（默认 `300`） |
| `GARMIN_LOG_LEVEL` | ❌ | 日志级别：`debug` \| `info` \| `warn` \| `error` |
| `GARMIN_ACTIVITY_DETAIL` | ❌ | `get_garmin_activities` 的默认详情级别：`compact`（默认，精选字段，节省上下文）或 `full`（全部原始字段） |

> \* `GARMIN_PASSWORD` 和 `GARMIN_SESSION_TOKEN` 二选一即可。
>
> ⚠️ 如果密码包含 `#` 等特殊符号，请用**双引号**包裹，否则 `#` 后的内容会被当作注释截断：
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```

### 4. 启动

```bash
npx --legacy-peer-deps=false @deepseek-ai/dsh web
```

打开 `http://127.0.0.1:3080`。当 **设置 → 插件 → 插件列表** 中显示 `plugin-garmin-connect` 为 *已挂载、已启用* 时,说明插件已成功加载。然后直接对话:*"我昨晚睡得怎么样?"* 或 *"帮我看一下最近 5 次跑步。"*

### 5. 集成测试（可选）

在 `.env` 配置好凭据后，可以运行集成测试脚本一键验证所有 API 连通性：

```bash
npm run test:integration
```

<details>
<summary>📋 点击展开完整示例输出</summary>

```
🔌 Garmin Connect Integration Test
   Domain : garmin.com
   User   : your-email@example.com
   Date   : 2026-08-18

── 1. Login ──
  ✅ Login successful

── 2. Activities ──
  ✅ Got 3 activities
{
  "id": 23998327113,
  "name": "Wuhan Running",
  "type": "running",
  "startTime": "2026-08-16 19:33:05",
  "distanceMeters": 10017.73,
  "durationSeconds": 3965,
  "averageHeartRate": 145,
  "maxHeartRate": 180,
  "averagePaceMinPerKm": 6.6,
  "calories": 656,
  "elevationGainMeters": 4,
  "averageCadence": 141.78
}

── 3. Sleep ──
  ✅ Sleep score: 82, duration: 7.5h

── 4. Steps ──
  ✅ Steps: {
  "date": "2026-08-18",
  "totalSteps": 8523,
  "goal": 10000,
  "distanceMeters": 6120,
  "highlyActiveSeconds": 1800
}

── 5. Heart Rate ──
  ✅ Resting HR: 42, Max: 98

── 6. Weight / Body Composition ──
  ✅ Weight: 70.5 kg, BMI: 22.3, Body Fat: 15.2%

── 7. Workouts / Calendar ──
  ✅ Got 5 planned workouts
{
  "id": 1422905279,
  "name": "跃升之阶",
  "description": "",
  "sportType": "running",
  "createdDate": "2025-12-28T19:28:56.0",
  "estimatedDurationMins": 94,
  "estimatedDistanceMeters": null
}

── 8. User Profile ──
  ✅ Profile: loaded

── 9. Export Session Token ──
  ✅ Token exported (oauth1 key: ********…)
   💡 To use token-based auth, save the full JSON to GARMIN_SESSION_TOKEN in .env

🏁 Integration test complete.
```

</details>

---

## 🔐 安全设计

> **你的凭据绝不会离开你的本机。**

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
| 密码仅从 `process.env` 读取，不写入任何文件 | ✅ |
| `.env` 已加入 `.gitignore`，不会被提交到 Git | ✅ |
| 密码字段标记为 `role('secret')`，自动排除在 Harness 轨迹日志之外 | ✅ |
| 支持 Session Token 登录 — 完全避免存储密码 | ✅ |
| 工具返回值中不包含任何原始凭据 | ✅ |
| 内存缓存减少 API 调用次数，防止触发 Garmin 限流 | ✅ |

### 推荐做法：使用 Session Token

为了最大安全性，建议只用密码登录一次，然后导出 Session Token，后续只使用 Token：

```
你（对 DeepSeek 代理说）："导出我的 Garmin 会话令牌"

# 代理调用: export_garmin_session
# → 返回一个 token 字符串

# 写入 .env：
GARMIN_SESSION_TOKEN=<导出的令牌>
# 删除密码行：
# GARMIN_PASSWORD=
```

这样即使 `.env` 文件意外泄露，攻击者拿到的也只是一个可以随时失效的临时令牌，而非你的明文密码。

---

## 在其他 AI 编程助手中使用（MCP 协议）

本插件同时提供了一个独立的 **MCP (Model Context Protocol) 服务器**，让你可以在 Claude Desktop、Codex CLI、Cursor、Windsurf 等任何支持 MCP 的客户端中使用相同的 Garmin 工具 — **无需安装 DeepSeek Harness**。

### Claude Desktop

编辑 `~/.claude/claude_desktop_config.json`（Mac）或 `%APPDATA%\Claude\claude_desktop_config.json`（Windows）：

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "npx",
      "args": ["-y", "dsh-plugin-garmin-connect", "garmin-connect-mcp"],
      "env": {
        "GARMIN_USERNAME": "你的佳明邮箱",
        "GARMIN_PASSWORD": "你的密码",
        "GARMIN_REGION": "cn"
      }
    }
  }
}
```

重启 Claude Desktop 后，你会看到 🔌 图标表示工具已加载。试试说：*"帮我看下最近 5 次跑步记录"* 或 *"帮我创建一个门槛跑训练并同步到手表"*。

### Cursor / Windsurf

1. 打开 **设置 → MCP Servers → 添加服务器**
2. 名称：`garmin-connect`
3. 类型：**stdio**
4. 命令：`npx -y dsh-plugin-garmin-connect garmin-connect-mcp`
5. 添加环境变量：`GARMIN_USERNAME`、`GARMIN_PASSWORD`、`GARMIN_REGION`

### OpenAI Codex CLI

在 `.codex/config.json` 中添加：

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "npx",
      "args": ["-y", "dsh-plugin-garmin-connect", "garmin-connect-mcp"],
      "env": {
        "GARMIN_USERNAME": "你的佳明邮箱",
        "GARMIN_PASSWORD": "你的密码"
      }
    }
  }
}
```

### 本地开发 / 手动运行

```bash
# 克隆并构建
git clone https://github.com/Likenttt/garmin-connect-plugin-for-dsh.git
cd dsh-plugin-garmin-connect && npm install && npm run build

# 运行 MCP 服务器（标准输入输出）
GARMIN_USERNAME=xxx GARMIN_PASSWORD=xxx node lib/mcp.js
```

MCP 服务器暴露全部 10 个工具（运动记录、睡眠、步数、心率、体重、训练计划、个人资料、Token 导出、跑步技能、创建训练），通过标准 MCP 协议通信。

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
│  │  │  • export_garmin_session    │ │  │
│  │  │  • get_running_skill_advice │ │  │
│  │  │  • create_garmin_workout    │ │  │
│  │  └─────────────────────────────┘ │  │
│  └───────────────────────────────────┘  │
│               Cordis 运行时              │
└────────────────┬────────────────────────┘
                 │
      ┌──────────┴──────────┐
      ▼                     ▼
connect.garmin.com    MCP Server (stdio)
connect.garmin.cn     → Claude / Codex /
                        Cursor / Windsurf
```

---

## 开发

```bash
# 克隆仓库
git clone https://github.com/your-org/dsh-plugin-garmin-connect.git
cd dsh-plugin-garmin-connect
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
├── mcp.ts            # 独立的 MCP 服务器（用于 Claude/Codex/Cursor）
├── knowledge/
│   ├── running-skills.ts  # 8 大跑步核心技能知识库
│   └── workout-schema.ts  # 训练定义 → Garmin JSON 构建器
├── tools/
│   └── index.ts      # 工具定义与注册（10 个工具）
└── utils/
    ├── cache.ts       # 内存 TTL 缓存（含 SWR）
    └── format.ts      # 原始数据 → LLM 友好格式转换器
```

---

## 发布与分发

本包是一个标准的 dsh bundle:`package.json` 声明了 `dsh.bundle.patch` → `cordis.patch.yml`,`files` 会带上编译后的 `lib/`、中英 README 和 patch 文件。

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
- **GitHub 安装** — `npx --legacy-peer-deps=false @deepseek-ai/dsh plugin --profile web add github:<owner>/<repo>` 拉取源码并执行包的 `prepare` 脚本构建(脚本通过 `npx` 自包含地固定 TypeScript 版本);pnpm ≥ 10 默认拒绝执行构建脚本,`dsh` 会打印需要在 profile 的 `pnpm-workspace.yaml` 中填写的 `allowBuilds` 键。
- 给 GitHub 仓库加上 `dsh-plugin` topic,方便用户发现。

---

## 路线图

- [x] **身体成分** — 体重、BMI、体脂率
- [x] **Garmin 日历** — 计划中的训练课表
- [x] **创建训练** — 创建结构化训练计划并自动同步到手表
- [x] **MCP 服务器** — 支持 Claude Desktop、Codex CLI、Cursor、Windsurf
- [x] **跑步教练** — 8 大核心跑步训练技能知识库
- [ ] **训练状态** — VO2 Max、训练负荷、恢复时间
- [ ] **多账号同步** — 在中国区 ↔ 国际版账号之间同步运动数据
  - [ ] `list_garmin_accounts` — 列出已配置的账号及连接状态
  - [ ] `compare_garmin_accounts` — 比对两个账号的活动差异（按时间+距离+类型模糊匹配）
  - [ ] `sync_garmin_activity` — 从源账号下载 FIT 文件 → 上传到目标账号
  - [ ] 去重检测 — 跳过目标账号中已存在的活动
  - [ ] 环境变量：`GARMIN_USERNAME_2` / `GARMIN_PASSWORD_2` / `GARMIN_REGION_2`（完全向后兼容）
- [ ] **Webhook 推送** — 活动上传实时通知
- [ ] **OAuth 2.0** — 等待 Garmin 开放个人用途的官方 API 后迁移

---

## 许可证

[MIT](LICENSE)

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — AI 代理编码运行时
- [Cordis](https://github.com/cordiverse/cordis) — 插件生命周期框架
- [garmin-connect](https://www.npmjs.com/package/garmin-connect) — 非官方 Garmin Connect Node.js 客户端
