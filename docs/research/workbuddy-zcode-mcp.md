# WorkBuddy / ZCode MCP compatibility research

Research date: 2026-08-20

## Executive conclusion

WorkBuddy and ZCode are two separate desktop products, not two names for one client. Tencent describes WorkBuddy as its general-purpose workplace AI desktop workbench, while ZCode describes itself as an Agentic Development Environment with its own ZCode Agent. ([WorkBuddy product guide](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Product-Guide), [ZCode welcome](https://zcode.z.ai/cn/docs/welcome))

No client-specific adapter appears necessary in this repository. The current Garmin MCP entry point already uses MCP stdio transport, and both products expose a local-command MCP configuration with `command`, `args` and `env`. ([repository MCP implementation](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L297-L327), [ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services), [WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide))

Therefore the immediate work is documentation plus hands-on client verification, not another protocol implementation. Until an MCP-capable package is published to npm, both clients must launch the built local file `lib/mcp.js`; the repository currently states that the registry's `0.1.4` predates the MCP entry point. ([current project MCP guide](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/README.zh-CN.md#%E5%9C%A8%E5%85%B6%E4%BB%96-ai-%E7%BC%96%E7%A8%8B%E5%8A%A9%E6%89%8B%E4%B8%AD%E4%BD%BF%E7%94%A8mcp-%E5%8D%8F%E8%AE%AE))

## Compatibility matrix

| Client | Officially documented MCP capability | Fit with this server | Confidence |
| --- | --- | --- | --- |
| ZCode | User/workspace-scoped stdio, SSE and HTTP servers; environment variables; JSON mode; external-agent import | Direct fit with `/absolute/path/to/node /absolute/path/lib/mcp.js` and an `env` object | High — the official docs publish the full schema and paths. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services)) |
| WorkBuddy Desktop | User/workspace-scoped local MCP servers configured with `mcpServers`, `command`, `args` and `env` | Direct schema match with `/absolute/path/to/node /absolute/path/lib/mcp.js` | High for configuration compatibility; actual Garmin calls still require a client smoke test. ([WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)) |

## ZCode: exact supported setup

ZCode's supported UI flow is **Settings -> MCP Servers -> New MCP Server**. Choose user or workspace scope, choose `stdio`, set the absolute Node.js executable path as the command, provide the absolute `lib/mcp.js` path as an argument, add the Garmin environment variables, save, and ensure the server is enabled. ZCode also accepts full JSON in either a single-server object or `{"mcpServers": {...}}` form. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services))

The native user-level file is `~/.zcode/cli/config.json`; the workspace-level file is `<project>/.zcode/config.json`. Both use the key `mcp.servers`. ZCode additionally reads user/workspace `.agents/mcp.json` files using `mcpServers`. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services))

Recommended user-level native configuration:

```json
{
  "mcp": {
    "servers": {
      "garmin-connect": {
        "command": "/absolute/path/to/node",
        "args": [
          "/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"
        ],
        "env": {
          "GARMIN_USERNAME": "your@email.com",
          "GARMIN_PASSWORD": "your-password",
          "GARMIN_REGION": "cn"
        }
      }
    }
  }
}
```

This shape follows ZCode's official native `mcp.servers` example and replaces its sample command with this repository's documented stdio command and required environment variables. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services), [repository MCP configuration](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L238-L262))

ZCode can also import MCP entries from Claude Code, Codex CLI, OpenCode and `~/.agents/mcp.json`; imports are copied into ZCode's chosen `.zcode` scope and do not modify the source file. Since this project's README already documents Codex, importing the existing Codex server is an alternative, but the imported environment values should be inspected before testing. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services), [current Codex setup](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/README.zh-CN.md#openai-codex%E6%A1%8C%E9%9D%A2%E7%AB%AFcli-%E4%B8%8E-ide-%E6%89%A9%E5%B1%95))

ZCode's precedence rule is important: if a scope's `.zcode` file contains any MCP server, that scope's `.agents/mcp.json` is skipped as a whole rather than merged. The settings UI always writes to `.zcode`, and `"enable": false` records a disabled native entry. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services))

Workspace MCP servers auto-connect at session start. ZCode warns that opening a repository can consequently launch commands and grant file/network access, so a credential-bearing Garmin configuration is better kept user-scoped and out of the repository. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services))

## WorkBuddy Desktop: exact supported setup

The supported WorkBuddy UI flow is **Plugins -> MCP Servers -> Configure MCP**. The user-level file is `~/.workbuddy/mcp.json`; the project-level file is `<project>/.workbuddy/mcp.json`. WorkBuddy's official example uses a top-level `mcpServers` object and per-server `command`, `args` and `env` fields. ([WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide))

Recommended user-level configuration:

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/garmin-connect-plugin-for-dsh/lib/mcp.js"
      ],
      "env": {
        "GARMIN_USERNAME": "your@email.com",
        "GARMIN_PASSWORD": "your-password",
        "GARMIN_REGION": "cn"
      }
    }
  }
}
```

The WorkBuddy-specific object intentionally omits `type`: the official WorkBuddy local-command example omits it, and WorkBuddy's changelog records past connection failures caused by an incorrect `mcp.json` `type` field. ([WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide), [WorkBuddy changelog](https://www.codebuddy.cn/docs/workbuddy/Changelog))

After saving, WorkBuddy reports a green status for a successful connection; red means the configuration, command environment, dependency or address must be checked. Start a fresh task and ask for a read-only operation such as the Garmin profile. ([WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide), [repository MCP tools](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L80-L187))

## Environment and runtime handling

The standalone server requires `GARMIN_USERNAME` and either `GARMIN_PASSWORD` or `GARMIN_SESSION_TOKEN`; it also reads optional region, cache, timeout, log-level and activity-detail variables. ([repository MCP configuration](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L238-L262))

It calls `dotenv.config()` without a custom path. Dotenv's official documentation says that this loads `.env` from `process.cwd()` by default, so a desktop client launched from an unspecified working directory may not find the repository's `.env`. Explicit client-side `env` entries are therefore the reliable setup for both products. ([repository startup](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L297-L327), [dotenv official documentation](https://github.com/motdotla/dotenv#path))

The MCP executable requires Node.js 20 or newer. ([repository package metadata](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/package.json#L74-L76))

## Recommended implementation scope

1. Add a first-class ZCode section to both READMEs using the official native config above, including the `.zcode` versus `.agents` precedence warning. ([ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services))
2. Add a WorkBuddy Desktop section to both READMEs using the official `mcpServers` structure and paths above; call out that the repository has established configuration compatibility but has not yet recorded an end-to-end WorkBuddy Garmin smoke test. ([WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide))
3. Keep local-checkout instructions until an MCP-capable npm version is actually published; then replace the absolute `node .../lib/mcp.js` launch with the package's `garmin-connect-mcp` binary. ([current project MCP guide](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/README.zh-CN.md#%E5%9C%A8%E5%85%B6%E4%BB%96-ai-%E7%BC%96%E7%A8%8B%E5%8A%A9%E6%89%8B%E4%B8%AD%E4%BD%BF%E7%94%A8mcp-%E5%8D%8F%E8%AE%AE), [repository package binary](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/package.json#L7-L9))
4. Do not add WorkBuddy- or ZCode-specific runtime code unless hands-on testing reveals a transport or schema incompatibility; both clients' documented local-command model already matches the existing stdio server. ([repository stdio transport](https://github.com/Likenttt/garmin-connect-plugin-for-dsh/blob/main/src/mcp.ts#L297-L327), [ZCode MCP documentation](https://zcode.z.ai/cn/docs/mcp-services), [WorkBuddy MCP documentation](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide))
