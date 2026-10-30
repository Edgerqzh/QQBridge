# 原生驱动与内部桥接

原生 MVP 已在官方 Linux QQ `3.2.34-53644` x64、Debian 13 x64、Node.js 24.22.2 上完成真实二维码、扫码、会话初始化、群列表与文本收发验证。它是指定构建的客户端桥接实现；QQ 二进制和账号资料不随源码分发。

## 结构与启动

```text
AI 应用
  │ OneBot HTTP / 正向或反向 WebSocket
QQBridge 网关
  │ 独立令牌的回环 WebSocket IPC
QQBridge 原生 runtime + 指定 QQ 本地模块
  │ QQ 原生登录、账号会话和消息服务
QQ 服务
```

推荐使用 `compose.native.yaml`：构建时准备官方 QQ 和共享库，由 `scripts/run-container.mjs` 在同一容器内启动网关与原生 runtime，并在任一子进程退出时联停另一进程。资料保存在 named volume，API 仅发布宿主回环端口。完整容器的新卷启动和真实二维码已验证。

手动运行时，准备官方 QQ 和共享库后，在同一网络命名空间中分别启动 `npm start` 与 `sh scripts/run-native-runtime.sh`。原生脚本编译 C 兼容层、预加载 `libgnutls.so.30`、读取 `.env` 并选择 Linux 驱动。具体步骤见 [README](../README.md)。普通 `Dockerfile` / `compose.yaml` 保留为仅网关模式。

## 原生动作

| 动作 | 合同 |
| --- | --- |
| `get_login_qrcode` | PNG 的 `image_base64`，可附有效期和轮询间隔；取码客户端校验后存本地 |
| `get_login_state` | 扫码、账号选择、原生结果、会话和在线证据的诊断状态 |
| `get_login_info` | 当前账号 `user_id`、`nickname` |
| `get_group_list` | 原生回调产生的群列表 |
| `send_group_msg` | 普通群文本，最多 4096 UTF-8 字节，不解析 CQ；要求在线及真实成员关系，并遵守可选群白名单 |

`send_group_msg` 接受字符串或非空的全 `text` 消息段数组，数组内容拼接为纯文本。含 `[CQ:` 外观的字符串在 `auto_escape` 不为 `true` 时返回 `1404`；显式转义或文本段中的该内容均按字面处理。标准成功数据仅包含 `{ "message_id": <本进程正int32别名> }`，原生 ID 留在内部映射中。

原生发送 ACK 成功只说明请求被接受；本次真实测试另经用户确认群内可见。发送超时或回包异常可能意味着消息已发出，返回送达未知，不自动重试。泛用 `send_msg` 及非文本消息未实现。

`QQBRIDGE_ALLOWED_GROUPS` 可设置逗号分隔的正整数群白名单，同时过滤列表、接收和发送；空值仅保留真实群成员关系限制。默认扫码；仅显式配置 `QQBRIDGE_LOGIN_UIN` 且同一 profile 中的相应缓存账号可快速登录时才尝试该账号，不自动选择首个缓存账号，也不把缓存登录当作本轮扫码确认。

## 在线与认证证据

扫码确认、`onUserLoggedIn`、原生快速登录结果和消息会话是不同阶段。明确成功结果兼容整数 `0` 和规范字符串 `"0"`。部分原生快速登录 Promise 可能持续等待，不能手工填入 `result: 0`。

消息会话要求初始化和启动结果均为 `0`、返回身份与当前账号匹配，并正确注册 dispatcher 和服务监听。在线还要求 MSF `(1, 0)`、健康 dispatcher、无未知依赖、未停止，以及以下认证证据之一：绑定同一账号 / UID / 流程代次的明确原生登录成功，或真实实时非导入消息。认证 getter 默认为假，异常或递归不能产生成功。观察者错误会影响 `good`。

`createLoginFlow` 可以记录明确原生登录结果或符合上述条件的真实在线会话证据，保留实际结果字段，不伪造旧 Promise 的完成。会话诊断含 `native_login_authenticated`、`authentication_evidence`，登录流程记录 `authenticated_evidence`。断线、失败、停止及账号变化会清理或隔离旧状态和晚到结果。静默群无需先收到消息，最终冷启动已在零入站时实际就绪。

群列表按通知类型维护不超过 10000 条公开 DTO 的有界缓存：`0/1` 完整替换、`2` upsert、`3` remove、`4` 与未知类型不改变现有缓存；完整快照前不声明全量。最终原生进程收到新消息后已验证 no-change 不清空群列表。

最终源码冷启动已完成显式缓存账号登录、会话初始化、HTTP 和鉴权 WebSocket 的白名单群列表只读查询；早先整合运行已捕获真实 OneBot 群消息事件。没有再次发送。完整镜像新数据卷的取码验证与登录后实验宿主的收发确证分别记录，见 [VALIDATION](VALIDATION.md)。

## 消息转换

`createMessageMapper` 仅转换 `chatType: 2`、`isOnlineMsg: true`、`isImportMsg: false` 的合法群文本，默认跳过自身消息。`msgTime` 使用秒整数，原生 `msgId` 始终保持十进制字符串。未知或混合非文本元素返回不支持，@ 的可见内容暂按文字处理。

对外 `message_id` 是正 int32 别名。默认 FIFO 容量 5000，只有当前进程有效。`rememberNative` 分配别名，`fromNative` 实际产生事件后才标记去重；提前登记发送回执不会吞掉入站事件。`lookup` 只返回消息标识、peer 和 chatType 的副本，不保存正文或昵称。淘汰或重启会使旧别名和去重记忆失效。

## ESM 驱动合同

`QQBRIDGE_DRIVER` 指向导出 `async createDriver({ emitEvent, emitStatus })` 的 ESM 模块，返回：

| 成员 | 要求 |
| --- | --- |
| `actions` | 实际支持的动作名，不包含未实现动作 |
| `async start()` | 初始化并注册监听，不必等待用户扫码完成 |
| `async stop()` | 停止驱动自身工作和监听 |
| `status()` | 同步返回 `{ online, good, self_id, nickname }`，身份来自真实账号 |
| `async call(action, params)` | 返回真实操作结果，失败抛出异常 |

`emitEvent` 上报完整 OneBot 事件，`time` 为 Unix 秒，`self_id` 与当前账号一致。带正整数 `retcode` 的错误是可对外展示的领域错误，可附 `publicMessage`；普通异常对外统一隐藏内部细节。

## 内部协议 v1

默认 runtime 连接 `ws://127.0.0.1:5711/bridge`，请求头为 `Authorization: Bearer <QQBRIDGE_BRIDGE_TOKEN>`。内部令牌不同于 API 令牌。仅允许一个 runtime，禁止浏览器 Origin，消息限制 1 MiB，运行进程须在同一网络命名空间。

握手为 `{ "type": "hello", "protocol": 1, "actions": [], "status": {} }`，网关确认 `{ "type": "ready", "protocol": 1 }`。后续使用 `call` / `result` 关联唯一调用 ID，并通过 `status` / `event` 更新状态和推送事件。超时和断线拒绝未完成调用，不对发送进行自动重放。

账号资料默认位于 `data/qq-profile`，由 `QQBRIDGE_QQ_PROFILE` 调整。源码、镜像和公开测试记录均不包含该目录、二维码、票据或真实标识。
