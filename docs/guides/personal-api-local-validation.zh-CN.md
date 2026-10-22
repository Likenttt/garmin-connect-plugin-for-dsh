# 本机验证 dsh-plugin-garmin-connect 的 Personal API 模式

本指南针对 2026-10-22 的开发版 `0.1.19-dev.0`。本机桌面 Harness 为 `0.2.1-rc.2`，`desktop` profile 当前安装插件 `0.1.18`；`web` 是另一份旧配置。本次使用桌面自带 CLI，避免另行下载 DSH 或装错 profile。插件已包含固定版本的 TS SDK 源码，用户无需另外安装 SDK。

## 1. 构建并安装开发包

在当前工作树执行：

```bash
cd /Users/kent/.codex/worktrees/activity-full-default-018/garmin-connect-plugin-for-dsh
npm run build
npm run check:sdk
npm pack --ignore-scripts
```

**完全退出 DeepSeek Harness**，再执行：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "/Users/kent/.codex/worktrees/activity-full-default-018/garmin-connect-plugin-for-dsh/dsh-plugin-garmin-connect-0.1.19-dev.0.tgz" --ignore-scripts --registry=https://registry.npmjs.org/
```

只读核验安装结果，应输出 `0.1.19-dev.0`：

```bash
node -p "require('/Users/kent/.dsh/profiles/desktop/node_modules/dsh-plugin-garmin-connect/package.json').version"
```

## 2. 在插件设置中配置

重开 Harness，进入 Garmin 插件设置，点击 **＋添加账号**，选择 **Personal API**。该账号只需两个输入项：**必填别名、国际版 API Key**，不需要邮箱或密码。保存后别名应保留，Key 显示“已设置”而不回填原文；随后点击 **验证连接**。

新建 Personal 账号使用国际端点：国际 Key 配 `.com`，大陆 Key 配 `.cn`，不能混用。大陆端点本次实测为 **HTTP 526，暂时无法访问**。保留原有 Connect 网页会话账号，使用设置页各自的账号 ID 核对隔离。

## 3. 在新对话中验收

将下方别名替换成自己设置的名称：

> 使用“我的佳明国际版”账号，先读取 profile 确认连接，再查询昨天的 HRV、血氧、呼吸摘要和活动。请说明实际查询日期；此次只读取数据。

- [ ] 验证连接成功，别名及稳定账号 ID 对应正确。
- [ ] 对话能找到 Personal 工具，profile 读取成功。
- [ ] 单日健康数据和活动返回符合预期；呼吸为每日摘要。
- [ ] 返回设置页，别名仍在，完整 Key 不出现。
- [ ] 指定原网页会话账号再次查 profile，两种账号互不串用。

目前已有真实 stdio MCP 读取及 DSH 工具适配器测试；完整桌面界面流程需按上述步骤完成验收。

## 4. 单独验证 MCP

独立 MCP 使用同一构建产物 `lib/mcp.js`，通过客户端自己的 `env` 设置 `GARMIN_PROVIDER=personal`、`GARMIN_ALIAS`、`GARMIN_ACCOUNT`、`GARMIN_REGION=global`、`GARMIN_PERSONAL_API_KEY_FILE`。**不会自动继承 DSH 设置。** 私密文件只存 Key；macOS／Linux 使用 `600` 权限，不把真实 Key 放进聊天、命令行或可分享配置。完整 JSON 见[主教程第六节](garmin-personal-api-guide.zh-CN.md)。

## 5. 问题定位

| 现象 | 优先检查 |
| --- | --- |
| 没有 Personal 模式或缺少工具 | 核验上述安装版本，重启桌面 Harness，并新建对话 |
| 401／403 | Key 是否有效、过期或撤销，以及是否选对区域 |
| 526 | 对应端点暂不可访问；大陆本次已复现 |
| 返回空数据 | 核对日期与设备记录；空值不等于 0 |

需要回退时，退出 Harness，用同一桌面 CLI 将安装参数改为 `dsh-plugin-garmin-connect@0.1.18`，再重开应用。正式版 `0.1.18` 不包含 Personal 模式。
