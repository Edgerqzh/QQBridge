# 富媒体、提及与撤回（实验阶段）

此迭代基于官方 Linux QQ 3.2.34-53644 x64。默认保留已验证文本能力；在本机 `.env` 设置 `QQBRIDGE_EXPERIMENTAL_RICH_MEDIA=1` 后重启 runtime，或重新创建完整原生 Compose 服务，启用本页能力。

## 能力和界限

| 功能 | 当前实现 |
| --- | --- |
| 图片发送 | `image` 消息段，PNG/JPEG，读取尺寸、计算 MD5；PNG 校验完整块与 CRC |
| 文件发送 | `file` 消息段；扩展动作 `upload_group_file` 接受 `group_id,file,name`，返回本进程 `message_id` |
| 语音发送 | `record` 消息段，SILK/AMR 输入，要求 `duration` 秒数；不提供 MP3/WAV 转码 |
| 提及 | `at.qq` 为数字 QQ 号或 `all`；查询真实原生 UID，分别写入 UIN/UID 字段；权限由 QQ 执行 |
| 媒体接收 | 图片、文件、语音转换为相应段，ID 为不透明原生标识；不输出本地路径 |
| 媒体取回 | 扩展动作 `get_file`，参数 `file_id` 取事件中的 `data.file`；返回 `base64,size,name` |
| 撤回 | `delete_msg` 使用当前进程的消息别名；QQ 决定权限与时间限制，原生拒绝明确返回错误 |
| 引用接收 | 能在当前别名窗口内解析原消息时附 `reply` 段；窗口外保留正文与提及，不虚构引用 ID |

`get_file` 只读取当前账号实际收到、仍在白名单群内、位于独立 profile 的已缓存媒体。QQ 尚未缓存内容时返回不可用；主动下载、失效文件恢复、流式下载及语音转码尚未实现。文件段、`upload_group_file`、`get_file` 为扩展接口，不宣称属于完整 OneBot 11 标准。

媒体通过 `base64://` 输入，单文件最多 16 MiB；请求 JSON / WebSocket / IPC 上限为 24 MiB。已入库媒体可以用 `qqbridge://<sha256>` 再引用。远程 URL、`file://` 和任意本地路径均拒绝。托管媒体保存在私有 profile 的 `media/`，目前不自动清理；原生客户端自己的缓存由客户端维护。

## 参数示例

```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 10001,
    "message": [
      { "type": "at", "data": { "qq": "10002" } },
      { "type": "text", "data": { "text": "示例文本" } },
      { "type": "image", "data": { "file": "base64://<PNG 或 JPEG 的 base64>" } }
    ]
  }
}
```

文件段使用 `{"type":"file","data":{"file":"base64://...","name":"example.txt"}}`。
语音段使用 `{"type":"record","data":{"file":"base64://...","duration":2}}`。
撤回使用 `{"action":"delete_msg","params":{"message_id":1}}`，其中 ID 必须来自当前运行进程。

预处理和发送共用有界超时；等待 UID 或磁盘读取超时后不会继续发送。发送、撤回失败均不自动重试。ACK 成功仅表示受理，不作为普遍的最终送达保证。

## 验证进度

- Windows 与禁用外网的只读源码 Linux 容器自动化均为 128/128 通过，覆盖媒体输入、路径与群权限、原生 ID、提及字段、缓存、未知引用、超时和撤回。
- 已在用户测试群真实收到图片、文件和两秒语音，转换为相应消息段；真实提及字段和原生 UID 查询已观察验证。
- 获准的一轮发送中，文件和语音 ACK 为 0；两条对应撤回 ACK 也为 0。用户尚未分别确认文件可打开及语音可播放，不能据此宣称最终内容送达。
- 首轮图片与提及组合被原生接口拒绝（-1）；检查发现测试 PNG 校验错误，已补充完整块与 CRC 校验。经额外授权使用有效 PNG 单独发送，仍被 QQ 拒绝，图片发送尚未跑通。已调整托管图片的文件扩展名，尚未进行新的实际发送验证。
- 同一额外授权轮次的独立 @ 文字发送 ACK 为 0，对应撤回 ACK 也为 0；群内可见与提及效果仍等待用户确认。没有自动重发任何被拒绝的图片。
- 尚未验证全体提及权限、AMR 真实发送、长语音、大文件、长期稳定性及所有富媒体事件端到端推送。默认实验开关保持关闭。

字段与动作兼容目标参考 [OneBot 消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)与[公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。
