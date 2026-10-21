# Google Antigravity 配置指南

当在 Google Antigravity（包括 Antigravity CLI、Antigravity IDE 或 Antigravity 2.0）中接入 Garmin Connect 工具、初次配置认证、排查凭据或设置活动 FIT 下载目录时，读取本参考文档。

---

## 环境要求

- Node.js 20 或更高版本
- Google Antigravity（CLI / IDE / 2.0）
- 官方发布包：`dsh-plugin-garmin-connect`（npm 官方仓库）
- 默认凭据位置：`~/.garmin-connect/session.json`（系统私密权限 600 / ACL 保护）

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

2. **验证工具挂载**：
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
        "-y",
        "dsh-plugin-garmin-connect",
        "garmin-connect-mcp"
      ],
      "env": {
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

在终端中执行：

```bash
npx dsh-plugin-garmin-connect garmin-connect-auth serve --open
```

如果使用中国区账号：
```bash
GARMIN_REGION=cn npx dsh-plugin-garmin-connect garmin-connect-auth serve --open
```

该命令会在本地启动一个临时的 HTTP 回环服务（仅监听 `127.0.0.1`），并自动在系统浏览器中打开登录页面。

### 2. 在官方页面中完成登录

- 页面仅嵌入 Garmin 官方的登录表单（`https://sso.garmin.cn` 或 `https://sso.garmin.com`）；
- 输入账号、密码并完成两步验证（MFA）；
- 登录成功后，回环服务会自动换取会话凭据，并将其加密保存到本机私密文件 `~/.garmin-connect/session.json`（文件权限设为 600，仅当前操作系统用户可读写）；
- 终端显示成功后，回环服务自动关闭。

### 3. 验证登录状态

运行 canary 检查命令验证会话有效性：

```bash
npx dsh-plugin-garmin-connect garmin-connect-auth canary
```

如果输出显示成功读取个人资料（Profile），说明认证已就绪。Antigravity 中的 MCP 服务启动时会自动读取该会话文件。

---

## 环境变量参考

| 变量名 | 说明 | 默认值 | 示例 |
|---|---|---|---|
| `GARMIN_REGION` | Garmin 账号所在区域 | `global` | `cn`（中国区）或 `global`（国际区） |
| `GARMIN_SESSION_TOKEN_FILE` | 登录会话文件路径 | `~/.garmin-connect/session.json` | `/Users/username/.garmin-connect/session.json` |
| `GARMIN_FIT_DOWNLOAD_DIR` | 活动原始 FIT 文件的本地保存父目录 | 无（未配置时禁用下载） | `/Users/username/Fitness/FIT` |
| `GARMIN_ACTIVITY_DETAIL` | 活动列表查询详细度 | `full` | `full`（包含完整详情）或 `compact`（精简模式） |
| `GARMIN_CACHE_TTL` | 接口数据内存缓存时间（秒） | `300` | `300` |

---

## 技能与可视化扩展

在 Antigravity 中配置好 MCP 服务后：
- 将本插件的 `skills/garmin-connect` 放置到 `.agents/skills/garmin-connect` 或全局技能目录；
- 在对话中提及睡眠、跑步、HRV、课表等即可自动触发该技能；
- 若用户要求图表或仪表盘呈现，Agent 会读取 [visualization-guide.md](visualization-guide.md)，生成符合 Antigravity 规范的 Generative UI 交互式图表。
