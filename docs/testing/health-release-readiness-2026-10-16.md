# 新版 Garmin SDK 与 DSH 插件发布检查（2026-10-16）

## 判断

**可在本机试用，尚不能按当前 package manifest 直接发布 npm。**

新增接口已经接通 SDK、插件客户端、共享 service、DSH registry 和 MCP。中国区和国际区各一个账号的 13 个新方法实测均通过，完整数据与空数据都能通过工具层。源码依赖和锁文件已正式改为我们维护的 `@likenttt/garmin-connect@1.7.0`，固定到 `Likenttt/garmin-connect` 的提交 `7d4cfe4b3c0e85d14946adeaa7f86031104c7c8b`，保留 `garmin-connect` 导入别名。

全新目录普通 npm 安装可用；桌面 Harness 的 pnpm 安全策略禁止 Git 子依赖，因此正式分发仍需要预编译的 npm 维护包。目前本机运行维护库的开发覆盖，没有关闭 Harness 的安全策略。

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
| 插件完整单元测试 | 干净安装后 42 套、992 / 992 通过；本轮新增 95 项 |
| 源码干净安装 | 无 node_modules、lib 或私密配置，禁止 SSH 的 npm ci、构建和 check:sdk 均通过 |
| Harness 内置 Node 24.18.1 下 SDK 单元测试 | 59 / 59 通过 |
| 同一 Node 24 下关键插件测试 | 138 / 138 通过，覆盖新增 wrapper、DSH、MCP、DI 与 interceptor |
| SDK 打包检查 | 维护版 1.7.0：64 文件，47,420 字节压缩；含全部新方法与声明，无 session、账号配置或测试文件 |
| 插件打包检查 | 185 文件，352,321 字节压缩；依赖已固定维护库 Git SHA，无 session 或私密账号 manifest |
| 真实 session 的 DSH execute | 两区各 13 个，共 26 / 26 通过 |
| 真实 MCP callTool 对照 | 两区共 26 / 26 与 DSH 完整结果深比较一致，缓存命中且无新增 HTTP 响应 |
| 旧功能基线 | 两区的 profile、最近一条活动、单日睡眠，共 6 / 6 通过 |
| 桌面界面 | Harness 0.2.0-rc.2 启动成功，Garmin 组件显示“运行中”；两主账号显示“已登录” |

新增离线测试覆盖账号隔离、认证切换时丢弃旧缓存及进行中响应、并发合并、超时恢复、严格参数校验、366 天边界、MCP 认证弹窗与错误脱敏。另有 20 项维护库依赖检查，拒绝上游包、浮动 Git 分支、短 SHA、错误仓库、缺失 API 及错误的 npm alias 版本。

### 本次真实查询范围

- 单日：`2026-10-15`。
- 范围：`2026-10-09` 至 `2026-10-15`。
- 现有账号配置共 3 个，本次选择中国区与国际区主账号各一个；第三个账号未纳入实测，桌面启动后显示待登录。
- 认证直接复用已有 DI session，未输入密码或打开重新登录流程。
- 国际区首次通过；中国区首次连接返回 `PublicToolError`，第二次使用同一 session、无需重新登录即通过全部检查。首次仅记录错误类，**根因尚未确认**，不能把它描述为确定的网络问题或已修复缺陷。
- 安装后的 Axios 响应观察记录：中国区 HTTP 200 共 15 次、204 共 2 次；国际区 HTTP 200 共 16 次、204 共 1 次。此计数不包含连接前的鉴权请求，包含预测方法附加的 profile 查询和旧功能基线，不等同于工具调用数量。
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

桌面 profile 已做可回滚的开发覆盖：

```text
~/.dsh/profiles/desktop/node_modules/dsh-plugin-garmin-connect/lib
~/.dsh/profiles/desktop/node_modules/garmin-connect
```

运行时已核实实际 SDK 包名为 `@likenttt/garmin-connect`、版本 `1.7.0`，仓库为 `Likenttt/garmin-connect`。它来自锁文件固定的 Git 提交，经正常 npm 安装与构建后用于本机覆盖；核心 `GarminConnect.js` 与完成两区实测的构建 SHA-256 完全一致。源码中的 `package.json` 和 `package-lock.json` 均已切换，运行时 `check:sdk` 也通过。

桌面显示的插件版本仍为 `0.1.13`，这是本地开发构建，**不代表 npm 上的 0.1.13 已有这些功能**。安装目录的 `LOCAL-DEVELOPMENT.json` 标记了维护库身份、Git SHA 和当前正式安装限制。profile 仍登记官方插件 0.1.13，重新安装该官方包会覆盖开发版本。

已尝试桌面官方 `dsh plugin --profile desktop add` 安装本次 tarball，依次遇到：

1. `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：Git 源需执行 TypeScript 编译。曾仅为这个固定提交添加构建允许项。
2. 编译成功后，`ERR_PNPM_EXOTIC_SUBDEP`：Host 的 `blockExoticSubdeps` 策略拒绝 Git 子依赖。

没有关闭该策略；临时构建允许项已移除，工作区安全配置与原配置语义一致。正式安装未完成，现有配置、会话和原安装记录保留，本机开发覆盖仍可运行。默认桌面安装问题不能被 npm 源码安装成功替代。

原插件、原 SDK 与 profile 依赖文件已备份在：

```text
/Users/kent/.codex/garmin-release-checks/2026-10-16/desktop-before
```

如需恢复，先退出 Harness，再执行：

```sh
node /Users/kent/.codex/garmin-release-checks/2026-10-16/restore-desktop.cjs
```

该恢复只替换插件和 SDK，不回滚本次正常刷新的 session。

## 还差的正式发布条件

1. **发布预编译维护 SDK 到官方 npm。** 发布标识已经确定为 `@likenttt/garmin-connect@1.7.0`，代码已提交并推送维护仓库，发布 tarball 已准备。npm 独立包尚未发布，scope 发布权限仍需登录核实。这样桌面安装就不需要执行 Git 依赖的构建脚本或允许 Git 子依赖。
2. **把插件依赖从维护库 Git SHA 改为正式 npm alias。** 当前已经使用维护库；下一步应改为 `npm:@likenttt/garmin-connect@1.7.0`，更新锁文件并重新验证干净安装与桌面官方安装入口。`prepublishOnly` 和 `pack:smoke` 已接入 `check:sdk`，防止误用上游库。
3. **执行正式的插件版本和发布步骤。** 当前插件版本仍为 0.1.13，尚未发布新插件版本。官方 npm 的 `whoami` 检查返回 401，实际发布时需重新认证；本轮已请求用户决定是否先发布维护 SDK。

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
