# 实验性 Linux QQ 原生运行时

本目录包含独立编写的客户端兼容与适配代码，不包含 QQ 二进制或从零实现的 QQ 网络协议。

## 已验证的 MVP

2026-10-30，在官方 Linux QQ `3.2.34-53644` x64、Debian 13 x64、Node.js 24.22.2 上完成：

- 本项目 C 兼容层和 `libgnutls` 预加载后，模块加载与导出观察成功。
- 原生登录连接、二维码获取及用户扫码成功进入账号选择流程。
- 账号会话初始化结果 `0`，身份匹配，MSF 状态 `(1, 0)`。
- 取得真实群列表，并收到真实实时非导入群文本；带鉴权 OneBot WebSocket 也已捕获有效群文本事件。
- 经用户明确批准发送单次测试文本，原生 ACK 为 `0`，用户确认群内可见。

最终 116 测试版源码在同一 profile 的冷启动中，已完成显式缓存账号登录、账号会话初始化和 HTTP 白名单群列表查询；`scan_confirmed: false`，在尚无入站消息时已真实报告 `online: true`、`good: true`，依据为明确原生登录成功及就绪的会话 / MSF / dispatcher。带鉴权 WebSocket 的只读动作和 `echo` 也已验证，没有重复发送。Windows 与隔离 Linux 完整回归均为 116/116。分阶段确证与界限见 [验证记录](../../docs/VALIDATION.md)。

公开记录只保留版本、日期和状态，不包含真实账号、群号、正文、票据或实验 profile。首次实验中的真实收发、重启后的会话/HTTP 验证和完整容器的首次启动/取码验证分别记录。

## 模块

| 模块 | 职责 |
| --- | --- |
| `napi-shim.c` | 该 QQ 构建的模块注册兼容；仅当前宿主关闭故障转储 |
| `login-flow.mjs` | 区分扫码、账号选择、明确原生结果和在线会话证据，隔离晚到结果 |
| `linux-session.mjs` | 会话初始化、异步 dispatcher、消息和群列表监听、在线证据 |
| `messages.mjs` | 实时群文本转 OneBot，原生字符串 ID 与有界别名映射 |
| `account-actions.mjs` | 当前账号信息和由真实回调支持的群列表 |
| `send-text.mjs` | 单次普通群文本发送，4096 UTF-8 字节，不解析 CQ，不自动重试 |
| `driver-core.mjs` | 编排扫码、明确选择的缓存登录、账号会话、白名单、消息与动作 |
| `linux-driver.mjs` | 检查平台和 QQ 构建、准备资料目录，将原生模块接入编排 |

发送 ACK 仅表示请求被接受；超时或异常可能使送达结果未知。消息别名为进程内正 int32，FIFO 默认容量 5000，淘汰或重启失效；元数据不保存正文或昵称。图片、文件、语音、提及、引用接收和撤回的新增实验能力见 [富媒体说明](../../docs/RICH_MEDIA.md)；私聊、多账号及自动恢复仍待开发。

## 完整原生容器

`Dockerfile.native` 和 `compose.native.yaml` 在 Linux amd64 镜像内下载指定官方 QQ，准备依赖，并由 `scripts/run-container.mjs` 同时管理网关和原生运行时。项目目录先执行 `npm install` 和 `npm run init`，然后：

```bash
docker compose --env-file .env -f compose.native.yaml up --build -d
docker compose --env-file .env -f compose.native.yaml exec qqbridge npm run qrcode
mkdir -p data
docker compose --env-file .env -f compose.native.yaml cp qqbridge:/app/data/login-qr.png ./data/login-qr.png
```

完整容器已验证普通用户 UID 1000、新数据卷启动、真实二维码和 0700 profile。等待扫码时可以健康，`online` 仍为 `false`；这不代表已完成容器内扫码和消息收发。任一子进程退出会联停另一进程，SIGTERM 正常联停。API 仅发布宿主回环端口，原生 IPC 只在容器回环使用，资料保存在 named volume。

官方准备脚本的完整下载与解压已成功，包大小为 187185496 字节；SHA-256 只作本地复现记录，没有与官方发布摘要比对。

普通 `Dockerfile` / `compose.yaml` 继续保留为仅网关模式，不含 QQ 客户端或完整原生运行时。

## 手动运行

手动准备已验证版本的官方 QQ、Node.js、C 编译器、`libgnutls.so.30` 和 QQ 原生模块要求的共享库。在项目目录先生成 `.env` 并启动网关，再运行：

```bash
sh scripts/run-native-runtime.sh
```

脚本编译兼容层，读取 `.env`，默认选择 Linux 驱动。`QQBRIDGE_QQ_APP` 指定官方 QQ 的 `resources/app`，`QQBRIDGE_QQ_PROFILE` 指定独立资料目录。默认扫码，显式 `QQBRIDGE_LOGIN_UIN` 只选择同 profile 中可快速登录的对应缓存账号；不会自动选首条缓存记录。可选 `QQBRIDGE_ALLOWED_GROUPS` 同时过滤群列表、接收和发送。

`sh scripts/native-host.sh /path/to/resources/app` 只做模块导出探测，不是机器人入口。

## 状态与资料

原生快速登录的明确成功结果兼容整数 `0` 和规范字符串 `"0"`；持续等待的 Promise 保留未完成状态。在线要求会话初始化和启动结果均为 `0`、身份匹配、MSF `(1, 0)`、健康 dispatcher、无未处理依赖，并具备以下任一认证证据：绑定同一账号与流程代次的明确原生登录成功，或真实实时非导入消息。静默群无需先发消息来使机器人在线；项目没有伪造消息或登录结果。

群更新按原生类型维护有界公开 DTO 缓存：`0/1` 完整替换、`2` 增量更新、`3` 删除、`4` 与未知类型保持现有缓存。收到完整快照之前不宣称已掌握全量群列表，空的 no-change 通知不会清空群。

客户端版本和 appid 来自官方包，QUA 标识通过该构建的只读字符串观察确认；部分初始化枚举语义未完全确认，因此不宣称支持其他构建。

QQ 原生库可能输出自己的诊断信息。`data/`、二维码、运行日志和 profile 均按账号资料保管，不进入发布包。官方包准备脚本仅记录本地 SHA-256，没有宣称与官方摘要比对。

## 0.3 迭代

新增主动下载、账号隔离的持久媒体索引、FFmpeg/SILK 转码及本地登录网页。证据包含同账号原生登录回调、二维码确认、UID 匹配与 MSF/会话状态，不伪造仍等待的 Promise。详细接口、测试结果和限制见 [下载与转码](../../docs/DOWNLOAD_AUDIO.md)与[登录网页](../../docs/LOGIN_WEB.md)。
