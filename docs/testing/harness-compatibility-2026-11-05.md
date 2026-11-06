# DSH 0.2.2 兼容升级与未来版本策略

日期：2026-11-05（Asia/Shanghai）。本记录对应未发布的本地开发构建，不表示 npm 上现有 `0.1.20` 已包含这些改动。

## 问题与修复

原有两个 client peer 的最后一段是 `>=0.2.1-rc.1 <0.2.2-0`，因此会拒绝 `0.2.2-rc.1`。新增的版本矩阵在修复前出现两项失败，确认了加载门禁问题。

保留早期版本条款，将最后一段改为 `>=0.2.1-rc.1 <1.0.0-0`，使未来 `0.x` 不再仅因版本号被 Host 拦截。额外声明 `^0.2.2-rc.1`，让当前开发 SDK 也满足 npm 默认的预发布版本匹配规则。

| 依赖 | 升级后 |
| --- | --- |
| `dsh-client-connection`、`dsh-client-ui-layout`、`dsh-client-ui-slots` 开发依赖 | `0.2.2-rc.1` |
| Cordis 开发依赖 | `~4.1.0` |
| Cordis 运行时 peer | 保留 `^4.0.1` |
| Schemastery 运行时依赖 | `^3.19.0` |

Schemastery 不再重复声明为开发依赖，避免生产安装省略配置解析器。锁文件中的相关包同步更新；Garmin SDK 等无关依赖未变。

## 向下兼容方式

开发 SDK 的版本与 Host 兼容下限分开声明。客户端继续使用新旧 Host 共有的连接、RPC 和界面插槽接口；服务端保留旧 RPC 后备及新版 Fetch 路由，不引入仅 Cordis 4.1 提供的能力。

已比较官方包：连接 SDK 主要新增可选资源解析接口，布局变化集中在本插件未使用的侧栏；配置仍支持 volatile 引用 `.get()`、配置更新事件和插件重启。新版工具执行器虽有调整，本插件使用的工具注册、执行和结果渲染契约仍可用。

设置快照的旧 `mode` 字段在新版中被省略，因此将本地契约改为可选；配置不可用时，除旧版明确的 memory 模式外，仍显示“刷新配置”。

## 未来版本策略

- DSH 实际加载门禁使用 `semver.satisfies(..., { includePrerelease: true })`。上述范围允许未来 `0.2.3`、`0.3.0` 等 `0.x` 及其预发布版本；`<1.0.0-0` 从 `1.0.0` 的首个预发布版本起停止放行。
- 这是一项尽力兼容策略，不表示未来版本已经实测。`0.x` 仍可能引入破坏性接口变更；Cordis `^4.0.1` 和 React `^18.2.0` 的核心依赖边界保留。
- 保留已有的 Fetch／旧 RPC 能力检测、仅对明确 404 的路由回退，以及可选的配置快照字段。接口增量变化通常无需发布插件；已依赖的接口被移除或改变时仍需修改代码。
- 开发 SDK 继续固定在 `0.2.2-rc.1`，锁文件固定构建依赖。放宽 Host 声明不会自动升级构建依赖。
- npm 默认不启用 `includePrerelease`，因此另列当前 RC 范围；未来其他版本线的 RC 若直接参与 npm peer 解析，仍可能提示冲突。Host 放行与 npm 的依赖解析不是同一项检查。

## 验证

- Host、客户端声明和浏览器 bundle 构建通过；维护版 Garmin SDK 检查通过。
- 依赖升级时，六组定向测试共 **111 项通过**：版本范围、配置解析、插件生命周期、认证 RPC、客户端 flow 控制和账号设置。
- 随后放宽未来版本策略，单独重跑版本兼容测试 **7 项通过**，覆盖旧版、未来 `0.x`／RC、拒绝 `1.0.0` 预发布、核心依赖主版本边界，以及当前开发 SDK 的 npm 默认匹配规则。未来版本号属于合成门禁用例，不是实际运行时验证。
- `scripts/check-harness-runtime.cjs` 加载实际编译后的 Garmin 入口、配置、工具和 RPC，仅以合成 client 替换 Garmin 网络访问。在实际 Cordis **4.0.5**（桌面 `0.2.1-rc.5` 内置）和 **4.1.0** 下均通过：29 项工具注册、6 条路由、profile 执行与渲染、账号 RPC、volatile 更新重启及旧资源清理。
- `npm ls --omit=dev @deepseek-ai/schemastery --depth=0` 确认配置解析器仍属于生产依赖。
- 升级依赖并重新构建后，重启仍为 `0.2.1-rc.5` 的真实 Harness 桌面；在“Garmin 插件只读兼容性验收”对话中再次发起大陆和国际账号各一次 `get_garmin_profile`，两次均成功。本次仅查询 profile，未重新登录或修改 Garmin 数据。

可重复运行离线运行时检查：

```bash
node scripts/check-harness-runtime.cjs

ELECTRON_RUN_AS_NODE=1 \
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --expose-internals scripts/check-harness-runtime.cjs \
  --cordis '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis'
```

本轮没有安装 `0.2.2-rc.1` 桌面 App，也没有在新桌面版重新完成真实 MFA；新运行时离线验证不能代替这项端到端验收。更早的 `0.1`／`0.2.0` 声明范围保留，本轮未逐版重测。

## 为什么本机收不到桌面更新

核查时，官方 [Mac ARM64 nightly 更新源](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml) 已提供 `0.2.2-rc.1`，`stagingPercentage` 为 **30**，发布时间为 `2026-11-04T09:24:35.800Z`。按本机 updater 实际算法只读计算，本机不在当前 30% 范围内；没有输出安装标识或修改更新设置。固定安装分桶不会因反复刷新重新抽签。

[官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh) 当时仍为 `latest=0.2.1-rc.5`、`next=0.2.2-rc.1`。这是渠道与灰度状态，不是插件代码控制的行为。

[官方 0.2.2-rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1) 将 DSH 自身的 Node.js 下限提高到 **24.9**。CLI 用户需满足该要求；插件的独立 MCP 入口没有因本次 SDK 升级提高原有 Node.js 下限。
