# 群申请、公告与扩展消息（0.8 开发预览）

本阶段面向官方 Linux QQ `3.2.34-53644` x64。沿用现有 HTTP / WebSocket 鉴权、账号隔离、群 / 好友允许范围与消息 ID 索引。视频、表情、卡片、转发及戳一戳需显式设置 `QQBRIDGE_EXPERIMENTAL_RICH_MEDIA=1`。

## 群申请审批

| 接口 | 参数 | 行为 |
| --- | --- | --- |
| `get_group_requests` | 无 | 获取原生通知首页中待处理的普通入群申请，最多读取 100 条通知后过滤 |
| `set_group_add_request` | `flag`、`sub_type="add"`、`approve=true`、`reason=""` | 明确同意 / 拒绝指定入群申请；拒绝理由最多 120 字 |

原生申请映射为 OneBot `post_type: "request"`、`request_type: "group"`、`sub_type: "add"` 事件，含 `group_id`、`user_id`、`comment`、`time` 和不透明 `flag`。仅处理已加入且在 `QQBRIDGE_ALLOWED_GROUPS` 范围内的群。审批前刷新完整成员列表，核对账号 UID / UIN 及管理员 / 群主角色，再核验申请仍在当前原生通知中。

普通群角色变更、已处理通知、疑似风险申请及邀请登录账号入群不会转换为普通申请。`sub_type: "invite"` 暂不支持。没有自动同意规则。列表以原生完整回调和成功 ACK 为依据；SDK 不重复通知未改变的内容时复用同账号的已观察快照，不据单独 ACK 编造空列表。

审批前在专用 profile 的 `group-decisions/` 写入按账号隔离的摘要记录，最多 2048 条。结果未知或被拒绝的尝试也保留，重复 flag 返回 `1409`，需先在 QQ 中检查结果。该记录不能随意删除，也不应提交到仓库。多个读取共享一个在途请求；回调映射不反向触发轮询，避免循环拉取。

## 群公告与群主操作

| 接口 | 参数 | 权限与效果 |
| --- | --- | --- |
| `get_group_notice` | `group_id` | 读取已观察的原生公告列表并请求 QQ 更新 |
| `send_group_notice` | `group_id`、`content`、`pinned=false`、`confirm_required=false` | 管理员 / 群主发布文字公告，最多 4096 字 |
| `delete_group_notice` | `group_id`、`notice_id` | 管理员 / 群主删除指定公告 |
| `transfer_group` | `group_id`、`user_id`、`token=""` | 仅群主，将所有权转让给另一名当前成员 |
| `dismiss_group` | `group_id` | 仅群主，解散指定群 |
| `set_group_leave` | `group_id`、`is_dismiss=true` | 与解散群相同；false 仍表示普通退群 |

公告列表每条包含 `notice_id`、`group_id`、`publish_time`、`pinned`、`content`，不公开原生发布者 UID 或内部设置。发布 / 删除所需的域会话凭据仅从当前原生账号内部取得，域名固定为 `qun.qq.com`，不作为接口参数、响应或日志内容返回。

转让和解散只接受完整成员快照中的群主身份。不能转让给自己、不在群中的账号或已是群主的成员；管理员无权执行。转让可能被 QQ 要求额外安全验证，`token` 仅传递已有的合法验证结果，本项目不生成、猜测或绕过验证码 / 安全验证。群主普通退群仍需先转让。

这些接口收到成功 ACK 后不会自动恢复或再次执行。转让 / 解散会改变所有权或移除整个群；调用方需要把明确选定的群号及目标传入，不应由后台规则反复调用。结果未知时先在 QQ 中核实。

## 视频、表情与卡片

沿用 `send_group_msg`、`send_private_msg` 和 `send_msg` 的消息段数组。

```json
[
  {"type":"face","data":{"id":"311"}},
  {"type":"video","data":{"file":"base64://此处替换为MP4内容"}},
  {"type":"json","data":{"data":"{\"app\":\"com.tencent.example\",\"meta\":{}}"}}
]
```

示例中的卡片应用名只是结构演示，QQ 是否接受由实际卡片内容与服务端策略决定。

- 视频支持最多 16 MiB、10 分钟的 H.264 MP4。FFmpeg / ffprobe 校验格式、时长和尺寸并生成缩略图，最多两个准备任务并行；外部进程有超时和输出上限。原视频与缩略图按 SDK 返回的位置存入专用 profile。暂不转码 HEVC / MKV，也不接受任意本地路径或网络 URL。
- 接收原生视频映射为 `video` 段，`data.file` 可传给 `get_file`。QQ 如果将 MP4 作为普通文件发送，仍映射为 `file`，不会伪装成原生视频。
- `face` 支持 QQ 自带表情 ID。商城贴纸、骰子和自定义动画表情未在本阶段覆盖。
- `json` 接收 / 发送 JSON 卡片，最大 64 KiB。发送卡片必须是含 `app` 字符串的 JSON 对象；不会执行其中脚本或主动访问链接。XML 卡片暂不支持；合并转发使用专门接口。

媒体继续使用受管理的 `qqbridge://...` 或 `base64://...` 标识。大段 Base64 采用线性字符校验及解码后的规范编码比对，避免正则栈溢出。小于等于 10 MiB 的在线文件如只有 `file10MMd5`，可将它作为完整文件校验值；较大文件不能这样替代完整 MD5。

## 合并转发

| 接口 | 参数 | 行为 |
| --- | --- | --- |
| `get_forward_msg` | `id` | 读取收到的 `forward` 段中的不透明句柄 |
| `send_group_forward_msg` | `group_id`、`messages` | 向当前允许的群发送合并转发 |
| `send_private_forward_msg` | `user_id`、`messages` | 向当前允许的好友发送合并转发 |

`messages` 为 1～50 个 `node` 段，当前只接受已存在的桥接消息 ID：

```json
{
  "action":"send_group_forward_msg",
  "params":{
    "group_id":10001,
    "messages":[
      {"type":"node","data":{"id":12}},
      {"type":"node","data":{"id":13}}
    ]
  }
}
```

所有源 ID 必须属于同一允许的会话，目标也会独立核验。SDK 生成合并卡片后使用真正的原生发送 ID 保存别名，成功返回 `message_id`，可查询或撤回。暂不接受伪造发送者、昵称或任意自定义节点正文。

接收句柄绑定原会话与外层消息；`get_forward_msg` 重新核验原消息，再让 SDK 读取子消息，不接受调用方随意提供原生资源 ID。最多读取 100 个子消息，返回 `message` / `messages` 两个同内容的节点数组及 `unsupported_count`。支持再读取一层已在外层结果中出现的嵌套转发。

转发内部媒体会保留 `forward-media:...` 描述标识，但本阶段不支持通过 `get_file` 主动下载这些内部媒体；不能把它们冒充成外层会话的普通媒体 ID。普通消息视频 / 图片 / 文件的下载接口不受影响。

## 戳一戳

- `friend_poke {user_id}`：向当前允许的好友戳一次。
- `group_poke {group_id,user_id}`：向已加入、允许群中的当前成员戳一次。
- 收到已验证的原生戳一戳结构时上报 OneBot `notice_type: "notify"`、`sub_type: "poke"`，含 `user_id`、`target_id`，群事件另含 `group_id`。依据业务类型和双方身份字段解析，不依赖展示文字。通知使用现有持久化去重窗口。

本阶段提供独立动作，不把戳一戳混入普通消息数组，也不提供群发 / 自动连戳。

## 验证范围

用户已确认真实私聊视频可播放，表情、小程序卡片和合并转发正常；四条测试消息均成功撤回。修正后的私聊戳一戳收到用户确认。公告已完成发布、原生查询确认、删除及再次查询确认。真实接收素材还验证了合并转发的三个子消息和戳一戳的原生结构。

自动化回归：Linux 253 / 253 通过；Windows 251 通过，2 项因宿主缺少 FFmpeg / ffprobe 跳过。覆盖权限隔离、群主操作参数、申请摘要去重、延迟回调不循环轮询、公告凭据与公开字段、真实 H.264 缩略图、大段 Base64、私聊系统灰字与分页、转发句柄权限及戳一戳事件通道。既有音频 / 下载稳定性回归同时通过。

用户没有可用于入群的备用账号，本轮跳过真实申请审批。转让、解散群未在真实群执行；它们的原生参数、角色限制、目标检查和不自动重试行为由自动化验证。群聊视频、群戳一戳、复杂嵌套转发及多天连续运行尚未做真实效果验证。本版本仍为开发预览。
