# 来源与独立实现记录

记录日期：2026-10-30。

QQBridge 的网关、原生兼容层和适配模块由本项目独立编写。功能相似、接口兼容或代码重写本身不构成法律上的独立性或商业授权保证；这里只记录实际资料、实现与验证来源。

## 阅读资料

| 来源 | 用途 |
| --- | --- |
| [OneBot API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md) | 动作和数据兼容目标 |
| [OneBot 通信](https://github.com/botuniverse/onebot-11/blob/master/communication/README.md) | HTTP / WebSocket 兼容目标 |
| [OneBot 消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md) | 消息上报字段 |
| [OneBot 字符串](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)与[数组](https://github.com/botuniverse/onebot-11/blob/master/message/array.md) | 纯文本和 CQ 转义规则 |
| [腾讯 QQ 下载配置](https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json) | 官方客户端版本和下载地址 |

实现根据公开协议资料和官方客户端独立实验编写。

## 自主原生实验

实验使用官方 Linux QQ `3.2.34-53644` x64，宿主为 Debian 13 x64、Node.js 24.22.2。本项目原创 C 兼容层将观察到的模块注册符号连接至 Node 的注册入口，配合系统 `libgnutls` 预加载，完成模块加载和导出观察。

appid 与客户端版本来自官方 `package.json`，QUA 标识通过只读观察该构建 `major.node` 的字符串确认。部分初始化枚举只观察到可工作值，语义尚未完全确认，支持范围据此限定于该构建。

独立实验逐步完成登录连接、真实二维码、用户扫码、账号选择、消息会话初始化成功、MSF 状态 `(1, 0)`、3 条群列表及实时非导入群文本。用户明确批准单次发送后，原生 ACK 成功，用户确认群内可见。

最终 116 测试版源码在同一 profile 冷启动中，凭明确原生登录成功、账号会话初始化和健康 MSF / dispatcher，在零入站时已实际在线；HTTP 与带鉴权 WebSocket 的只读状态、群列表和版本调用成功，`echo` 保持。整合运行阶段还已捕获真实 OneBot 群消息事件。最后原生进程收到自然消息后，kind `4` no-change 没有清空群缓存。没有重复发送。

完整原生镜像在新数据卷中完成真实取码、资料目录权限和进程联停验证；该新卷未扫码或发送。Windows 与隔离 Linux 自动化全量均为 116/116，与真实 QQ 实验分开记录。阶段与边界见 [VALIDATION](VALIDATION.md)。

本记录只保留日期、环境和状态，不保存真实账号、群号、正文、原生消息 ID、票据或 profile。原生快速登录 Promise 可保持等待；项目根据真实会话和消息证据判断在线，没有人为填充旧 Promise 的成功结果。

源码中的会话、登录状态、消息映射、账号读取和发送模块独立实现，并使用虚构数据做测试。原生 19 位消息 ID 保持字符串；进程内别名元数据不保存正文或昵称。发送 helper 不自动重试，也不把 ACK 当作通用送达保证。

C 兼容层在专用宿主加载时设置当前进程 `PR_SET_DUMPABLE=0`，避免原生故障产生包含会话数据的大型转储。

## 客户端包与依赖

QQ 客户端具有自身许可，不属于本项目 MIT 授权范围，不进入源码或普通网关镜像。`Dockerfile.native` 在用户本地构建时通过准备脚本从官方源下载并解压客户端；源码不携带 QQ 二进制。准备脚本限制 HTTPS 官方下载域与重定向，完整下载和解压已成功，包大小 187185496 字节，记录 SHA-256 为 `436c65e1dd28422e128a21cbddb5fe4e2e6c079d7f27fec2541e014d38cc336e`。这是本地计算的复现摘要，没有与官方发布摘要比较。

运行时依赖 `ws` 的锁定版本为 `8.22.0`，许可为 MIT，已检查安装包中的 LICENSE。镜像通过 `npm ci` 安装并保留许可。后续依赖变化应重新核对。

网关和完整原生镜像的基础为官方 `node:24-bookworm-slim`，本次解析摘要为 `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`。原生镜像通过 Debian 包仓库安装所需编译器和共享库，运行时用户为 UID 1000。Dockerfile 使用标签，未来可能解析到更新镜像。Node、Debian 及其组件遵循各自许可。

原创代码采用 MIT。第三方依赖、QQ 客户端和 QQ 服务分别适用自身权利及条件；本项目开源不表示腾讯已批准该接入方式或商业运营。

## 富媒体独立实验

本轮使用官方客户端空服务对象进行离线 N-API 参数转换观察，未启动登录或发送；观察图片、文件、语音元素字段与 recallMsg(peer, string[]) 入口。再在持有人已登录的真实会话验证 getUidByUins(string[]) 返回 {errCode:0,uids:Map}。真实接收记录验证媒体元素类型、提及中 atUid 为数字 QQ 号、atNtUid 为原生 UID。发布代码独立构造适配逻辑，不分发客户端代码或真实实验记录。

图片准备新增 `sharp` 0.35.5（Apache-2.0），用于受限像素解码和198/720尺寸缩略图；其预构建原生依赖适用各自随包许可。安装脚本禁用，预构建组件通过 npm 可选依赖安装。使用说明依据 [sharp 官方文档](https://sharp.pixelplumbing.com/api-resize/)。原图与缩略图存储路径由真实原生 getRichMediaFilePathForMobileQQSend 接口产生，公开代码只允许写入当前专用 profile；PNG 发送已由用户确认可打开，随后撤回的原生 ACK 为 0。

## 0.3 下载与音频

新增 `silk-wasm` 3.7.1，包声明为 MIT，已阅读包内许可和接口定义，原始编解码依赖各自适用其许可。通用音频通过独立 FFmpeg 可执行文件处理；原生镜像通过 Debian 仓库安装，保留随包许可。用法依据 [silk-wasm 上游](https://github.com/idranme/silk-wasm)与 [FFmpeg 官方文档](https://ffmpeg.org/ffmpeg.html)。原生媒体下载的无返回派发、参数以及取消接口，通过官方指定构建的独立观察与真实账号测试确认；返回内容以大小和 MD5 校验。
