# 功能与验证清单

QQBridge 是针对单一 Linux QQ 构建的普通账号文本收发 MVP。代码能力、自动化测试和真实 QQ 验证分别记录，不将替身后端当作 QQ 接入证据。

新增实验能力见 [富媒体说明](RICH_MEDIA.md)。下表保留首个文本版本的基线覆盖。

## 当前范围

| 能力 | 实现范围 | 真实 QQ 验证 |
| --- | --- | --- |
| 客户端版本 | 官方 Linux QQ `3.2.34-53644` x64 | 已验证 |
| 二维码与扫码 | 原生 PNG、用户扫码、当前账号回调 | 已验证 |
| 账号会话 | 初始化和身份校验、异步 dispatcher、消息监听 | 初始化成功并收到实时消息 |
| 在线状态 | 初始化和启动成功、MSF `(1, 0)`、健康 dispatcher，加明确原生登录成功或真实消息证据 | 最终冷启动在零入站时已报告在线 |
| 账号信息与群列表 | 当前账号信息、全量快照与增量群更新、白名单过滤 | HTTP 与鉴权 WebSocket 只读查询均通过 |
| 普通群文本接收 | 实时、非导入；跳过自身消息；窗口内去重 | 用户指定群的测试文本已实际到达 |
| 普通群文本发送 | 单次发送，4096 UTF-8 字节，ACK / 送达未知语义 | ACK 成功，用户确认群内可见 |
| 消息 ID | 原生字符串、正 int32 别名、FIFO 容量 5000 | 精度与淘汰通过专项测试 |
| OneBot 网关 | HTTP、正向与反向 WebSocket、鉴权、心跳、事件 | 鉴权 WebSocket 已捕获真实群文本事件；只读动作与 echo 通过 |
| 内部桥接 | 独立令牌、同一网络命名空间的回环 IPC | 网关与原生运行时曾实际连接 |
| 完整原生 Docker | `Dockerfile.native` / `compose.native.yaml`，官方 QQ 与依赖、网关/runtime 联合管理 | 新卷启动、真实二维码、UID 1000、退出联停通过 |
| 仅网关 Docker | 原 `Dockerfile` / `compose.yaml`，不含 QQ runtime | 普通用户、回环发布和离线状态检查通过 |
| 官方包准备 | 官方配置、受限域名下载、可选解压、摘要回执 | 完整脚本下载及解压成功，187185496 字节 |

对外原生动作范围为 `get_login_qrcode`、`get_login_state`、`get_login_info`、`get_group_list`、`send_group_msg`。泛用 `send_msg` 封装尚未实现。

可选群白名单同时限制群列表、接收和发送。发送只接受字符串或全 `text` 段数组；不解析 CQ，含 CQ 外观的字符串需显式 `auto_escape: true` 才按字面处理。成功返回本进程的 `message_id` 别名，不对外输出原生 19 位 ID。

## 真实验证

日期：2026-10-30。

| 环境或步骤 | 结果 |
| --- | --- |
| 客户端 | 官方 Linux QQ `3.2.34-53644` x64 |
| 宿主 | Debian 13 x64、Node.js 24.22.2 |
| 原生兼容 | 本项目 C 兼容层与 `libgnutls` 预加载，模块加载成功 |
| 二维码 | 有效 PNG，约 120 秒有效期，2 秒原生轮询间隔 |
| 扫码 | 用户扫码，当前账号记录与账号选择回调已观察到 |
| 会话 | 初始化结果 `0`、身份匹配、MSF 状态 `(1, 0)` |
| 群列表 | 真实列表与白名单过滤通过，不保存名称或标识 |
| 接收 | `onRecvMsg` 收到 `isOnlineMsg: true`、`isImportMsg: false` 的群文本 |
| 发送 | 用户明确指定目标和固定测试内容；单次原生 ACK 为 `0`，用户确认群内可见 |

原生快速登录 Promise 可能保持等待，已完成的明确结果兼容整数 `0` 和规范字符串 `"0"`。项目不伪造结果；在线由会话、MSF、dispatcher 与绑定账号的真实登录成功或真实消息证据支持。记录不保存账号、群号、正文、原生消息 ID、票据或实验 profile。

最终 116 测试版源码在同一 profile 冷启动中已验证：显式缓存账号模式，`scan_confirmed: false`、`authenticated: true`，原生登录成功，账号会话初始化和启动均为 `0`，MSF `(1, 0)`、dispatcher 健康、无未知依赖。在零入站消息时已真实报告 `online: true`、`good: true`，并经 HTTP 查询到白名单群列表。没有再次发送测试消息。

带鉴权 OneBot WebSocket 已捕获有效真实群文本事件，验证目标白名单匹配、合法文本、正 int32 别名、其他发送者及在线状态。最终 116 重启后，还通过同一协议的只读 `get_status`、`get_group_list`、`get_version_info` 调用及 `echo` 关联。

最终进程后续收到真实原生消息批次，群缓存没有被空的 kind `4` no-change 更新清空。群列表维护有界公开 DTO 缓存，`0/1` 替换完整快照、`2` 增量更新、`3` 删除、`4` 与未知类型保持；完整快照前不宣称全量。分阶段证据见 [VALIDATION](VALIDATION.md)。

完整原生容器在新的 named volume 中已验证真实二维码、约 120 秒有效期、UID 1000 和 profile 权限 0700；该新卷没有进行扫码或消息发送，状态保持离线。它证明完整镜像依赖和启动流程可到达取码阶段，不替代登录后完整收发验证。

## 自动化与构建验证

最终全量自动化回归：Windows 116/116 通过；`node:24-bookworm-slim` 隔离 Linux 容器 116/116 通过，使用 `--network none`、源码只读挂载及临时可写目录。测试覆盖网关、IPC、配置、二维码客户端、登录状态、原生会话、映射、账号读取、发送、驱动编排、群更新及静默群就绪，使用可控后端，不连接真实 QQ。

完整原生容器已完成构建及新卷取码验证。任一子进程退出后，supervisor 联停另一进程并以失败码退出；SIGTERM 正常联停并返回成功。API 仅发布宿主回环端口，内部桥接只使用容器回环。等待用户扫码也可通过健康检查，健康不等于 QQ 在线。

此前网关镜像检查：UID 1000，端口仅发布至宿主回环地址；未加载 QQ 运行时时，匿名 `/health` 和鉴权后的 `/get_status` 均返回 `online: false`、`good: false`。临时测试容器和令牌已清理。

依赖审计：2026-10-30 执行 `npm audit --omit=dev --audit-level=high` 返回 0 个已知漏洞，不替代项目安全审查。

## 边界与后续功能

- 别名和去重记忆只在当前进程，默认 FIFO 容量 5000；淘汰或重启后旧别名失效，窗口外重复消息可能再次出现。
- @ 暂保留可见文本；完整提及、引用、表情、图片、语音、视频和文件未支持。
- 私聊、群成员管理、历史、撤回、合并转发、HTTP POST 上报、多账号及自动恢复待开发。
- 只验证上述 QQ 构建和宿主；其他版本、ARM64、长期稳定性与大规模部署未验证。
- `compose.native.yaml` 提供完整原生镜像；普通 `compose.yaml` 仍仅是网关。完整容器新卷的登录后文本收发尚未复测；已有登录会话与文本收发证据来自同源原生实验宿主，覆盖界限见验证记录。

## 公开对标资料

- [OneBot API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)：兼容接口目标。
- [OneBot 通信](https://github.com/botuniverse/onebot-11/blob/master/communication/README.md)：调用与推送方式。
- [OneBot 消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)：上报字段。
- [字符串格式](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)与[数组格式](https://github.com/botuniverse/onebot-11/blob/master/message/array.md)：文本和 CQ 转义。
