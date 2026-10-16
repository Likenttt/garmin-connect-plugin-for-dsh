# 新版 Garmin SDK 与 DSH 插件发布检查（2026-10-16，更新于 2026-10-17）

## 判断

**维护 SDK 已发布官方 npm；npm alias 候选已通过构建、测试与桌面官方 CLI 安装，可作为下一插件版本候选。新版插件尚未公开发布。**

新增接口已经接通 SDK、插件客户端、共享 service、DSH registry 和 MCP。中国区和国际区各一个账号的 13 个新方法实测均通过，完整数据与空数据都能通过工具层。

`@likenttt/garmin-connect@1.7.0` 已于 2026-10-17 发布至官方 npm。插件的 `package.json` 和 `package-lock.json` 已改为 `npm:@likenttt/garmin-connect@1.7.0` 别名与官方 registry tarball，保留 `garmin-connect` 导入名称。发布包完整性与之前验证过的 SDK tarball 一致：

```text
sha512-P8oLO9ykOfceUlIDphO1Dw2be9wbmqtt32ojyPCgZQ55SJ2a53+eqVHCYZFM8dlbYXvgX7qdkG0/SJvCsYn5+g==
```

此前 Git 依赖被 Harness 的 pnpm 安全策略拒绝；registry 预编译包已去掉 Git 安装和构建要求。安全策略仍保持启用。新候选包已通过桌面官方 CLI 正式安装并重启验证，旧开发覆盖标记已移除。新版插件尚未发布 npm。

## 新增 13 个 API

| SDK 方法 | DSH / MCP 工具 |
| --- | --- |
| `getHrvData` | `get_garmin_hrv` |
| `getHrvSummaries` | `get_garmin_hrv_summaries` |
| `getStressData` | `get_garmin_stress` |
| `getStressSummaries` | `get_garmin_stress_summaries` |
| `getBodyBattery` | `get_garmin_body_battery` |
| `getTrainingReadiness` | `get_garmin_training_readiness` |
| `getDailyTrainingStatus` | `get_garmin_daily_training_status` |
| `getTrainingStatus` | `get_garmin_training_status` |
| `getTrainingLoadBalance` | `get_garmin_training_load_balance` |
| `getMaxMetrics` | `get_garmin_max_metrics` |
| `getMaxMetricsRange` | `get_garmin_max_metrics_range` |
| `getRacePredictions` | `get_garmin_race_predictions` |
| `getRacePredictionsRange` | `get_garmin_race_predictions_range` |

插件工具总数由 10 增至 23。单日方法使用 `date`；范围方法使用 `startDate` / `endDate`，默认今天至今天；预测范围可选 `aggregation: daily | monthly`，最大日期差 366 天。DSH 多账号环境使用设置页中的稳定 `account` ID，MCP 使用当前进程配置的账号。比赛预测不接受外部 `displayName` 来改变查询对象。

方法保留原始对象、全部设备、时序和快照，不做 compact 裁剪。`null`、空数组、零值和未知字段都保留；DSH 输出 schema 也已允许正常的 `null`。

## 已完成的验证

| 检查 | 结果 |
| --- | --- |
| SDK 构建及严格 TypeScript 消费者声明检查 | 通过 |
| SDK 单元测试 | 59 / 59 通过 |
| 插件 host、client declarations、client bundle 构建 | 通过 |
| 插件完整单元测试（npm alias 候选） | 42 套、992 / 992 通过；随后新增 8 项锁校验测试，专项 28 / 28 通过；当前共 1,000 用例，未声称一次全量跑完 1,000 项 |
| 首轮源码干净安装（此前 Git 候选） | 无 node_modules、lib 或私密配置，禁止 SSH 的 npm ci、构建和 check:sdk 均通过；npm alias 候选另经桌面官方 CLI 安装验证 |
| Harness 内置 Node 24.18.1 下 SDK 单元测试 | 59 / 59 通过 |
| 同一 Node 24 下关键插件测试 | 138 / 138 通过，覆盖新增 wrapper、DSH、MCP、DI 与 interceptor |
| SDK 打包检查 | 维护版 1.7.0：64 文件，47,420 字节压缩；含全部新方法与声明，无 session、账号配置或测试文件 |
| 插件打包检查（npm alias 候选） | 185 文件，353,420 字节压缩；无凭据，包含公开模板 `.env.example` |
| 真实 session 的 DSH execute | 两区各 13 个，共 26 / 26 通过 |
| 真实 MCP callTool 对照 | 两区共 26 / 26 与 DSH 完整结果深比较一致，缓存命中且无新增 HTTP 响应 |
| 旧功能基线 | 两区的 profile、最近一条活动、单日睡眠，共 6 / 6 通过 |
| 桌面官方 CLI 安装 | `--ignore-scripts` + 官方 registry 安装退出 0；实际 npm alias、SDK 身份、13 个方法及 pnpm 锁完整性均通过；60 个 SDK `dist` 文件与已发布包逐字节一致 |
| 桌面界面 | 安装后重启 Harness 0.2.0-rc.2，Garmin 组件显示“运行中”；两主账号“已登录”，第三账号待登录 |

新增离线测试覆盖账号隔离、认证切换时丢弃旧缓存及进行中响应、并发合并、超时恢复、严格参数校验、366 天边界、MCP 认证弹窗与错误脱敏。维护库依赖门槛现共 28 项专项测试，拒绝上游包、浮动 Git 分支、短 SHA、错误仓库、缺失 API、错误的 npm alias 版本，以及别名切换后残留的旧 Git 锁记录；存在锁文件时验证根别名、安装包名/版本和官方 registry 精确 tarball URL。

### 本次真实查询范围

- 单日：`2026-10-15`。
- 范围：`2026-10-09` 至 `2026-10-15`。
- 现有账号配置共 3 个，本次选择中国区与国际区主账号各一个；第三个账号未纳入实测，桌面启动后显示待登录。
- 认证直接复用已有 DI session，未输入密码或打开重新登录流程。
- 国际区首次通过；中国区首次连接返回 `PublicToolError`，第二次使用同一 session、无需重新登录即通过全部检查。首次仅记录错误类，**根因尚未确认**，不能把它描述为确定的网络问题或已修复缺陷。
- 此前真实接口验证的 Axios 响应观察记录：中国区 HTTP 200 共 15 次、204 共 2 次；国际区 HTTP 200 共 16 次、204 共 1 次。此计数不包含连接前的鉴权请求，包含预测方法附加的 profile 查询和旧功能基线，不等同于工具调用数量。
- 本次 registry 安装后未重复 26 次 API 调用；已校验 SDK 全部 60 个 `dist` 文件与此前验证的已发布构建逐字节一致。桌面重启仅验证插件挂载与账号状态，没有发送模型对话。
- 所有原始响应仅在内存中比较。临时邮箱与 session 路径 manifest 已删除；报告只保留通用测试账号 ID、区域、结构、条数及请求状态。

机器可读证据见 [脱敏实测结果](health-release-evidence-2026-10-16.json)。

## 本机实际替换情况

本次没有使用主工作目录中的旧 `0.1.6` 插件。开发源为：

```text
/Users/kent/.codex/worktrees/activity-full-default-018/garmin-connect-plugin-for-dsh
branch: codex/health-recovery-tools

/Users/kent/deepseek/garmin-connect
branch: codex/health-recovery-apis
```

### 通过官方 CLI 安装 npm alias 候选

2026-10-17，桌面自带 CLI 已成功安装，进程退出 0：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  plugin --profile desktop add \
  '/Users/kent/.codex/garmin-release-checks/2026-10-17/plugin-npm-candidate/dsh-plugin-garmin-connect-0.1.13.tgz' \
  --ignore-scripts --registry=https://registry.npmjs.org/
```

profile 的 `package.json` 现在登记该候选的 `file:` tarball，插件真实依赖为
`npm:@likenttt/garmin-connect@1.7.0`。实际安装目录为：

```text
~/.dsh/profiles/desktop/node_modules/dsh-plugin-garmin-connect
~/.dsh/profiles/desktop/node_modules/garmin-connect
```

实际 SDK 包名为 `@likenttt/garmin-connect`、版本 `1.7.0`，13 个新方法均存在；pnpm 锁文件的官方 npm 完整性与已发布 tarball 匹配，SDK 全部 60 个 `dist` 文件逐字节一致。`LOCAL-DEVELOPMENT.json` 已不存在，不再使用此前手工覆盖的标记。安装后重启 Harness 0.2.0-rc.2，组件显示运行中，中国区与国际区两个主账号已登录，第三账号待登录。

pnpm 自动追加了唯一的发布时间豁免：

```yaml
minimumReleaseAgeExclude:
  - dsh-plugin-garmin-connect@0.1.13
  - '@likenttt/garmin-connect@1.7.0'
```

其他策略与原值一致，`blockExoticSubdeps` 默认保持启用，没有添加 SDK 的 `allowBuilds`。安装使用预编译 registry 包，不需要 Git 子依赖或依赖构建放行。

桌面显示的插件版本仍为 `0.1.13`，这是本地候选，**不代表 npm 上的 0.1.13 已有这些功能**。本次安装的候选包为 185 文件、353,420 字节，其完整性记录在机器可读证据中；最终 README/CHANGELOG 文档是在此候选安装后补全，属于后续插件发版准备，未重新打包或发布插件。

本机脱敏安装记录：

```text
/Users/kent/.codex/garmin-release-checks/2026-10-17/desktop-npm-install-report.json
```

### 历史 Git 候选安装阻塞

此前曾尝试桌面官方 `dsh plugin --profile desktop add` 安装 Git 依赖候选 tarball，依次遇到：

1. `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：Git 源需执行 TypeScript 编译。曾仅为这个固定提交添加构建允许项。
2. 编译成功后，`ERR_PNPM_EXOTIC_SUBDEP`：Host 的 `blockExoticSubdeps` 策略拒绝 Git 子依赖。

没有关闭该策略；临时构建允许项已移除。这次 Git 候选安装失败属于历史记录；发布 SDK 并切换为 npm alias 后，新的桌面 CLI 安装已经通过。

本次正式 npm 来源安装前的插件、SDK 和 profile 清单/锁文件/策略已备份，未复制账号 session：

```text
/Users/kent/.codex/garmin-release-checks/2026-10-17/desktop-before-npm-source
```

较早开发覆盖前的历史备份仍保留在 `2026-10-16/desktop-before`。

如需回到公开旧版，先退出 Harness，再通过桌面官方 CLI 重新安装官方包，以同步恢复 profile 登记来源和实际安装内容：

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' \
  plugin --profile desktop add \
  'https://registry.npmjs.org/dsh-plugin-garmin-connect/-/dsh-plugin-garmin-connect-0.1.13.tgz' \
  --ignore-scripts --registry=https://registry.npmjs.org/
```

安装后重新启动 Harness。这不会回滚正常刷新的账号 session。此前的 `restore-desktop.cjs` 只恢复安装文件，不能恢复本次改变的 profile 注册来源，不应作为这次正式安装的完整回滚方式。

## 已完成的分发步骤与剩余发布条件

1. **维护 SDK 已发布官方 npm。** 包为 `@likenttt/garmin-connect@1.7.0`，registry 完整性与已验证的 tarball 一致，已不需要 Git 依赖的构建允许项。
2. **插件依赖已切换为正式 npm alias。** `package.json` 和 `package-lock.json` 已使用 `npm:@likenttt/garmin-connect@1.7.0` 及官方 registry 归档。`prepublishOnly` 和 `pack:smoke` 已接入 `check:sdk`。该候选的 host/client 构建、42 套 992 项全量测试与增强锁文件来源检查已通过；随后新增 8 项防旧 Git 锁残留测试，相关专项 28 项通过。较早的源码干净安装与当前官方 CLI 的 registry 依赖安装分别记录。
3. **桌面官方安装入口已通过。** registry 候选安装退出 0，SDK 身份、13 个方法、锁文件完整性、全部 60 个 `dist` 文件与重启后的插件/账号状态均已核验；仅为精确 SDK 版本追加发布时间豁免，其他安全策略不变。
4. **新版插件尚未发布 npm。** 当前本地候选版本仍为 0.1.13；后续发布需使用新的插件版本，并重新生成包含最终文档的发布包。SDK 已完成发布验证，不再沿用此前 npm 未认证的状态判断。

首轮中国区连接异常仍需留作稳定性观察。测试覆盖当前两个账号与这些日期；月度预测、更多设备和第三个账号不属于本次线上样本。桌面检查验证插件挂载与账号状态，没有在 Harness 中自动发送新的模型对话。

## 后续如何复测

已有可复用脚本 `scripts/check-health-release.cjs`。它会经过真实 `GarminClient → GarminToolService → DSH execute / MCP callTool`，并只输出状态和响应结构；私密 manifest 格式与运行命令见 [中文测试说明](../../README.zh-CN.md)。运行前关闭读取同一 session 的其他进程，manifest 必须为当前用户所有的 `0600` 文件，报告路径必须是新文件。

本机安装好维护版依赖后，基础离线复测为：

```sh
# SDK 仓库
npm test

# 插件开发 worktree
npm run build
npm run check:sdk
npm test -- --runInBand
npm run pack:smoke
```
