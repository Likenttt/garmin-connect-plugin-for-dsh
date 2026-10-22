# Garmin Connect Personal API：SDK 生态与 TypeScript 封装机会

核查日期：2026-10-22（Asia/Shanghai）。最初阶段核查公开官方文档、官方与社区源码、PyPI / npm 官方注册表，未使用凭据；当日随后经用户授权，补充大陆密钥创建、新 TS SDK 与真实插件 MCP 验证。下文保留研究及实测的时间顺序，公开记录不包含 Key、token 或健康数据。

## 结论

**官方已经有 Personal API 的 Python SDK 与 CLI；最初生态检索没有确认可直接采用的 Personal API TypeScript SDK。此后本项目已建立独立仓库 [Likenttt/connect-personal-api-ts](https://github.com/Likenttt/connect-personal-api-ts)，参考官方 Python 实现 API Key 换 token 与数据读取。** 源码版本为 `@likenttt/connect-personal-api-ts@0.1.0`，本轮未发布 npm；独立仓库代码与 npm 上架状态分开记录。[官方 Python 仓库](https://github.com/garmin/connect-personal-api-python)、[官方 Python 包](https://pypi.org/project/garmin-connect-personal-api-python/)。

新 SDK 支持 `region: 'global' | 'cn'`，分别路由 `personal.connectapi.garmin.com` / `personal.connectapi.garmin.cn`，也可显式配置 `baseUrl`。**大陆 Key 请求对应 `.cn` 的实测在换 token 时返回 HTTP 526，未取得 token、未执行数据读取；地区配置支持不等于该端点本次可用。** 此前大陆 Key 请求 `.com` 的 404 是跨区请求结果，不能用于证明大陆端点不支持。

## 已确认的实现

| 项目 | 实际协议与定位 | 判断 |
| --- | --- | --- |
| `garmin/connect-personal-api-python` | Garmin 官方；ApiKey 换 Bearer，调用 `personal.connectapi.garmin.com`；Python 客户端和 `gc-personal` CLI | **真正的新 Personal API SDK**。[源码](https://github.com/garmin/connect-personal-api-python/tree/ac111a0ff8e37dfbc24c616fcc27691520c7278b) |
| `Likenttt/connect-personal-api-ts` | 本项目独立维护；参考官方 Python 实现 Personal API Key / token 与数据读取，支持 `global` / `cn` 及显式 `baseUrl` | **已建立源码仓库，本轮未发布 npm；大陆对应端点实测换 token 返回 526**。[仓库](https://github.com/Likenttt/connect-personal-api-ts) |
| `cyberjunky/python-garminconnect` | 已核查 master `5ddb9eecbc938b83ddb27a8f57552c556f112310`；仍有 mobile / widget / portal SSO 登录链与 DI token；未发现新 Personal 域名或换 token 路径支持 | **现有私有 Connect 客户端，不能当作新官方 SDK**。[SSO 实现](https://github.com/cyberjunky/python-garminconnect/blob/5ddb9eecbc938b83ddb27a8f57552c556f112310/garminconnect/client/sso.py)、[域名及 DI 常量](https://github.com/cyberjunky/python-garminconnect/blob/5ddb9eecbc938b83ddb27a8f57552c556f112310/garminconnect/client/constants.py) |
| `matin/garth` | 官方仓库明确标注停止维护，旧的 SSO / OAuth1 路线 | **不是 Personal API SDK，也不宜作为新认证实现底座**。[维护者说明](https://github.com/matin/garth#garth) |
| npm `garmin-connect@1.6.2` | npm 包指向 `Pythe1337N/garmin-connect`；源码使用登录 ticket、OAuth1、OAuth2 exchange | **旧私有 API SDK**。[npm](https://www.npmjs.com/package/garmin-connect)、[固定版本源码](https://github.com/Pythe1337N/garmin-connect/blob/b2718bfe7c8454348d42a3cd72ff9dc1e2dfba0d/src/common/HttpClient.ts) |
| npm `@likenttt/garmin-connect@1.7.0` | 当前维护包，registry 指向 `Likenttt/garmin-connect`；新 Personal 认证需独立实现 | **可以继续服务现有 Connect 功能，不应将旧 token 当成新 Personal token**。[npm 官方 registry](https://registry.npmjs.org/%40likenttt%2Fgarmin-connect/latest)、[仓库](https://github.com/Likenttt/garmin-connect) |
| `azaitsev/gc2everywhere` | Python 应用内置 Personal 客户端，ApiKey / Bearer、活动列表和下载、401 后重新取 token 一次 | **真实社区实现，但不是通用 TS SDK**。[源码](https://github.com/azaitsev/gc2everywhere/blob/0a1d2b343537fd6b15aeeb15f22ea38641abe5eb/src/gc2everywhere/garmin.py) |
| `marlima10/aurora-lab` | Python 应用内置 Personal 客户端，限定官方 host、禁用重定向、活动读取 | **真实社区实现，可借鉴凭据传输边界**。[源码](https://github.com/marlima10/aurora-lab/blob/5ec5322613eb05482cbb9ef015a707cb7a074c4c/docker/server/garmin/personal_api.py) |
| `eddietheengineer/personal-cycling-agent` | Python 应用将 Personal 设为主要读取源，并保留可切换旧客户端；实现健康、HRV、睡眠、活动与 FIT 下载 | **真实双 provider 应用案例，不应直接认作稳定通用 SDK**。[源码](https://github.com/eddietheengineer/personal-cycling-agent/blob/93e82959bd6f06be51aebeabd7bb71f71c02f1a0/personal_cycling_agent/src/ingestion/garmin_personal.py) |

其他 TS 候选如 `DynamicsNinja/garminconnect-js`、`marcel-tuinstra/garmin-connect-sdk` 的 README 仍明确描述私有端点和 SSO，不能因标题里有“personal data”或“SDK”就认为支持新协议。[前者说明](https://github.com/DynamicsNinja/garminconnect-js)、[后者说明](https://github.com/marcel-tuinstra/garmin-connect-sdk)。

## 官方 Python SDK 可直接借鉴的契约

源码固定在 `ac111a0ff8e37dfbc24c616fcc27691520c7278b`。PyPI 已发布 `1.0.0`，要求 Python >=3.12，项目元数据标为 Beta，Apache-2.0。[PyPI 元数据](https://pypi.org/pypi/garmin-connect-personal-api-python/json)、[pyproject](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/pyproject.toml)。

- **认证与资源客户端分开**：`PersonalApiAuthenticator` 负责拿 token；`GarminPersonalApiClient` 接受已签发 Bearer。认证调用 POST `/personalapitoken-service/personal-api/personal-api-key/token`，头为 `Authorization: ApiKey …`，返回内容按纯文本 JWT 处理；资源 GET 使用 Bearer。[auth.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/auth.py)、[client.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/client.py)。
- **缓存按 Key 与环境区分**：SHA256 fingerprint 包含 base URL 和 key，JWT `exp` 剩余超过一小时才复用；否则重新以 API Key 签发。这里的 `force_refresh` 是重新签发，**不是 OAuth refresh token grant**。[auth.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/auth.py)。
- **官方示例不自动重试 401**：调用者需重新获取 token 再 `update_bearer_token()`；超时可配。文件缓存包含明文凭据，POSIX 新文件 0600，不能宣传为“加密存储”。[README 认证说明](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/README.md#bearer-token-cache)。
- **健康读取覆盖到我们的关键需求**：有 HRV 单日/范围、SpO2、睡眠、心率、Body Battery、日汇总，以及活动搜索、详情、已完成活动的关联训练和原始活动 ZIP 下载。关联训练读取并非训练库 CRUD。[client.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/client.py)。
- **官方 Python 默认 `.com` Personal host**：常量允许环境覆盖。后续本项目的 TS SDK 明确提供 `global` / `cn` 地区配置；端点路由与真实服务可用性分别验证，不能通过大陆 Key 请求 `.com` 的失败推断 `.cn` 的状态。[constants.py](https://github.com/garmin/connect-personal-api-python/blob/ac111a0ff8e37dfbc24c616fcc27691520c7278b/src/garmin_personal_api/constants.py)。

## 容易混淆的几个“官方 SDK”

- **FIT JavaScript SDK `@garmin/fitsdk`**：处理 FIT 文件编码/解码；可以作为下载后的可选解析组件，不能负责 Connect 云端授权或数据拉取。[官方 FIT JS 仓库](https://github.com/garmin/fit-javascript-sdk)。
- **Garmin Health Standard / Companion SDK**：企业合作伙伴的 Android / iOS 设备集成与实时传感器流产品，不是 Personal 云 API 的 JS 客户端。[官方 Health SDK 概览](https://developer.garmin.com/health-sdk/overview/)。
- **Business Connect API**：与 Personal 有独立申请、用户接入与数据交付条件；官方概览将 Personal 列为自身数据、Pull only。不可把 Business Webhook 或写训练能力算进 Personal MVP。[官方方案对照](https://developer.garmin.com/gc-developer-program/overview/)。

## 与官方 OpenAPI 的交叉核验

主研究从官方 Swagger 页公开前端资源提取 OpenAPI 1.0.0，26 条路径全部为 GET、109 个 schemas；所有操作均无 `operationId`，也没有 `securitySchemes`。这意味着可以生成请求/响应类型，但认证、方法命名和易用客户端仍需手工维护；单纯 codegen 不等于 SDK 已可用。[官方 Swagger 入口](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)。本次提取文件 SHA-256：`b841f78f10952c334944dcc0ac4a345a65a3cca9cee5aa8529c7af21de8bd960`。

HRV 有两条正式读取路径，SpO2 有独立单日接口。没有独立全天呼吸时序路径，但有可用汇总：`UserDailySummaryDto` 含清醒呼吸均值及高/低/最新值；`DailySleepDTO` 含睡眠呼吸均值/最低/最高；`UserDailySummaryV2DTO.respiration` 指向 `RespirationV2DTO`，后者包含 `avgValue/maxValue/minValue/latestValue/latestTimestampGmt/algorithmVersion`。因此可支持**呼吸汇总**，不能承诺返回完整全天曲线。当前 OpenAPI 未列训练模板创建/删除、日历排期或 Webhook。[官方 Swagger](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)。

## 落地选择与实现状态

最初工程建议为同仓库独立模块；**用户随后明确选择新仓库，实际已建立 [Likenttt/connect-personal-api-ts](https://github.com/Likenttt/connect-personal-api-ts)**，包名为 `@likenttt/connect-personal-api-ts`。新 SDK 集中实现 Personal API Key → token → 数据读取，不把 Key 混入其他凭据格式，也不把其他接口的成功视为 Personal API 验证通过。

新 SDK 的认证与资源读取使用独立的 Personal 数据契约，支持可注入请求、令牌缓存、地区路由和受控错误。类型与路径以官方 Swagger 为依据，工程审查关注凭据隔离、并发取 token、只读重试、429 退避、敏感字段过滤及重定向边界。源码已建立，本轮未执行 npm 发布。

DSH / MCP 账号显式选择 `personal` provider，按所配置地区发送 Key，并仅暴露该接入支持的能力。真实插件 MCP 验证已在无邮箱配置下启动并返回 **15 项工具**，包含 HRV，未暴露 Garmin 写操作工具；读取 profile 时安全返回 `.cn` 的 526，未返回浏览器认证 challenge。该验证确认配置、工具能力和错误处理路径，不构成健康数据读取成功。

## 检索边界与未确认项

2026-10-22 使用 GitHub API 搜索精确域名 `personal.connectapi.garmin.com`、路径 `personalapitoken-service`，确认官方 Python 及上列社区 Python 源码；加 `language:TypeScript` 或 JavaScript 的精确查询未找到相应实现。Garmin 官方组织公开仓库清单中确认 Personal Python 项目，未确认官方 Personal TS 项目。**代码索引有延迟、只检索公开默认分支，因此结论是“此次未找到可核验的 TS SDK”，不是“全网没有”。**

npm 官方 registry 核查：`garmin-connect` latest 为 1.6.2，`@likenttt/garmin-connect` latest 为 1.7.0；`garmin-connect-personal-sdk` 与 `@likenttt/garmin-connect-personal-sdk` 精确包名查询当时均返回 404。包名当时不存在不等于获得命名保留，也不能替代全面市场检索。[registry 检索接口](https://registry.npmjs.org/-/v1/search?text=garmin%20personal%20api&size=20)。

最初公开研究阶段未进行凭据实测，也未运行第三方项目代码；后续获授权实测见下节。当前尚未确认大陆端点成功读取、实际日请求限制、运行时响应与 schema 的一致性 / 空值语义、生产稳定性，以及官方未来是否补 JS SDK。当前公开规范的呼吸能力只确认到上述汇总字段。

## 当日后续：获授权的大陆账号实测

上文记录最初公开资料研究的边界；此后用户明确授权进行大陆主账号申请、创建 30 天测试密钥及只读验证。

- 大陆站普通设置导航本次没有 Personal API 入口，但直达 `https://connect.garmin.cn/app/settings/personalApiToken` 可以打开创建界面。文案及条款显示为未翻译的 `personal_api_*` 键名；展示截图后，用户明确授权继续。
- 创建表单选择 30 天，页面显示创建成功；密钥安全保存在本机私密文件（0600），重新加载后仍显示密钥记录。
- 首轮将大陆 Key 发往官方文档示例中的 `.com` token endpoint，返回 **HTTP 404 JSON / `NotFoundException`**，找不到对应 Key ID；复查相同。无 Authorization 对照返回 **HTTP 400 / `Authentication missing`**。这是跨区请求观察，不能据此判断 `.cn` 不支持。
- 首轮对 `personal.connectapi.garmin.cn` 的无凭据检查可见 DNS 记录，但 HTTPS 返回 526；**在该阶段尚未发送 Key**。此后用户明确要求按创建 Key 的地区路由，新增 TS SDK `region` 配置并执行下一阶段真实请求。
- 2026-10-22 11:17（Asia/Shanghai），以 `new GarminPersonalApiClient({ region: 'cn', apiKey: … })` 请求 `getUserProfileSettings`，实际目标为 `https://personal.connectapi.garmin.cn`。token 交换返回 **HTTP 526 / `TOKEN_EXCHANGE_FAILED`**；未取得 token，因此未执行后续 profile 或健康数据请求。
- 11:19，真实插件 MCP 使用 `provider=personal`、`region=cn`、无邮箱配置启动。`tools/list` 返回 **15 项工具**，包含 HRV、没有 Garmin 写操作工具；profile 请求安全返回 526，没有浏览器认证 challenge。此结果验证了 Personal 工具挂载与失败处理，不代表数据已读取成功。

**当前结论：独立 TS 仓库与地区配置已实现，本轮尚未跑通大陆 Personal 数据读取。** `.com` 跨区 404 和 `.cn` token 交换 526 是两项不同证据；后者只说明本次对应端点服务访问失败，不能断言大陆全面不支持。脱敏依据为本机 `cn-sdk-canary-result.json` 与 `plugin-mcp-canary-result.json`，均未记录 Key、token 或健康数据；文章另使用已脱敏截图说明申请过程。
