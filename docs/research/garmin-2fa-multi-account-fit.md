# Garmin 两步验证、多账号与 FIT 下载研究

> 调研日期：2026-08-20。本文只做技术决策与实现约束，不代表 Garmin 官方支持这些私有接口，也不建议据此直接发布正式版。

## 当前源码实现状态（未发布）

当前 checkout 已按本文约束实现第一阶段能力，但 npm `0.1.4` 尚不包含这些改动：

- `npm run auth:setup -- --account <alias> --region global|cn` 在可信本地 TTY 中隐藏输入密码和 MFA 验证码，保存兼容现有 Node 客户端的私有 OAuth session 文件（POSIX 为 `0600`；Windows ACL 尚未显式校验）。新文件把去除首尾空白、NFKC 规范化并小写化 username 的不可逆 SHA-256 摘要及 region 绑定到 session；运行时错配会在加载 token 前拒绝。旧的 `oauth1`/`oauth2` 两字段无绑定文件仍可兼容读取。私有 widget SSO 流程仍是实验性能力，尚未使用真实 MFA 账号完成端到端验证。
- 运行时可通过 `GARMIN_SESSION_TOKEN_FILE` 读取 session，不再需要密码。认证、验证码提交和 token 导出均不暴露为 MCP/AI 工具。
- 多账号第一版采用进程隔离：每账号一个 session 文件、一个 dsh profile/MCP server/process。单进程账号选择器和多租户 ACL 尚未实现。
- `download_garmin_activity_fit` 要求用户显式配置 `GARMIN_FIT_DOWNLOAD_DIR` 父目录（无默认目录，未设置时写入前失败），把唯一有效 FIT 安全提取为 `<base>/GARMIN_FIT_<用户邮箱>/<activityId>.fit`。邮箱部分会安全规范化：普通邮箱保持可读，不安全文件名字符会替换；多个账号进程可共享父目录。工具不覆盖文件，只向模型返回 activity ID、文件名、大小和 hash，不返回父目录、账号子目录、邮箱或完整路径；原始 ZIP 不保证一定包含 FIT。

在真实国际区/中国区 MFA smoke test 完成前，这些能力应继续保持未发布状态。

## 结论

最容易先落地的是 FIT 下载和多账号隔离；真正困难的是在不关闭两步验证的前提下，可靠地产生并续期每个账号的会话。

建议按以下顺序实现：

1. 先用当前依赖完成“下载原始活动 ZIP，并安全提取其中的 `.fit`”——低难度。
2. 引入按账号别名隔离的 token store、客户端、缓存和刷新锁——中等难度。
3. 增加一个完全独立于 MCP 的本地 `auth` CLI；密码和验证码只在用户自己的 TTY 中输入，不进入 DSH、Codex、Claude Code、MCP 参数、日志或模型上下文。
4. MFA 认证后端先放在实验分支验证：
   - 仅要求国际区、可以升级 Node 24：整体迁移并固定 `garmin-connect-sdk@1.0.0` 是最短的纯 Node 路径，但该库非常新，且当前不支持 `garmin.cn`。
   - 需要中国区或保留 Node 20：`python-garminconnect@0.3.11` 的本地 bootstrap + Node DI-token 适配器，或 Python sidecar，更现实；它不是现有 Node token 的即插即用生成器。
   - 直接给 `garmin-connect@1.6.2` 补 widget MFA 可以保持旧 token 格式，但要维护 cookie、CSRF、验证码发送、WAF 和私有页面解析，长期成本最高。
5. 真实账号完成国际区/中国区、邮箱/SMS/TOTP、token 刷新、进程重启和 FIT 下载 smoke test 前，保持预发布状态。

## 可行性与难度

| 方案 | 不关闭 2FA | 与当前 `{oauth1, oauth2}` 直接兼容 | 中国区 | 难度 | 判断 |
| --- | --- | --- | --- | --- | --- |
| 当前 `garmin-connect@1.6.2` + 已有旧 token | 只能复用已取得的会话，不能完成新的 MFA 登录 | 是 | 是 | 低 | 仅可作为过渡方案 |
| 给当前 Node 登录流补 widget MFA | 可以 | 是 | 理论上可以，需分别实测 | 高 | 仅在必须保留 Node 20、旧 token 和中国区时考虑 |
| 整体迁移到 `garmin-connect-sdk@1.0.0` | 可以，支持 `mfaCode` provider | 否，使用 DI access/refresh token | 当前不可以，域名硬编码为 `.com` | 中 | 国际区实验分支的最短纯 Node 方案 |
| `python-garminconnect@0.3.11` 只做 bootstrap + Node DI 适配 | 可以，含多种登录回退 | 否；必须新写 DI token 装载/刷新层 | 可以 | 中 | 中国区和 Node 20 的优先 PoC |
| `python-garminconnect@0.3.11` sidecar 负责全部请求 | 可以 | 不需要兼容 | 可以 | 中 | 登录可靠性较好，但引入 Python 3.12+/进程协议和部署成本 |
| `garth` | 新登录已失效 | 不应依赖 | 不应依赖 | 不可行 | 排除 |
| Garmin 官方 Activity API | 使用官方 OAuth 2.0 用户授权，不需要代管密码/MFA | 否 | 由官方项目能力决定 | 高 | 商业/正式多用户产品的长期方案 |

## Garmin 官方行为

Garmin 官方说明的流程是先输入密码，然后通过短信或邮箱收到安全码；验证码有效期为 30 分钟。`Remember Me` / `Remember This Browser` 只会减少同一浏览器后续登录次数，并不是可供第三方客户端依赖的 token API。[Garmin：Two-Step Verification on Garmin Accounts](https://support.garmin.com/en-US/?faq=uGHS8ZqOIhA0usBzBMdJu7)

两步验证可能因账号关联设备和健康功能而成为必需项；不能把“临时关闭 2FA”设计成产品正常流程。[Garmin：Permanent Two-Step Verification](https://support.garmin.com/en-IN/?faq=xv3FAPq8hgAwkWnTo6TO98)

这也说明 `GARMIN_MFA_CODE` 不是长期配置：它短时有效，而且非交互式重启时很可能已经失效。更重要的是，私有登录实现必须把验证码提交到产生 challenge 的同一 SSO 会话；把它拆成无状态 MCP 工具调用会丢失 cookie/CSRF 上下文。

## 当前项目和上游 `garmin-connect@1.6.2`

当前项目固定使用 [`garmin-connect@1.6.2`](../../package.json)。上游 token 核心格式是
`oauth1` + `oauth2`；当前 auth CLI 在 session 文件外层增加可选的账号绑定：

```json
{
  "oauth1": { "...": "..." },
  "oauth2": { "...": "..." },
  "account": {
    "usernameHash": "<64-character SHA-256 hex digest>",
    "region": "global"
  }
}
```

`usernameHash` 来自去除首尾空白、NFKC 规范化并小写化后的 username，不保存明文邮箱；
runtime 会同时校验 digest 和 region，错配时在加载 OAuth token 前拒绝。为保持向后兼容，
项目的 [`GarminClient`](../../src/client.ts) 仍接受只有 `oauth1`、`oauth2` 的旧两字段文件，
但旧文件没有账号绑定保护；POSIX 上仍必须满足当前 owner-only 文件权限检查（通常
`0600`）。配置和运行时仍以一个 Garmin 账号/进程为中心。

上游仓库当前仍是 1.6.2，README 把 `Handle MFA` 列为未完成事项；源码中的 `handleMFA(htmlStr)` 是空函数，登录找不到 ticket 时只抛出“凭据或 MFA”错误。因此，给现有配置加一个验证码字段不会生效。[上游 README](https://github.com/Pythe1337N/garmin-connect#readme)；[上游 `HttpClient.ts`](https://github.com/Pythe1337N/garmin-connect/blob/master/src/common/HttpClient.ts)；[上游 `package.json`](https://github.com/Pythe1337N/garmin-connect/blob/master/package.json)

### 旧 token 的刷新语义

`garmin-connect@1.6.2` 会在 OAuth2 响应上计算 `expires_at` 和 `refresh_token_expires_at`，但正常请求路径主要在收到 HTTP 401 后才刷新。所谓刷新不是使用 OAuth2 `refresh_token`，而是拿保存的 OAuth1 token 再执行一次 OAuth2 exchange。[上游刷新实现](https://github.com/Pythe1337N/garmin-connect/blob/master/src/common/HttpClient.ts)

这意味着：

- OAuth1 token 仍有效时，即使磁盘中的 OAuth2 access token 已过期，进程也可能在首次 401 后恢复。
- 上游自带的刷新队列是模块全局状态；当前项目已用每客户端刷新状态机替换它，这对多账号尤其重要。
- 当前进程内刷新后的 token 应重新原子写盘；否则每次重启都从陈旧 access token 开始。
- OAuth1 过期或被撤销后，必须重新完成密码 + MFA 登录。

## 现代 Python token 不能直接交给当前 Node 客户端

当前 `python-garminconnect` 已改用 DI OAuth bearer token，持久化字段是 `di_token`、`di_refresh_token`、`di_client_id`；它会在请求前检查有效期，并通过 `grant_type=refresh_token` 获取和保存新的 token。它的 README 也明确说明登录使用 mobile SSO、MFA callback、DI token exchange 和自动刷新。[项目认证文档](https://github.com/cyberjunky/python-garminconnect#-authentication)；[认证引擎源码](https://github.com/cyberjunky/python-garminconnect/blob/master/garminconnect/client.py)

所以答案是：**Python 当前 token 与本项目期待的 Node OAuth1/OAuth2 对象不直接兼容**。不能只跑一次 Python MFA 登录，然后把它的 JSON 填进现有 `GARMIN_SESSION_TOKEN`。

有两种显式集成方式：

1. Python sidecar 始终负责 Garmin 登录、刷新和 API 请求，Node 只调用 sidecar。
2. Python 只做本地 bootstrap；Node 新增 DI token adapter，把 `di_token` 用作 bearer token，并自行实现 DI refresh、轮换 token 的原子持久化和 401 重试。现有 `garmin-connect` 的数据方法可以继续复用，但其旧 OAuth1 刷新器必须被完全绕开。

第二种通常比重写所有活动/健康接口轻，但它仍然是一次认证层迁移，不能称为“token 格式转换”。如果 Python 登录只得到 `JWT_WEB` 回退会话而非 DI token，应失败关闭，不能默默生成 Node 无法续期的会话。

## 安全的本地 MFA bootstrap UX

当前独立命令的交互示意如下：

```text
npm run auth:setup -- --account personal --region global

Garmin email: user@example.com
Garmin password: [hidden]
Garmin verification code: [hidden]
Authentication succeeded.
Session saved securely to: <local owner-only path>
```

硬性约束：

- CLI 只允许在真实 TTY 中执行；密码和 MFA 均关闭回显。
- 用户应在自己的普通终端直接执行。不要让 Codex、Claude Code 或其他代理代为运行并输入凭据，否则终端工具记录仍可能进入模型上下文。
- 不提供 `authenticate_garmin` / `submit_mfa` MCP 工具；MCP 启动后只读取已保存 token。
- 不支持 `--password ...`、`--mfa-code ...` 命令行参数，避免 shell history 和进程列表泄露。
- 不把密码或验证码存入 `.env`、Harness 配置、轨迹、stdout、日志或错误对象。
- MFA provider 只在 Garmin 明确返回 challenge 后调用，并在同一进程、同一 cookie jar 中完成验证。
- 成功后立即丢弃内存中的明文密码和验证码，只保存 token。
- 新 session 同时保存不可逆 username SHA-256 摘要和 region 绑定；旧两字段 session 仅为兼容读取，建议重新生成。
- 自定义 `--output` 时，POSIX 上父目录必须 owner-only（通常 `0700`）；缺失父目录由命令安全创建。
- 默认拒绝非 TTY；若未来确有自动化需求，应通过系统 secret store/专用 fd 明确启用，不能退化为普通 MCP 参数。

### 使用新的 Node SDK 时的正确调用形态

`garmin-connect-sdk@1.0.0` 暴露 `mfaCode: string | MfaCodeProvider`。项目自己的 CLI 应直接传 provider，让 SDK 在收到 challenge 后才提示：

```ts
await garmin.login({
  email,
  password,
  mfaCode: async () => promptHidden('Garmin verification code: '),
})
```

这样 provider 在一次 `login()` 内运行，MFA 校验会复用密码登录响应中的 cookie。不要预先读取验证码，也不要先无验证码调用一次、捕获错误后再启动第二次登录。SDK 的公开使用指南确认了 `mfaCode`/`mfaCodeProvider`、会话恢复和文件存储接口。[SDK 使用指南](https://github.com/marcel-tuinstra/garmin-connect-sdk/blob/main/docs/usage.md)；[`AuthService.ts`](https://github.com/marcel-tuinstra/garmin-connect-sdk/blob/main/src/auth/AuthService.ts)

该 SDK 的优点是 MFA、DI refresh、刷新锁、token storage 和活动原始文件下载都在一个 Node 包中。限制也很明确：它要求 Node 24、仅 ESM、刚发布 1.0.0、采用度很低，而且认证/API 主机当前硬编码为 `garmin.com`，构造器没有公开 region 选项；因此不能直接替换本项目的中国区支持。[SDK README](https://github.com/marcel-tuinstra/garmin-connect-sdk#readme)；[`FileTokenStorage.ts`](https://github.com/marcel-tuinstra/garmin-connect-sdk/blob/main/src/auth/FileTokenStorage.ts)

### 使用 Python bootstrap 时的正确调用形态

若选择 `python-garminconnect@0.3.11`，阻塞式本地 CLI 可以让库在需要时回调本机隐藏输入：

```python
from getpass import getpass
from garminconnect import Garmin

client = Garmin(
    email,
    getpass("Garmin password: "),
    is_cn=(region == "cn"),
    prompt_mfa=lambda: getpass("Garmin verification code: "),
)
client.login(token_directory)
```

该版本支持 `is_cn`，并在成功后把 DI token 保存到指定目录；README 推荐相同的 `getpass` + `prompt_mfa` 模式。[Python API 示例](https://github.com/cyberjunky/python-garminconnect#python-code-examples)；[`Garmin` 包装类源码](https://github.com/cyberjunky/python-garminconnect/blob/master/garminconnect/__init__.py)

必须固定并审计当前补丁版本。该项目 `<=0.3.4` 曾因 token 文件权限过宽被列为高危，0.3.5 修复为目录 `0700`、文件 `0600`；0.3.10/0.3.11 又补充了 symlink、原子写、锁和 MFA 状态等加固。不要重新引入旧版。[安全公告 GHSA-wjhr-76vg-2hvc](https://github.com/cyberjunky/python-garminconnect/security/advisories/GHSA-wjhr-76vg-2hvc)；[项目 Releases](https://github.com/cyberjunky/python-garminconnect/releases)

### 邮箱/SMS 是否需要显式请求验证码

分登录流处理，不能一概而论：

- Mobile SSO 的登录响应通常负责触发验证码发送；`garmin-connect-sdk` 在同一响应上下文中直接调用 `/mobile/api/mfa/verifyCode` 校验。
- Widget SSO 并不保证在提交密码时已经发送邮箱/SMS 码。当前 `python-garminconnect` 会读取 `mfaMethod` 和 `codeSentTo`：如果方式是 `email`/`sms` 且 `codeSentTo` 为空，先调用 widget 的 `/sso/verifyMFA/mfaCode` 请求发送，再提示用户；TOTP/authenticator 不应调用发送接口。[Widget MFA 源码](https://github.com/cyberjunky/python-garminconnect/blob/master/garminconnect/client.py)；[0.3.9 修复记录](https://github.com/cyberjunky/python-garminconnect/releases/tag/0.3.9)

若给旧 Node SDK 打补丁，至少需要完整保留以下状态机：

1. GET 登录页并保存 cookie、CSRF。
2. POST 用户名/密码。
3. 解析 MFA 页面中的 `customerGuid`、`mfaMethod`、`locale`、`clientId`、`codeSentTo`。
4. 必要时显式请求邮箱/SMS 码。
5. 在本地 TTY 提示验证码。
6. 使用同一 cookie jar/CSRF POST 验证码并取得 service ticket。
7. 继续现有 OAuth1 -> OAuth2 exchange，随后原子保存 token。

这正是“给旧库加一个字符串参数”不够的原因。

## 为什么不使用 `garth`

`garth` 仓库已明确标记 deprecated/no longer maintained：Garmin 改变认证流后，新登录不会工作；只有已经保存且仍有效的 OAuth1 会话可能继续用到过期（项目说明约一年）。它过去虽有 MFA/恢复 API，但不能作为当前的新账号 bootstrap 依赖。[Garth 项目声明](https://github.com/matin/garth#readme)；[历史 SSO 实现](https://github.com/matin/garth/blob/main/src/garth/sso.py)

## 多账号设计

完整的单进程目标模型是“账号别名 -> 完整隔离的账号上下文”：

```text
AccountManager
  personal -> region + token store + Garmin client + refresh lock + cache/auth epoch
  family   -> region + token store + Garmin client + refresh lock + cache/auth epoch
```

要求：

- 别名只允许稳定、安全的字符集合，例如 `[a-z0-9_-]{1,32}`；文件名只用别名，不用邮箱。
- 每个账号有独立 token 文件、cookie jar、刷新 promise/文件锁、缓存和身份 epoch，禁止任何全局刷新队列。
- token 路径应位于用户配置/状态目录，不在仓库内；目录 `0700`、文件 `0600`，使用随机临时文件 + 原子 rename，拒绝 symlink 路径。
- auth CLI 使用自定义 `--output` 时，POSIX 上已有父目录必须不含任何 group/other 权限（通常为 `0700`）；缺失父目录由程序 owner-only 创建，不安全父目录应直接拒绝。
- token 刷新一旦返回新 refresh token，必须在释放账号刷新锁前写盘；跨进程共享同一账号时也要加文件锁。
- token 恢复后调用最小 profile 接口验证身份；保存不敏感、稳定的 profile ID/hash，下次不一致则隔离 token，防止把 A 的缓存或下载交给 B。
- 多于一个账号时，读取工具要求明确 `account`；写工具始终要求明确 `account` 和现有确认流程。不要静默选择“第一个账号”。
- 一个账号失败、限流或过期不能使其他账号断开。
- `auth remove <alias>` 只删除本地 token；它不等价于服务端撤销。token 泄露时还需在 Garmin 账号安全设置中处理。

当前第一版通过“每账号一个进程”支持查询/下载，不做跨账号聚合。这样无需把账号选择器和多租户 ACL 混入同一个 MCP 服务，权限边界、缓存键和结果归属也更容易审计。上面的 `AccountManager` 仍属于后续单进程方案。

## FIT 下载

Garmin 官方的 “Export Original” 返回设备最初上传的格式；多数新设备是 `.FIT`，但不是绝对保证。用户上传的原始文件也可能是 GPX/TCX 等格式。因此接口应同时保留 `original` 概念，不能把任意原始文件改名成 `.fit`。[Garmin：Export Original](https://support.garmin.com/en-IN/?faq=W1TvTPW8JZ6LfJSfK512Q8)；[Garmin：活动导出格式说明](https://support.garmin.com/en-GB/?faq=2gAni4SRVe9gYo1UDT9d37)

当前上游已经实现：

- `downloadOriginalActivityData(activity, dir, 'zip')`
- 私有 endpoint：`/download-service/files/activity/{activityId}`
- `responseType: 'arraybuffer'`
- 结果写为 `{activityId}.zip`

对应源码见 [`GarminConnect.ts`](https://github.com/Pythe1337N/garmin-connect/blob/master/src/garmin/GarminConnect.ts) 和 [`UrlClass.ts`](https://github.com/Pythe1337N/garmin-connect/blob/master/src/garmin/UrlClass.ts)。因此网络下载本身是低难度工作，重点是文件边界：

- 只接受正整数 activity ID。
- 输出父目录由本地管理员配置，不能让模型提供任意绝对路径或 `../`；程序自动使用安全规范化的账号邮箱创建 `GARMIN_FIT_<用户邮箱>` 子目录。
- 先下载到 owner-only 临时文件，设置超时和最大字节数，再原子移动。
- 验证 ZIP magic、条目数量和解压后总大小；拒绝绝对路径、`..`、symlink 和 zip bomb。
- 请求 `fit` 时，只接受归档中恰好一个可信的 `.fit` 条目；没有 FIT 就返回“原始格式不是 FIT”，不要伪造扩展名。
- 默认不覆盖现有文件；规范化邮箱账号子目录隔离多个账号，文件名使用 activity ID。
- MCP 只返回 activity ID、文件名、大小和 hash，不返回父目录、账号子目录、邮箱或完整本地路径，也不把 ZIP/FIT 转成 base64 或文本送进模型。用户根据自己配置的父目录与目录规则定位文件；FIT 常包含精确位置和健康数据。
- 每次下载按账号授权，不允许用 A 的活动 ID 在 B 的上下文中静默重试。

当前第一阶段工具语义：

```text
download_garmin_activity_fit({
  activityId: 123456789
})
```

账号由当前独立进程的 session 决定，输出父目录固定为本地管理员显式配置的 `GARMIN_FIT_DOWNLOAD_DIR`；该变量无默认值，未配置时工具在写入前失败。最终路径为 `<base>/GARMIN_FIT_<用户邮箱>/<activityId>.fit`，邮箱部分会安全规范化，普通邮箱可读、不安全字符会替换，所以多个账号进程可以共享父目录。工具只返回 activity ID、文件名、FIT 大小和 hash；用户按自己配置的父目录与目录规则定位文件。“下载 original ZIP”及 GPX/TCX 转换不在第一阶段工具范围内。

## 私有 API 风险

本项目、`garmin-connect@1.6.2`、`garmin-connect-sdk` 和 `python-garminconnect` 都使用未公开的 Garmin Connect SSO/connectapi 行为。它们可能随时改变、限流、触发验证码/CAPTCHA、被 WAF 阻断或停止工作；不能承诺 SLA，也不应通过激进重试规避限制。`garmin-connect-sdk` 自身也明确作出同样的非官方声明。[SDK disclaimer](https://github.com/marcel-tuinstra/garmin-connect-sdk/blob/main/DISCLAIMER.md)

正式商业、多用户产品应评估 Garmin Connect Developer Program。官方 Activity API 在用户同意后提供 FIT/GPX/TCX，使用官方 OAuth 2.0；但项目只面向 business/enterprise，典型集成期为 1–4 周并需审批。[Garmin Activity API](https://developer.garmin.com/gc-developer-program/activity-api/)；[Garmin Developer Program FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)

## 推荐验收门槛

在仍为预发布版本时完成以下检查：

- 国际区无 MFA、邮箱 MFA、SMS MFA、TOTP 各一次真实登录。
- 中国区至少覆盖项目实际使用的 MFA 方式。
- 验证码只有在 challenge 出现后才提示；错误码不会触发无限重发或自动重试。
- 两个账号并发请求和并发刷新，不串 token、缓存、日志或下载路径。
- access token 到期、refresh token 轮换、进程重启后的恢复均通过。
- token 文件权限、原子写、symlink、损坏 JSON 和账号身份不匹配测试通过。
- FIT、非 FIT original、恶意 ZIP、超大文件、重复文件和路径穿越测试通过。
- CI 不使用真实 Garmin 账号；认证/下载单元测试使用脱敏 fixture，真实 smoke test 仅由开发者本地显式运行。

满足这些门槛后再决定：国际区走全 Node DI，还是为了中国区保留 Python bootstrap/sidecar。不要在验证前把新的认证实现发布为稳定能力。
