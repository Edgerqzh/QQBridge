# QQBridge

公开源码：[Edgerqzh/QQBridge](https://github.com/Edgerqzh/QQBridge)。原创代码使用 MIT 许可。

文本版已验证真实扫码、群消息收发和 OneBot WebSocket 推送。新增图片、文件、语音、提及与撤回处于显式启用的实验阶段，进展与使用方式见 [富媒体说明](docs/RICH_MEDIA.md)。

普通 QQ 账号接入的独立开发 MVP：使用指定 Linux QQ 客户端的原生能力，对外提供部分 OneBot 11 HTTP / WebSocket 接口，供 AI 应用接入。

**已在官方 Linux QQ `3.2.34-53644` x64 上验证真实链路：二维码 → 用户扫码 → 账号会话初始化 → 获取群列表 → 实时群文本接收 → 单次群文本发送，用户确认在群内收到。** 当前仍是针对单一构建的开发原型，尚未完整兼容 OneBot 11。最终源码重启、完整容器首次启动及接口回归的覆盖分别见 [功能清单](docs/FEATURES.md)。

本项目独立编写，不随源码分发 QQ 客户端或账号数据。

## 运行方式

| 方式 | 提供什么 | 验证范围 |
| --- | --- | --- |
| Node.js / Docker 网关 | HTTP、正向与反向 WebSocket、鉴权、内部桥接 | 网关可在 Windows 开发；Linux 容器已做接口测试 |
| Linux QQ 原生运行时 | 扫码、账号会话、群列表、普通群文本收发 | 官方 QQ `3.2.34-53644` x64，Debian 13 x64，Node.js 24.22.2 |
| 完整原生容器 | 官方 QQ、原生依赖、网关与 runtime，由 supervisor 联合管理 | Linux amd64 镜像、新数据卷启动和真实二维码已验证 |

**使用 QQ 能力推荐显式选择 `compose.native.yaml`。普通 `Dockerfile` / `compose.yaml` 保留为仅网关模式，不包含 QQ runtime。**

## 推荐：完整原生 Docker

本机安装 Node.js 22+ 和 Docker，进入源码目录，生成本地配置并构建：

```bash
npm ci
npm run init
docker compose --env-file .env -f compose.native.yaml up --build -d
```

构建会从腾讯官方源下载并解压指定 QQ 客户端。首次登录保持 `QQBRIDGE_LOGIN_UIN` 为空；可先在 `.env` 设置群白名单。容器启动后获取并复制二维码到本机：

```bash
docker compose --env-file .env -f compose.native.yaml exec qqbridge npm run qrcode
mkdir -p data
docker compose --env-file .env -f compose.native.yaml cp qqbridge:/app/data/login-qr.png ./data/login-qr.png
```

PowerShell 中可用 `New-Item -ItemType Directory -Force data` 创建本机目录。打开 `data/login-qr.png`，由账号持有人使用手机 QQ 扫码确认。二维码和账号资料保存在容器 named volume 中；停止服务使用同一 Compose 文件的 `down`，默认保留数据。

容器以 UID 1000 运行，只发布宿主 `127.0.0.1:5700`，原生 IPC `5711` 仅在容器回环使用。网关或 runtime 任一子进程退出时，supervisor 联停另一进程；SIGTERM 正常联停。健康检查允许“runtime 已连接、等待扫码”的状态，不能将健康直接视为 QQ 在线。

完整容器的新卷启动、真实二维码和退出管理已验证；容器内扫码后的完整收发覆盖与此前原生宿主实验分别记录，见功能清单。

## 手动运行：准备

网关需要 Node.js 22 或更高版本。在项目目录执行：

```bash
npm ci
npm run init
npm test
npm run doctor
```

`init` 生成含独立随机令牌的 `.env`，不会覆盖已有文件。`doctor` 只检查安装信息。原生运行时按已验证的 Node.js 24.22.2 / Debian 13 x64 环境准备，需 C 编译器、`libgnutls.so.30` 及官方 QQ 模块要求的共享库。

准备官方 Linux QQ 包：

```bash
npm run prepare:qq -- --arch x64 --destination data/qq --extract
```

`--extract` 需要 Linux 的 `dpkg-deb`；去掉它可以只下载。脚本读取腾讯当前官方下载配置，请确认取得本项目支持的 `3.2.34-53644` x64，其他构建会被驱动拒绝。回执记录版本、来源、大小和本地 SHA-256；目前没有可供比较的官方摘要。已有包、解压目录和回执不会被覆盖。

默认客户端目录为 `data/qq/extracted/opt/QQ/resources/app`，可通过 `QQBRIDGE_QQ_APP` 调整。

## 手动运行：启动与扫码

网关和原生运行时须位于同一网络命名空间。项目目录中先运行：

```bash
npm start
```

第二个 Linux 终端启动原生运行时：

```bash
sh scripts/run-native-runtime.sh
```

脚本编译并预加载本项目兼容层，读取 `.env`，启动登录和账号会话流程。第三个终端获取二维码：

```bash
npm run qrcode
```

带鉴权 API 返回的图片通过 PNG 签名和 1 MiB 上限校验后，保存为 `data/login-qr.png`。请由账号持有人使用手机 QQ 扫码确认。取码客户端不会输出 base64、令牌或请求 URL，也不会额外轮询、确认登录或发送消息；QQ 原生模块负责其二维码状态轮询。

默认进行扫码。只有显式设置 `QQBRIDGE_LOGIN_UIN`，且同一 profile 已缓存该账号并允许快速登录时，才尝试该账号的快速登录；不会自动选择缓存列表中的首个账号。

扫码后的账号选择、原生登录结果和消息会话分别记录。明确成功结果兼容整数 `0` 和规范字符串 `"0"`；仍等待的 Promise 不会被人为填入成功结果。在线要求初始化和启动成功、身份匹配、MSF `(1, 0)`、健康 dispatcher 及无未知依赖，并具备明确原生登录成功或真实实时非导入消息这两种证据之一。静默群无需先发消息；最终源码已在零入站消息时真实报告在线。

## 当前接口能力

| 原生动作 | 范围 |
| --- | --- |
| `get_login_qrcode` | 登录 PNG 及有效期等信息 |
| `get_login_state` | 登录、账号选择、会话与在线证据状态 |
| `get_login_info` | 当前账号信息 |
| `get_group_list` | 原生会话返回的群列表 |
| `send_group_msg` | 普通群文本，最多 4096 UTF-8 字节，不解析 CQ 码 |

网关另提供 `get_status`、`get_version_info`。实时、非导入的群文本转换为 OneBot 群消息事件，默认忽略自身消息并做窗口内去重。

`message` 可以是字符串，或非空且全部为 `text` 的消息段数组。带 `[CQ:` 外观的字符串默认返回不支持；显式 `auto_escape: true` 或使用文本消息段时按字面文本处理。发送成功的标准数据为 `{ "message_id": <本进程别名> }`。

发送要求真实在线状态和目标群成员关系。`QQBRIDGE_ALLOWED_GROUPS` 同时过滤群列表、接收与发送。原生 ACK 成功只表示请求被接受；本次测试另由用户确认群内可见，才记录为实际送达。超时或回包异常保留“送达未知”，不自动重试。

原生 19 位消息 ID 保持字符串；对外别名为正 int32。映射和去重记忆默认 FIFO 容量 5000，只存在当前进程；淘汰或重启后旧别名失效，窗口外重复可能重新出现。映射不保存正文或昵称。

图片、文件、语音、完整 @、引用、撤回、私聊、多账号及通用自动会话恢复尚未支持；同一资料目录中明确选择缓存账号的快速登录已实现。可见 @ 暂按普通文本处理，未知或混合非文本元素不会伪装成已支持的消息。

## 网关连接

除 `GET /health` 外，请求使用 `Authorization: Bearer <token>`。WebSocket 通过握手请求头传令牌，不接受 URL token。

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 匿名检查，仅服务名与 `online`、`good` |
| `GET /:action` | 查询参数调用动作 |
| `POST /:action` | JSON 请求体传参数对象 |
| `POST /` | `{ "action": "...", "params": {}, "echo": "..." }` |
| `WS /`、`WS /onebot/v11` | 动作与事件合并连接 |
| `WS /api` | 仅动作 |
| `WS /event` | 仅事件 |

```bash
curl -H "Authorization: Bearer $QQBRIDGE_TOKEN" \
  http://127.0.0.1:5700/get_status
```

常用错误码：`1400` 参数无效、`1401` 鉴权失败、`1404` 能力不存在、`1503` 原生会话不可用、`1504` 超时。消息发送超时不表示一定未发出，请勿直接自动重试。

反向 WebSocket 默认关闭。配置地址与独立令牌后，只有真实账号身份有效时才建立连接，握手携带 `X-Self-ID`、`X-Client-Role: Universal`。账号变化会更换连接；离线事件不缓存重放，旧连接的动作结果不会发给新连接。

## 配置

| 环境变量 | 用途 | 默认或要求 |
| --- | --- | --- |
| `QQBRIDGE_HOST` / `QQBRIDGE_PORT` | 网关监听 | 本机 `127.0.0.1:5700`，容器内地址为 `0.0.0.0` |
| `QQBRIDGE_TOKEN` | API 令牌 | 至少 32 字符 |
| `QQBRIDGE_BRIDGE_HOST` / `QQBRIDGE_BRIDGE_PORT` | 原生回环 IPC | 默认 `127.0.0.1:5711` |
| `QQBRIDGE_BRIDGE_TOKEN` | 原生 IPC 令牌 | 至少 32 字符，与 API 令牌不同 |
| `QQBRIDGE_DRIVER` | ESM 驱动 | 原生启动脚本自动选择 Linux 驱动 |
| `QQBRIDGE_QQ_APP` | QQ 的 `resources/app` | 手动默认本地 `data/qq`；完整容器使用镜像路径 |
| `QQBRIDGE_QQ_PROFILE` | 原生账号资料目录 | 手动默认 `data/qq-profile`；完整容器使用 named volume |
| `QQBRIDGE_LOGIN_UIN` | 同一 profile 内明确选择的缓存账号 | 默认空，使用扫码；需原生允许快速登录 |
| `QQBRIDGE_EXPERIMENTAL_RICH_MEDIA` | 实验富媒体、提及、撤回与缓存取回 | 默认 `0`，设置 `1` 启用；详见富媒体说明 |
| `QQBRIDGE_ALLOWED_GROUPS` | 逗号分隔的正整数群白名单 | 默认空，允许账号已加入的群 |
| `QQBRIDGE_REVERSE_WS_URL` | AI 应用反向 WebSocket 地址 | 默认空；仅 `ws://` / `wss://`，不接受内嵌凭据或 fragment |
| `QQBRIDGE_REVERSE_WS_TOKEN` | 反向连接令牌 | 启用时至少 32 字符，与前两令牌不同 |

`data/` 包含二维码、设备标识和可能的会话数据，不进入源码或发布包。QQ 原生库可能输出自身诊断信息，运行日志也应按账号数据保管。

## 可选：仅运行 Docker 网关

```bash
export QQBRIDGE_TOKEN="$(openssl rand -hex 32)"
export QQBRIDGE_BRIDGE_TOKEN="$(openssl rand -hex 32)"
docker compose up --build -d
```

Compose 只发布宿主 `127.0.0.1:5700`，不发布原生 IPC；镜像以普通 `node` 用户运行。默认部署不支持从宿主机或另一容器跨网络连接原生 IPC。未连接原生运行时时，状态如实为离线。

## 验证与来源

2026-10-30 已在上述指定 Linux QQ 构建和宿主环境完成真实扫码、会话初始化、群列表、文本接收和仅一次获准发送；群内送达由用户确认。带鉴权的 OneBot WebSocket 也已捕获有效群文本事件。

最终 116 测试版源码在同一 profile 冷启动中，已在没有入站消息时依据明确原生登录成功完成在线就绪，并通过 HTTP 与鉴权 WebSocket 的只读动作验证账号状态和白名单群列表。后续真实原生消息到达时，空 no-change 群更新也未清空缓存；没有再次发送。完整原生容器的新数据卷取码与进程管理另外记录，尚未在该新卷复测登录后完整收发。

Windows 与隔离 Linux 自动化全量均为 116/116。确证和边界见 [验证记录](docs/VALIDATION.md)，能力清单见 [FEATURES](docs/FEATURES.md)；公开记录不含真实账号、群号、正文或票据。驱动合同见 [DRIVER](docs/DRIVER.md)，原生实现见 [native README](src/native/README.md)。

原创代码采用 [MIT](LICENSE)。公开资料和依赖见 [来源记录](docs/PROVENANCE.md)；第三方依赖及 QQ 客户端分别适用自身许可，本项目开源不表示获得腾讯的平台接入或商业运营授权。
