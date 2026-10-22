# Google Antigravity 配置指南

当在 Google Antigravity（包括 Antigravity CLI、Antigravity IDE 或 Antigravity 2.0）中接入 Garmin Connect 工具、初次配置认证、排查凭据或设置活动 FIT 下载目录时，读取本参考文档。

---

## 环境要求

- Node.js 20 或更高版本
- Google Antigravity（CLI / IDE / 2.0）
- 官方发布包：`dsh-plugin-garmin-connect`（npm 官方仓库）
- 默认凭据位置：`~/.config/dsh-plugin-garmin-connect/accounts/default.session.json`（macOS/Linux，受 `XDG_CONFIG_HOME` 影响；Windows 位于 `%LOCALAPPDATA%` 或 `%APPDATA%`；系统私密权限 600 / ACL 保护，未经加密）

---

## 接入方式

Antigravity 原生支持 **Plugin** 和 **MCP Server** 两种接入方式：

### 方式 A：作为 Antigravity Plugin 安装（推荐）

Antigravity 能够自动发现插件目录中的 `plugin.json` 与 `mcp_config.json`。

1. **全局安装**：
   将本插件克隆或软链接至 Antigravity 全局插件目录：
   ```bash
   mkdir -p ~/.gemini/config/plugins/garmin-connect
   # 或通过 agy CLI 安装发布包：
   # agy plugin install dsh-plugin-garmin-connect
   ```

2. **配置账号环境变量**：
   由于本插件支持多账号与多区域（中国区 / 国际区），建议在系统环境变量或 Antigravity 配置中指定您的账号及区域：
   - `GARMIN_USERNAME`: 您的 Garmin 账号邮箱
   - `GARMIN_REGION`: `cn`（中国区）或 `global`（国际区，默认值）

3. **验证工具挂载**：
   在 Antigravity 会话中，系统会自动启动内置的 Stdio MCP 服务器，并挂载 26 个 Garmin Connect 数据查询与训练管理工具。

---

### 方式 B：在 `mcp_config.json` 中作为独立 MCP Server 配置

如果希望将 Garmin Connect 作为一个全局或工作区 Stdio MCP 服务接入，可直接配置 `mcp_config.json`：

#### 全局配置 (`~/.gemini/config/mcp_config.json`)

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=dsh-plugin-garmin-connect",
        "garmin-connect-mcp"
      ],
      "env": {
        "GARMIN_USERNAME": "user@example.com",
        "GARMIN_REGION": "cn"
      }
    }
  }
}
```

> [!TIP]
> - 如果使用国际区账号，将 `GARMIN_REGION` 设置为 `"global"`。
> - 如果本地已克隆并编译了源码，可将 `command` 改为 `node`，并将 `args` 设为 `["/path/to/lib/mcp.js"]`。

---

## 认证与登录流程 (MFA)

遵循**“账号由你掌握，密码不交给 AI”**的原则，不要在与 Agent 的对话中提供用户名、密码或短信/邮件验证码。

使用插件自带的本地安全回环服务完成官方 Web MFA 登录：

### 1. 启动本地登录服务

在终端中执行（`serve` 必须显式传入 `--account` 和 `--region` 参数，环境变量不能代替该命令行参数）：

```bash
# 中国区账号（默认账号别名 default）
npx --yes --package=dsh-plugin-garmin-connect garmin-connect-auth serve --account default --region cn --open

# 国际区账号
npx --yes --package=dsh-plugin-garmin-connect garmin-connect-auth serve --account default --region global --open
```

该命令会在本地启动一个临时的 HTTP 回环服务（仅监听 `127.0.0.1`），并自动在系统浏览器中打开登录页面。

### 2. 在官方页面中完成登录

- 页面仅嵌入 Garmin 官方的登录表单（`https://sso.garmin.cn` 或 `https://sso.garmin.com`）；
- 输入账号、密码并完成两步验证（MFA）；
- 登录成功后，回环服务会自动换取会话凭据，并以 JSON 格式保存到本机私密文件中（默认保存路径为 `~/.config/dsh-plugin-garmin-connect/accounts/default.session.json`，通过操作系统私密权限 Unix 600 / Windows DACL 限制仅当前操作系统用户读写，未经加密）；
- 若通过 `--output <path>` 指定了自定义会话路径，请确保后续 MCP 启动时将 `GARMIN_SESSION_TOKEN_FILE` 设置为对应的绝对路径；
- 终端显示成功后，回环服务自动关闭。

### 3. 验证连接状态

验证已保存会话的有效性，建议通过 Antigravity 中的 MCP 服务执行一次只读查询（例如在 Antigravity 中调用 `get_garmin_profile` 工具核对账号信息）。

> [!NOTE]
> 另外，`canary` 命令是一个隔离的浏览器端到端登录诊断探针，用于排查浏览器环境或验证码问题。它**不会读取或保存**已有 session，且同样必须显式传入 `--region` 参数（例如 `npx --yes --package=dsh-plugin-garmin-connect garmin-connect-auth canary --region cn`），因此不能用于验证已保存的本地会话。

---

## 环境变量参考

| 变量名 | 说明 | 默认值 | 示例 |
|---|---|---|---|
| `GARMIN_REGION` | Garmin 账号所在区域 | `global` | `cn`（中国区）或 `global`（国际区） |
| `GARMIN_SESSION_TOKEN_FILE` | 登录会话文件路径 | `~/.config/dsh-plugin-garmin-connect/accounts/default.session.json` | `/Users/username/.config/dsh-plugin-garmin-connect/accounts/default.session.json` |
| `GARMIN_FIT_DOWNLOAD_DIR` | 活动原始 FIT 文件的本地保存父目录 | 无（未配置时禁用下载） | `/Users/username/Fitness/FIT` |
| `GARMIN_ACTIVITY_DETAIL` | 活动列表查询详细度 | `full` | `full`（包含完整详情）或 `compact`（精简模式） |
| `GARMIN_CACHE_TTL` | 接口数据内存缓存时间（秒） | `300` | `300` |

---

## 技能与可视化扩展

在 Antigravity 中配置好 MCP 服务后：
- 将本插件的 `skills/garmin-connect` 放置到 `.agents/skills/garmin-connect` 或全局技能目录；
- 在对话中提及睡眠、跑步、HRV、课表等即可自动触发该技能；
- 若用户要求图表或仪表盘呈现，Agent 会读取 [visualization-guide.md](visualization-guide.md)，生成符合 Antigravity 规范的 Generative UI 交互式图表。
