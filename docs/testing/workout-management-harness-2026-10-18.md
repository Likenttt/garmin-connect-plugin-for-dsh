# 大陆主账号课表删除与排期取消实测（2026-10-18）

## 结论

真实 DeepSeek Harness 桌面会话中的两项确认写操作均通过：取消单次日历排期后，训练库模板仍存在；删除该测试模板后，详情接口返回 HTTP 404，训练库和排期列表中均无测试对象。原有 **42 个课表的 ID 集合一致**，本次测试数据已清理。

## 环境与安装

- Host：DeepSeek Harness `0.2.1-rc.2`，内置 Node `24.21.0`。
- 模型：DeepSeek-V4.1-Flash `1017`，High。
- 账号：设置页显示的「大陆主账号」，稳定 ID `legacy-cn`，区域 `cn`，沿用本机已有登录会话。
- 源提交：`e2f51c5`，分支 `codex/health-recovery-tools`。
- 本机候选：`0.1.17-dev.20261018.1`，由该提交构建；只在暂存包中设置开发版本与来源标记，未修改仓库发布版本，未发布 npm。
- 通过桌面自带官方 CLI 安装本地 tarball，退出 0；重启 Harness 后验证。安装后的全部 **182 个编译文件**与暂存包逐字节一致。

## 测试对象

| 项目 | 值 |
| --- | --- |
| 唯一测试名称 | `DSH-DELETE-VERIFY-20261018-E2F51C5` |
| 模板 ID | `37911896` |
| 排期 ID | `34525789` |
| 排期日期 | `2026-10-19` |
| 内容 | running，单个 60 秒开放目标步骤，仅作功能验收 |

模板由真实 Harness 的 `create_garmin_workout` 预览、确认后创建。当前插件尚无创建排期工具，因此测试夹具的排期通过维护 SDK 已鉴权传输单次 POST `/workout-service/schedule/{workoutId}`、JSON `{ "date": "2026-10-19" }` 创建。取消与删除均由 **正在运行的 Harness Agent 调用本次新增工具**完成，没有用直接 API 删除代替桌面验收。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| 新工具可见、训练库与排期只读查询 | 通过；大陆主账号请求成功 |
| `unschedule_garmin_workout` 预览 | `requiresConfirmation=true`，账号、名称、排期 ID、日期及保留模板标记正确 |
| `delete_garmin_workout` 预览 | `requiresConfirmation=true`，账号、名称与模板 ID 正确 |
| 预览不产生删除 | 独立只读检查确认模板与排期都仍存在 |
| 用户确认后取消排期 | 真实工具单次确认调用返回 `success=true`；日历该条目消失 |
| 取消排期后保留模板 | Harness 查询及独立详情/训练库查询均确认模板仍在 |
| 用户确认后删除模板 | 真实工具单次确认调用返回 `success=true` |
| 删除后的回读 | 详情 HTTP 404；训练库无测试 ID；该日无测试排期 |
| 原有课表 | 前后完整查询均少于 100 条；排除测试 ID 后，原有 42 个 ID 的排序集合与 SHA-256 均一致 |

取消排期与删除模板各只执行一次确认写入，无写入重放。两个工具使用各自返回的一次性确认令牌；令牌未写入此记录。Harness 留在「Garmin 删除功能只读验收」会话的结果页，可在轨迹中查看实际工具调用。

## 证据与范围

本机脱敏证据目录：

```text
/Users/kent/.codex/garmin-release-checks/2026-10-18/workout-harness/
```

- `install-check.json`：安装版本、来源提交与编译文件一致性。
- `schedule-request.json`：测试夹具排期的单次请求及只读定位结果。
- `before.json`：预览后测试对象仍存在。
- `after-unschedule.json`：排期消失、模板保留、原有 ID 集合一致。
- `after-delete.json`：详情 HTTP 404、测试对象清理完毕、原有 ID 集合一致。

首轮删除后校验脚本只检查 Axios `response.status`，未识别产品脱敏错误的顶层 `status=404`，曾将详情回读记为 `read-error`。修正本机校验脚本的状态提取后，仅重做只读核对并通过；没有重发删除请求。原始校验记录保留为 `after-delete-initial-verifier.json`。

本轮覆盖一个大陆账号、一份测试模板和一次排期，不扩展为国际区或其他 Host 版本的在线验收。没有重新跑全量单元测试；上一步的定向单元/适配器测试与编译结果独立保留。本机当前安装的是开发候选，官方 npm 版本未改变。
