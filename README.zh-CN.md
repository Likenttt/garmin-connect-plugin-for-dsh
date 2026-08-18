# dsh-plugin-garmin-connect

> [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 Garmin Connect 插件 — 让 AI 代理直接读取你的运动和健康数据。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**[English](README.md)** | 中文

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

---

## 快速开始

### 1. 安装

```bash
npm install dsh-plugin-garmin-connect
```

### 2. 配置凭据

本插件**绝不**将密码写入配置文件或日志。凭据通过环境变量加载。

```bash
# 复制模板
cp .env.example .env

# 编辑 .env，填入你的 Garmin 账号信息
```

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `GARMIN_USERNAME` | ✅ | Garmin 账号邮箱 |
| `GARMIN_PASSWORD` | ✅* | 账号密码 |
| `GARMIN_SESSION_TOKEN` | ✅* | 预认证令牌（可替代密码） |
| `GARMIN_REGION` | ❌ | `global`（默认，国际版）或 `cn`（佳明中国） |
| `GARMIN_CACHE_TTL` | ❌ | 缓存有效期，单位秒（默认 `300`） |
| `GARMIN_LOG_LEVEL` | ❌ | 日志级别：`debug` \| `info` \| `warn` \| `error` |

> \* `GARMIN_PASSWORD` 和 `GARMIN_SESSION_TOKEN` 二选一即可。
>
> ⚠️ 如果密码包含 `#` 等特殊符号，请用**双引号**包裹，否则 `#` 后的内容会被当作注释截断：
> ```
> GARMIN_PASSWORD="my#secret!pass"
> ```

### 3. 在 Harness 中启用

在 Harness 配置文件中添加插件：

```yaml
# dsh.config.yml
plugins:
  garmin-connect:
    username: ${GARMIN_USERNAME}   # 自动从环境变量读取
    # password 和 sessionToken 同样从环境变量自动加载
    region: cn           # 如果你使用佳明中国
    cacheTtl: 300
```

### 4. 启动

```bash
npx @deepseek-ai/dsh web
```

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
1. 插件配置值（dsh.config.yml 中直接指定的）
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
│  │  ┌─────────────────────▼──────┐  │  │
│  │  │      工具注册中心           │  │  │
│  │  │  • get_garmin_activities   │  │  │
│  │  │  • get_garmin_sleep        │  │  │
│  │  │  • get_garmin_steps        │  │  │
│  │  │  • get_garmin_heart_rate   │  │  │
│  │  │  • get_garmin_profile      │  │  │
│  │  │  • export_garmin_session   │  │  │
│  │  └────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
│                                         │
│               Cordis 运行时              │
└─────────────────────────────────────────┘
           │
           ▼
   connect.garmin.com（国际版）
   connect.garmin.cn（中国区）
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
├── config.ts         # 配置 Schema，支持环境变量自动解析
├── client.ts         # Garmin API 封装，含缓存层
├── tools/
│   └── index.ts      # 工具定义与注册
└── utils/
    ├── cache.ts       # 内存 TTL 缓存
    └── format.ts      # 原始数据 → LLM 友好格式转换器
```

---

## 路线图

- [x] **身体成分** — 体重、BMI、体脂率
- [x] **Garmin 日历** — 计划中的训练课表
- [ ] **训练状态** — VO2 Max、训练负荷、恢复时间
- [ ] **Webhook 推送** — 活动上传实时通知
- [ ] **多账号支持** — 一个 Harness 会话管理多个 Garmin 账号
- [ ] **OAuth 2.0** — 等待 Garmin 开放个人用途的官方 API 后迁移

---

## 许可证

[MIT](LICENSE)

---

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/dsh) — AI 代理编码运行时
- [Cordis](https://github.com/cordiverse/cordis) — 插件生命周期框架
- [garmin-connect](https://www.npmjs.com/package/garmin-connect) — 非官方 Garmin Connect Node.js 客户端
