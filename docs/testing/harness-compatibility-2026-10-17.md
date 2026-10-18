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
| 本机 `0.2.1-rc.2` 本地 tarball 安装与重启 UI | 通过；精确 `0.1.16`，保留为本地恢复阶段记录 |
| 本地 tarball 安装后的文件字节审计 | 通过；186 个插件文件及 SDK 60 个 `dist` 文件均匹配 |
| 官方 npm 发布及元数据读回 | 通过；`published=true`、`latest=0.1.16`，SRI 匹配 |
| 正式 registry 来源安装、审计与重启 UI | 通过；`registrySource=verified`，精确 `0.1.16` 来源及新 Host 运行均已确认 |

## 本机恢复与发布进度

精确 `0.1.16` tarball 已打包，源提交
`be0224814a6b2cb7a5e16780630c0f93b43e7903` 已推送 GitHub。包共 186 个文件，
其中 174 个 `lib` 文件与 3 个技能文件均与 `0.1.15` 逐字节一致，运行时代码未改；
SDK 仍为精确维护版 `1.7.0`。

官方 CLI 安装本地 tarball 退出 0，使用 pnpm `11.28.5`，耗时 **22.2 秒**，
124 项锁策略检查通过。实际安装后的 manifest 经 Host 的
`evaluatePluginCompatibility` 检查，对 `0.2.1-rc.2` 返回兼容。
重启 UI 确认版本 `0.1.16` 正常、1 个组件运行、两个主账号已登录、设置正常，
本机已恢复。该阶段来源为 **`file:` tarball**，安装后只读审计已完成：186 个插件
文件与精确 tarball 匹配，SDK 的 60 个 `dist` 文件及官方 `1.7.0` SRI 一致，
13 个方法齐全，两个 peer 对实际 `0.2.1-rc.2` 均兼容；workspace 未变更，
`changedKeys=[]`。见[本机脱敏审计证据](/Users/kent/.codex/garmin-release-checks/2026-10-17/plugin-0.1.16/desktop-local-check.json)。

## 官方发布与来源切换

首轮认证过期作为历史保留；随后官方 npm 发布已完成并核验，当前
**`publication=published`**、**`published=true`**。发布时间为
`2026-10-17 21:05:25.027`（Asia/Shanghai），核验时间为 `21:05:39.714`；
exact、full、install-v1 三种元数据读取均返回 HTTP 200，`latest=0.1.16`。
[官方发布核验证据](/Users/kent/.codex/garmin-release-checks/2026-10-17/plugin-0.1.16/npm-publication.json)
确认发布包共 186 个文件、解压 1,470,311 字节，维护库仍为
`npm:@likenttt/garmin-connect@1.7.0`，SRI 与精确 tarball 一致：

```text
sha512-8adU2LDvOcHtaQUzIld+6RAmSzlxH6UMlfF6ON4/pCWhDAxxkglKttD3Hru8VhvabPl/SjRRiDsqBMRYe+2ptA==
```

官方 desktop CLI 已将来源从本地 tarball 切换为 registry exact `0.1.16`，
命令退出 0，pnpm `11.28.5`，耗时 **9.7 秒**。最终状态为
**`publication=published`**、**`registrySource=verified`**。

[正式来源脱敏审计证据](/Users/kent/.codex/garmin-release-checks/2026-10-17/plugin-0.1.16/desktop-registry-check.json)
结果为 `registry-install-and-host-peers-verified`：profile 精确引用
`dsh-plugin-garmin-connect@0.1.16`，无 `file:` 或 Git 来源，锁文件 SRI 与官方发布
一致；插件全部 186 个文件（含 174 个 `lib`、3 个技能文件）及 SDK 的 60 个
`dist` 文件匹配官方包，13 个方法齐全，实际 Host 与两个 peer 的 `0.2.1-rc.2`
兼容检查通过。安全策略仅语义新增精确插件 `0.1.16` 的发布时间豁免。

根 agent 通过 CUA 重启 `.app` 后独立确认：UI 版本 `0.1.16`，来源
`dsh-plugin-garmin-connect@0.1.16`，1 个组件运行、两个主账号已登录、无兼容拦截。
用户原有草稿保留且未发送。Git tag `v0.1.16` 已推送，指向文中源提交
`be0224814a6b2cb7a5e16780630c0f93b43e7903`。

前述本地恢复阶段保留为历史。本记录不改写 `0.1.15` 的发布和测试历史；本次未
追加全量测试或健康 API 实测。
