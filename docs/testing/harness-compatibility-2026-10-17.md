# Harness 0.2.1 兼容补丁记录（2026-10-17）

## 原因与范围设计

插件 `0.1.15` 的两个 client peer 仅逐项声明至 `0.2.1-rc.1`。Host 自动更新至
`0.2.1-rc.2` 后，兼容检查拒绝加载。`0.1.16` 候选将这两个 peer 的最后一项改为：

```text
>=0.2.1-rc.1 <0.2.2-0
```

涉及 `@deepseek-ai/dsh-client-connection` 和 `@deepseek-ai/dsh-client-ui-layout`，
其余旧支持项保留。三个 client 开发依赖同步至 `0.2.1-rc.2`，回归检查使用固定
`semver@7.8.5`，与实际 Host 使用的版本一致。

实际 Host guard 使用 `semver.satisfies(version, range, { includePrerelease: true })`。
上界选取 `0.2.2-0`，让整个下一补丁版本的预发布阶段也在范围之外：

| 版本 | 新范围的匹配结果 |
| --- | --- |
| `0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.99` | 接受 |
| `0.2.1` | 接受 |
| `0.2.2-0`、`0.2.2-alpha.1`、`0.2.2-rc.1`、`0.2.2` | 拒绝 |
| `0.3.0`、`1.0.0` | 拒绝 |

这些是声明与版本边界的验证结果；实际 API 比较覆盖本次 `rc.1` 与 `rc.2`。

## API 比较与当前证据

- `rc.2` 的 connection 和 Cordis 实际 JavaScript 与 `rc.1` 相同。
- layout 差异限于 CSS hash 与构建路径；当前使用的 `fetch`、`rpc`、`isLoopback`、
  slots 和 config forms 接口兼容，没有运行时代码改动。
- 使用真实 Host guard 与 `semver@7.8.5` 完成范围的红绿及边界验证。
- 已新增 4 项读取真实插件 manifest 的回归测试；旧 manifest 红测为 2 项失败、
  2 项通过，新 manifest 在 Harness Node `24.21.0` 下 **4/4 通过**，Jest 总耗时
  **4.231 秒**，默认测试超时未修改。
- 实际 Host 的 `evaluatePluginCompatibility` 读取修正后的 manifest，9 个版本的
  矩阵检查通过，覆盖 `rc.1`、`rc.2`、`rc.99`、稳定版 `0.2.1` 接受，以及下一
  版本线的边界拒绝。

| 检查 | 当前状态 |
| --- | --- |
| 依赖安装与最终锁文件 | 通过；官方 registry、禁用安装脚本，退出 0，16 秒，添加 3 个、移除 4 个、变更 7 个包 |
| host/client 构建 | 通过；host、client declarations、client bundle 均完成 |
| `check:sdk` | 通过；精确 `npm:@likenttt/garmin-connect@1.7.0` 别名，13 个方法齐全 |
| 新 manifest 的 4 项回归 | 4/4 通过；Harness Node `24.21.0`，4.231 秒 |
| 实际 Host 的 manifest 兼容矩阵 | 9 个版本通过 |
| 本机 `0.2.1-rc.2` 本地 tarball 安装与重启 UI | 通过；精确 `0.1.16`，正式 registry 来源尚未切换 |
| 安装后文件字节审计 | 通过；186 个插件文件及 SDK 60 个 `dist` 文件均匹配 |
| 官方 npm 发布及来源读回 | 等待新安全密钥，尚未确认上架 |

## 本机恢复与发布进度

精确 `0.1.16` tarball 已打包，源提交
`be0224814a6b2cb7a5e16780630c0f93b43e7903` 已推送 GitHub。包共 186 个文件，
其中 174 个 `lib` 文件与 3 个技能文件均与 `0.1.15` 逐字节一致，运行时代码未改；
SDK 仍为精确维护版 `1.7.0`。

官方 CLI 安装本地 tarball 退出 0，使用 pnpm `11.28.5`，耗时 **22.2 秒**，
124 项锁策略检查通过。实际安装后的 manifest 经 Host 的
`evaluatePluginCompatibility` 检查，对 `0.2.1-rc.2` 返回兼容。
重启 UI 确认版本 `0.1.16` 正常、1 个组件运行、两个主账号已登录、设置正常，
本机已恢复。当前来源仍为 **`file:` tarball**，安装后只读审计已完成：186 个插件
文件与精确 tarball 匹配，SDK 的 60 个 `dist` 文件及官方 `1.7.0` SRI 一致，
13 个方法齐全，两个 peer 对实际 `0.2.1-rc.2` 均兼容；workspace 未变更，
`changedKeys=[]`。见[本机脱敏审计证据](/Users/kent/.codex/garmin-release-checks/2026-10-17/plugin-0.1.16/desktop-local-check.json)。

首轮 npm 发布认证已过期，当前 **`publication=awaiting-security-key`**，等待新的
安全密钥验证；尚未确认官方上架。**`registrySource=pending`**，本地安装与 UI
通过不记为官方 registry 来源切换完成。

本记录不改写 `0.1.15` 的发布和测试历史；正式发布及来源验收结果待补充。
