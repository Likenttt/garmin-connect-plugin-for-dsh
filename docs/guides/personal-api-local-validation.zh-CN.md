# 本机验证 dsh-plugin-garmin-connect 的 Personal API 模式

本指南按正式版 `0.1.21` 的账号工作台整理。账号不设固定数量上限，使用自由备注识别；Harness 与共享工作区 MCP 共用账号、时间线和备注。SQLite 工作台需要 Node 22.13+，旧版单账号 MCP 仍支持 Node 20。历史 `0.1.19` 候选验收与正式版复核见[实测报告](../testing/personal-api-harness-desktop-2026-10-22.md)。以下使用桌面自带 CLI，避免另行下载 DSH 或装错 profile；用户无需另外安装底层 SDK。

## 1. 安装官方 npm 正式版

**完全退出 DeepSeek Harness**，再执行：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-plugin-garmin-connect@0.1.21 --ignore-scripts --registry=https://registry.npmjs.org/
```

只读核验安装结果，应输出 `0.1.21`：

```bash
node -p "require(require('node:path').join(require('node:os').homedir(), '.dsh/profiles/desktop/node_modules/dsh-plugin-garmin-connect/package.json')).version"
```

## 2. 在 Garmin 工作台配置

重开 Harness，打开一个会话，点击右下角 **Garmin 工作台 → 账号 → 添加账号**，选择 **Personal API**。选择中国区或国际区，再填写**账号备注和对应地区的 API Key**，不需要邮箱或密码。保存后备注应保留，完整 Key 不回填；随后点击**检查连接**。也可使用**检查全部连接**查看所有账号的进度与结果，并随时取消。

Connect 网页会话账号的列表和时间线可显示 Garmin 头像；没有头像时保留备注首字。Personal API 未返回头像字段时同样使用备注首字。

新建 Personal 账号时明确选择地区：国际 Key 配 `.com`，大陆 Key 配 `.cn`，不能混用。大陆 Personal 端点已于 2026-11-02 重新开放；此前独立测试中的 **HTTP 526** 仅为 2026-10-22 的历史结果。保留原有 Connect 网页会话账号，使用 `list_garmin_accounts` 返回的稳定账号 ID 核对隔离。

## 3. 在新对话中验收

将下方账号备注替换成自己设置的名称：

> 使用“我的佳明国际版”账号，先读取 profile 确认连接，再查询昨天的 HRV、血氧、呼吸摘要和活动。请说明实际查询日期；此次只读取数据。

以下勾选项对应 2026-10-22 的历史验证，0.1.21 可按同样的只读步骤复核：

- [x] 验证连接成功，账号备注及稳定账号 ID 对应正确。
- [x] 对话能找到 Personal 工具，profile 读取成功。
- [x] 单日健康数据和活动返回成功；呼吸为每日摘要，HRV、血氧中的空值仍按空值处理。
- [x] 保存后别名仍在，完整 Key 不回填。
- [x] 完全退出并重开 Harness 后，别名、稳定账号 ID 和 Key 配置保留，再次验证连接成功。
- [x] 指定原大陆网页会话账号再次查 profile，返回独立账号数据。

完整验收在发布候选 `0.1.19-dev.0` 中完成，新对话实际执行了 5 次国际 Personal 读取，以及 1 次原大陆网页会话 profile 读取，全部成功。正式包的 217 个编译文件与该候选完全一致；官方 npm 正式版 `0.1.19` 安装后，设置页连接复核也已通过。此次 HRV 明细为空，血氧的 24 个小时条目中测量值均为空，未取得有效 HRV 时序或当日血氧测量。详情见[实测报告](../testing/personal-api-harness-desktop-2026-10-22.md)。此前的 stdio MCP 和 DSH 工具适配器测试仍作为独立证据保留。

## 4. 单独验证 MCP

0.1.21 可使用共享工作区模式，直接复用 Harness 里的 Personal 账号和备注：

```bash
npx -y --package dsh-plugin-garmin-connect@0.1.21 garmin-connect-mcp --workspace
```

先启动一次升级后的 Harness；连接后使用 `list_garmin_accounts` 选择账号，用 `open_garmin_workspace` 获取管理页入口。

继续使用旧版单账号模式时，通过客户端自己的 `env` 设置 `GARMIN_PROVIDER=personal`、`GARMIN_ALIAS`、`GARMIN_ACCOUNT`、`GARMIN_REGION=global`、`GARMIN_PERSONAL_API_KEY_FILE`。**该旧模式不会自动继承 Harness 设置。** 私密文件只存 Key；macOS／Linux 使用 `600` 权限，不把真实 Key 放进聊天、命令行或可分享配置。完整 JSON 见[主教程第六节](garmin-personal-api-guide.zh-CN.md)。

## 5. 问题定位

| 现象 | 优先检查 |
| --- | --- |
| 没有 Personal 模式或缺少工具 | 核验上述安装版本，重启桌面 Harness，并新建对话 |
| 401／403 | Key 是否有效、过期或撤销，以及是否选对区域 |
| 526 | 对应端点的 TLS／边缘服务异常；保持当前地区，稍后重试，不要把 Key 改发另一区域 |
| 返回空数据 | 核对日期与设备记录；空值不等于 0 |

需要回退时，退出 Harness，用同一桌面 CLI 将安装参数改为 `dsh-plugin-garmin-connect@0.1.18`，再重开应用。正式版 `0.1.18` 不包含 Personal 模式。
