# WorkBuddy 配置

当 Garmin MCP 工具不可用、首次认证、需要修复认证、配置 FIT 下载目录或更新
已安装技能时，读取本参考文档。

本流程适用于个人版 WorkBuddy 桌面客户端，并在同一台电脑上运行本地 stdio
MCP 服务。它不是 WorkBuddy 企业版上传清单，也不支持纯网页、纯移动端、远程
或通过隧道完成认证。

## 环境与软件包

- Node.js 20 或更高版本
- 公共软件包：`dsh-plugin-garmin-connect`
- npm 仓库：`https://registry.npmjs.org/`
- MCP 可执行程序：`garmin-connect-mcp`

下载这个公共软件包不需要 npm access token。软件包名称不附带版本，npm 会
解析当前的 `latest` 正式版本。这样可以自动跟随正式发布，但不属于可复现的
固定版本安装。执行前应向用户展示 npm 当前解析出的版本和完整性信息。不要
擅自切换到预发布标签。

这是社区软件包，而非 Garmin 官方软件。执行前说明软件包名称、当前解析结果、
完整性信息，以及 `npx` 会在本机运行软件包代码。

`garmin-connect-auth --version` 只是可执行程序的冒烟测试，不是独立的软件供应链
审计，不要把它描述成安全审计。

先查找并验证 Node 的绝对路径，再解析真实的 `npm` 和 `npx` CLI 脚本。只写
绝对 `npx` 启动器仍不够，因为它的 shebang 可能依赖 WorkBuddy 图形界面
`PATH` 中不存在的 `node`：

```bash
NODE_BIN="$(command -v node)"
NPM_CLI="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v npm)")"
NPX_CLI="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$(command -v npx)")"
"$NODE_BIN" --version
printf '%s\n' "$NODE_BIN" "$NPM_CLI" "$NPX_CLI"
```

必须确认 Node 为 `v20` 或更高版本。Windows 上使用 `where node`、`where npm`
和 `where npx`，找到对应的 `node_modules/npm/bin/npm-cli.js` 与
`npx-cli.js`；JSON 路径使用正斜杠或转义后的反斜杠。

执行前，查看 npm 当前选中的正式版本，并在不运行生命周期脚本的情况下下载
tarball。`npm pack` 会根据仓库元数据校验 tarball：

```bash
DOWNLOAD_DIR="$(mktemp -d)"
"$NODE_BIN" "$NPM_CLI" view \
  dsh-plugin-garmin-connect \
  version dist.integrity \
  --registry=https://registry.npmjs.org/
"$NODE_BIN" "$NPM_CLI" pack \
  dsh-plugin-garmin-connect \
  --ignore-scripts \
  --registry=https://registry.npmjs.org/ \
  --pack-destination "$DOWNLOAD_DIR"
```

记录紧接执行前显示的版本与完整性信息。如果元数据缺失或 `npm pack` 报告
完整性失败，应停止。此流程仍依赖 npm 解析软件包及其依赖树，并非完全封闭、
完全内置依赖的安装；必要时向用户说明这一限制。

获得用户明确的下载与执行授权后，获取软件包并进行冒烟测试：

```bash
/absolute/path/to/node /absolute/path/to/npx-cli.js -y \
  --registry=https://registry.npmjs.org/ \
  --package dsh-plugin-garmin-connect \
  garmin-connect-auth --version
```

报告程序返回的版本，并确认它与前面的 npm 元数据查询一致。

## 注册 WorkBuddy MCP 服务

打开 **插件 → MCP 服务器 → 配置 MCP**，或者将下方服务合并到用户级
`~/.workbuddy/mcp.json`。绝不要覆盖其中无关的既有服务。修改用户配置前需要
单独获得授权。

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/npx-cli.js",
        "-y",
        "--registry=https://registry.npmjs.org/",
        "--package",
        "dsh-plugin-garmin-connect",
        "garmin-connect-mcp"
      ],
      "env": {
        "GARMIN_USERNAME": "user@example.com",
        "GARMIN_REGION": "cn",
        "GARMIN_ACCOUNT": "workbuddy-cn",
        "GARMIN_SESSION_TOKEN_FILE": "/absolute/private/path/workbuddy-cn.session.json"
      }
    }
  }
}
```

替换示例邮箱和所有路径。`GARMIN_REGION` 只能是 `cn` 或 `global`。会话文件应
使用只有当前用户可访问、且仅供这个 WorkBuddy MCP 进程使用的本地路径。邮箱
会保存在本地 WorkBuddy 配置中，保存前应向用户说明。不要配置
`GARMIN_PASSWORD`、MFA 验证码或内联令牌。

活动查询默认返回 `full` 详情，包含 Garmin 活动列表中可用的扩展字段，可能包含
精确路线或位置；圈数和分段摘要只在 Garmin 提供时出现。如需精简输出，可在单次调用
中设置 `detail="compact"`，或在 `env` 中设置 `GARMIN_ACTIVITY_DETAIL=compact`。

在 macOS/Linux 上，只创建确切的会话文件父目录，并限制为仅所有者可访问：

```bash
install -d -m 700 "$HOME/.garmin-connect-auth/accounts"
```

会话文件使用该目录下的绝对路径。Windows 上优先使用 `%LOCALAPPDATA%` 下的
路径；插件会创建或验证仅限当前用户的精确 ACL。如果现有目录权限不安全，插件
应直接失败，而不是放宽其权限。

配置两个账号时，添加两个不同名称的 MCP 服务，并分别设置不同的
`GARMIN_ACCOUNT`、`GARMIN_REGION` 和 `GARMIN_SESSION_TOKEN_FILE`。并发客户端
或不同账号绝不能共用同一个会话文件。

保存配置，重新加载 WorkBuddy MCP 服务，并确认服务已经连接。然后开始一个新
请求并再次调用 `garmin-connect`。WorkBuddy 重新加载前，原会话无法使用刚注册
的工具。

## 可选：配置 FIT 下载目录

创建 Garmin 训练不需要额外的写权限环境变量，按技能中的预览与确认流程使用
`create_garmin_workout` 即可。下载活动 FIT 则需要在上面对应 MCP 服务现有的
`env` 中新增：

```json
"GARMIN_FIT_DOWNLOAD_DIR": "/absolute/path/to/garmin-fit-downloads"
```

该值必须替换为用户选择的可信本地父目录的绝对路径。保留现有的账号、区域、
会话文件和其他环境变量；修改配置仍遵循上文的授权要求。保存后重新加载 MCP
服务，并开始新请求。

插件会在该父目录下按区域与账号分别保存到 `GARMIN_FIT_<region>_<account-email>`
子目录；账号包含特殊字符时会编码处理。已有 FIT 文件不会被覆盖，重复下载
会返回 `OUTPUT_EXISTS`。调用工具时只传入已核对的 `activityId`，不要添加
`path`、`outputDir` 或其他工具未提供的参数。

## 更新已安装技能

升级 npm 软件包不会自动替换 WorkBuddy 已安装的技能文件。要启用本技能中的
写操作流程，应将当前版本的 `skills/garmin-connect/SKILL.md` 与
`skills/garmin-connect/references/workbuddy-setup.md` 同步到 WorkBuddy 实际
安装的 `garmin-connect` 技能目录，保留用户与本次更新无关的本地修改和其他技能。

重新加载 WorkBuddy 的技能与 MCP 服务，再新开会话调用 `garmin-connect`。
确认当前会话能看到 `create_garmin_workout` 和 `download_garmin_activity_fit`
后，按技能中的写操作流程执行用户请求。修改项目里的副本或仅在旧会话中继续
对话，不能保证已安装技能和工具得到更新。

## 浏览器认证

即使由只读 Garmin 工具触发，认证仍会产生本地副作用：它将打开浏览器并写入
仅所有者可访问的会话文件。因此，启动认证前必须立即获得用户授权。

首次调用只读工具时，会话缺失或过期可能触发随机、短时有效的
`http://127.0.0.1:<port>/...` 认证提示。让 WorkBuddy 在本机展示或打开它；
不要把 URL 复制到模型回复、日志或其他设备。外层回环桥接页面属于本社区插件。
插件会以程序方式只允许 `https://sso.garmin.cn/sso/embed` 和
`https://sso.garmin.com/sso/embed` 这两个精确 frame 服务地址，并校验相应
origin。浏览器地址栏无法独立证明跨域 iframe 的来源，不要告诉用户可以这样
验证。如果嵌入的 Garmin 表单缺失或被拦截，停止输入。流程显示完成后，明确
重试原来的只读查询。

如果 WorkBuddy 无法展示 URL elicitation，并且用户另行批准打开浏览器和写入
会话文件，请在可信的本地终端中，使用相同账号、区域和会话路径运行备用流程。
首先确认 npm 当前选择的正式版本包含浏览器命令：

```bash
/absolute/path/to/node /absolute/path/to/npx-cli.js -y \
  --registry=https://registry.npmjs.org/ \
  --package dsh-plugin-garmin-connect \
  garmin-connect-auth serve --help
```

如果该命令不存在，停止并说明 npm 当前的 `latest` 正式版本尚未提供这种浏览器
认证方式；不要擅自安装预发布版本。如果命令可用，先在当前终端环境中设置
与 MCP 配置相同的 `GARMIN_USERNAME`（邮箱），再运行下方命令。MCP 服务的
`env` 不会自动传给独立终端；该显式邮箱配置也适用于 0.1.6。

```bash
/absolute/path/to/node /absolute/path/to/npx-cli.js -y \
  --registry=https://registry.npmjs.org/ \
  --package dsh-plugin-garmin-connect \
  garmin-connect-auth serve \
  --account workbuddy-cn \
  --region cn \
  --output /absolute/private/path/workbuddy-cn.session.json \
  --open
```

不要把生成的会话文件或其内容复制进对话。浏览器桥接仅监听本机回环地址，必须
与 WorkBuddy 运行在同一台电脑上。

断开连接时，先禁用对应 MCP 服务。只有在用户明确确认后，才删除配置中指定的
确切会话文件；不要使用通配符或递归删除。删除本地文件不会撤销 Garmin 服务端
的账号会话。

## 认证能力边界

认证能力取决于 npm `latest` 当前指向的软件包。承诺支持浏览器 MFA 前，应先
验证实际可用的命令。对于尚未测试的地区、WorkBuddy URL elicitation 和刷新
令牌行为，应如实说明限制，不要声称普遍支持 MFA。
