# 好友私聊

版本 `0.6.0-dev.1`。在现有普通 QQ 登录和 OneBot 连接上增加好友私聊，原生运行仍限定官方 Linux QQ `3.2.34-53644` x64。

## 范围与配置

当前私聊支持已在完整原生好友列表中的会话，不支持直接向陌生人发消息或群临时会话。0.7 增加明确调用的加好友与申请审批，见 [好友申请与群管理](MANAGEMENT.md)；没有自动同意规则。发送目标从 QQ 号解析为该好友的原生 UID，不能将群号或任意 UID 当作私聊目标。

可设置独立的私聊白名单：

```dotenv
QQBRIDGE_ALLOWED_USERS=20000001,20000002
```

上例为虚构号码。留空表示允许当前好友；非空时同时过滤好友列表、消息事件、收发、查询、历史和媒体读取。群白名单 `QQBRIDGE_ALLOWED_GROUPS` 继续单独生效。配置变更后重启 runtime。

好友列表来自 `getBuddyList(true)` 的成功结果与完整 `onBuddyListChange` 回调。未知、重复、数量不完整或身份不匹配的快照拒绝使用；恢复连接时清除缓存并重新读取。好友资料只在内存中保存，不写入桥接索引。

## 接口

| 动作 | 参数 | 说明 |
| --- | --- | --- |
| `get_friend_list` | 无 | 返回 `user_id`、`nickname`、`remark` |
| `get_friend_info` | `user_id` | 好友资料扩展动作 |
| `get_stranger_info` | `user_id` | 仅能查询当前允许的好友，未实现任意陌生人资料查询 |
| `send_private_msg` | `user_id`、`message`、可选 `auto_escape` | 好友私聊发送 |
| `send_msg` | `message_type` 与唯一目标 ID | 统一转发到群聊或私聊；目标含糊时拒绝发送 |
| `get_msg` | `message_id` | 现在同时支持群聊和私聊 |
| `get_friend_msg_history` | `user_id`、`count`、可选 `message_id` | QQ 本地好友历史扩展，默认 20 条、最多 100 条 |
| `get_private_msg_history` | 同上 | 历史动作别名 |
| `upload_private_file` | `user_id`、`file`、`name` | 实验私聊文件发送扩展 |
| `delete_msg` | `message_id` | 扩展为支持私聊消息撤回，由 QQ 校验实际权限和时限 |

好友资料包含可得的年龄，无法确认的性别返回 `unknown`。不暴露邮箱、电话等额外资料。

```json
{
  "action":"send_private_msg",
  "params":{"user_id":20000001,"message":"你好，这是一条私聊消息。"}
}
```

发送只尝试一次；超时、原生受理后断线或 ID 持久化失败都不自动重发。重启后沿用同一账号、profile 和消息索引，最近窗口内的 ID 保持有效。

## 消息与媒体

实时好友消息推送 `message_type: "private"`、`sub_type: "friend"`、`user_id`，不含 `group_id`。自身发送的消息不会重新作为接收事件回流。文字默认可用；图片、文件、语音、引用发送继续要求 `QQBRIDGE_EXPERIMENTAL_RICH_MEDIA=1`。私聊不支持群 @。

```json
{
  "action":"send_msg",
  "params":{
    "message_type":"private",
    "user_id":20000001,
    "message":[
      {"type":"reply","data":{"id":"123"}},
      {"type":"text","data":{"text":"收到这条私聊消息了。"}}
    ]
  }
}
```

引用 ID 必须属于同一好友会话。群聊 / 私聊、不同好友、不同原生 UID 的消息不能交叉引用或作为历史游标。私聊发送者的序号可能相同，接收引用还会核对发送者和可得的时间。原生引用 ID 不可用时，在最近 100 条本地记录中补查；无法唯一确认时保留正文并省略引用，计入 `private_reads.unresolved_replies`。

收到的私聊媒体使用带会话范围的、不透明 `data.file` 标识。原样传给 `get_file` 或 `get_record`，不要自行构造。下载请求使用私聊 chat type 与好友 UID；原生 SDK 可能把文件写到其报告的缓存路径，因此完成检测会检查请求目标和 SDK 缓存路径，两者都必须位于专用 profile 内并通过大小 / MD5 校验。

发送媒体仍只接受 `base64://...` 或受管理的 `qqbridge://...`，不接受任意本地路径 / URL。单文件 16 MiB、受限下载与音频工作进程的规则保持不变。WAV、MP3、Ogg 等发送前转 SILK，收到语音可用 `get_record` 转 WAV / MP3 / Ogg。

私聊撤回推送 `notice_type: "friend_recall"`，关联原来的桥接 ID；通知沿用按账号持久化的去重窗口。没有完整原生撤回记录时，不将发送接口的成功 ACK 伪装成通知。

`get_login_state` 增加 `friends`、`private_reads` 诊断。私聊原生查询最多四个并发，同请求合并，默认八秒超时；好友读取合并为一个在途请求，超时未结束的原生请求保留名额。

## 验证边界

本轮真实测试包括好友列表、私聊历史、消息查询、图片下载、未缓存图片重新下载和语音转 WAV；用户确认一次引用文字、蓝色 PNG、文本文件及语音均可正常使用。重启后原 ID 和媒体标识继续可用，四条测试消息的撤回接口成功，并收到四个不重复的私聊撤回通知。

最终版本还通过了真实私聊引用接收：带鉴权 WebSocket 上报 `private/friend` 消息，无 `group_id`，引用 ID 精确匹配原消息，`get_msg` 查询成功。

完整自动化回归：Linux 206/206 通过，Windows 205 通过、1 项因宿主缺少 FFmpeg 跳过。新增覆盖完整好友快照和权限撤销、原生在途请求限制、群 / 私聊 ID 隔离、双向相同序号的引用判定、二十个并发查询合并、私聊媒体范围与 SDK 缓存落盘，以及完整 driver 重建后的查询和撤回。另修复了 Windows 动态端口偶然选中 fetch 保留端口引发的测试失败。

升级保留已有群消息 ID；新索引可含私聊记录，回退旧版本前请准备相应的资料备份。当前仍是单构建开发预览；陌生人私聊、临时会话、大文件、更多消息类型及连续多天运行不在本轮验证范围。0.7 的加好友入口见 [好友申请与群管理](MANAGEMENT.md)。
