# Windows 原生运行与验收

当前 Windows 适配处于开发验收阶段，目标平台为 Windows 10 / 11 x64，不依赖 Docker 或 WSL。它与 Linux 版使用同一网关、OneBot 接口、登录接口和业务逻辑，另行提供 Windows 原生模块加载及进程托管。

下载：[v0.11.0 Release](https://github.com/Edgerqzh/QQBridge/releases/tag/v0.11.0)。Windows 文件名为 `qqbridge-windows-x64-0.11.0.zip`，摘要见同页 `SHA256SUMS.txt`。项目 MIT 许可证、Node 和 npm 依赖的许可及图像库通知均随包保留；也提供独立许可证包。发布版本不代表下列待验收项目已经通过。

## 固定依赖

- 官方 Windows QQ `9.9.36-53644` x64。使用腾讯官方下载包，已验证腾讯数字签名；安装包 SHA-256 固定于 [构建清单](../src/native/windows/build.json)。该摘要由已验证的下载包计算，不声称腾讯另行公布了此摘要。
- 官方 Node `24.21.0` x64，二进制已与 Node 官方 SHASUMS256 核对，签名有效。Windows 包随附运行时及其许可证。
- QQ 客户端不进入 QQBridge 压缩包；使用已安装的匹配版本时只读加载，不修改该客户端的文件和设置。也可把已验证安装包解压到独立缓存目录，不执行安装程序。
- 自编译宿主与兼容库目前未签名；代码签名及杀毒软件验收状态独立记录，不修改系统安全设置。

兼容库独立实现固定原生模块所需的宿主导入，原始 QQ 二进制不做补丁。原生模块的版本和 SHA-256 不匹配时拒绝加载。一个原生进程只支持一个 Node 环境，不能把 QQ 原生模块加载到额外 Worker 环境。

## 准备 QQ

优先检查用户已有的匹配版本，验证只读，不加载账号资料：

```powershell
.\runtime\node.exe scripts/prepare-windows-qq.mjs --existing-app 'C:\Program Files\Tencent\QQNT\versions\9.9.36-53644\resources\app'
```

没有匹配版本时，可使用可信的 7-Zip 可执行程序把固定安装包解压到新的缓存目录。准备工具支持自行从腾讯签名下载接口取包，也支持复用已下载、通过固定 SHA-256 校验的安装包：

```powershell
.\runtime\node.exe scripts/prepare-windows-qq.mjs --destination 'C:\Users\Example\AppData\Local\QQBridge\qq\9.9.36' --extractor 'C:\Tools\7-Zip\7z.exe'
```

该工具需要调用方提供解压器；普通桌面客户端可以自行提供解压组件。QQBridge 包不包含解压器或 QQ 安装包。已有缓存目录不覆盖；不要把目的目录设为用户正在使用的 QQ 安装目录。

## 启动接口

桌面控制程序启动 `qqbridge.exe`，传入与云端同名的环境变量。单独调试也可以使用：

```powershell
.\qqbridge.exe --env-file 'C:\private\bot-a.env'
```

必要配置：

| 配置 | 含义 |
| --- | --- |
| `QQBRIDGE_TOKEN` / `QQBRIDGE_BRIDGE_TOKEN` | 两个不同的随机令牌，各至少 32 字符 |
| `QQBRIDGE_HOST` / `QQBRIDGE_BRIDGE_HOST` | 本机宿主均使用 `127.0.0.1` |
| `QQBRIDGE_PORT` / `QQBRIDGE_BRIDGE_PORT` | 默认 `5700` / `5711`，每个实例分别分配端口 |
| `QQBRIDGE_QQ_APP` | 指向匹配版本的 `resources\app` 目录 |
| `QQBRIDGE_QQ_PROFILE` | 独立的绝对路径，保存整个机器人的账号资料 |
| `QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE` | Windows 当前使用 `0`；Linux 加密挂载检查不适用于 Windows |
| `QQBRIDGE_EXPERIMENTAL_RICH_MEDIA` | 使用图片等媒体时设置为 `1` |
| `QQBRIDGE_ALLOWED_GROUPS` / `QQBRIDGE_ALLOWED_USERS` | 按需配置测试或运行白名单 |
| `QQBRIDGE_UI_PORT` | 可选；设置后同时启动本机登录页，例如 `5702` |
| `QQBRIDGE_UI_API` | 自定义 API 端口时设置对应本机地址，例如 `http://127.0.0.1:5700` |

开发环境可额外指定 `QQBRIDGE_ROOT`、`QQBRIDGE_NODE_BINARY` 和 `QQBRIDGE_WINDOWS_COMPAT`；完整 Windows 包默认使用包内源文件、Node 和兼容库。宿主自动选择 Windows 驱动，无需把 Linux 启动脚本带入本地运行流程。

账号资料目录限制为当前用户和 SYSTEM 访问，并持有独占运行锁。SDK 工作目录、缓存、临时目录和子进程日志均指向该私有目录。此文件权限限制不等于整个资料目录的磁盘加密。

宿主使用 Windows Job Object，在创建子进程时将其原子加入托管组。网关、原生进程、可选登录页及其子进程不创建控制台窗口；宿主被强制结束时，由系统结束托管进程。原生进程的自动重启有次数和退避限制，不重放聊天发送。

首次扫码保留“记住登录”，之后沿用完整资料目录和设备标识。登录许可失效时仍需扫码。迁移同一账号到另一个节点前，应先停止旧节点的 QQ 会话；同号客户端发生互踢时，不应通过无限重试维持登录。

## 实测记录与剩余验收

| 项目 | 当前记录 |
| --- | --- |
| 非管理员准备 | 在中等完整性令牌下下载、解压及运行，不执行 QQ 安装程序 |
| 网关与鉴权 | 已通过；鉴权状态查询成功，未携带令牌被拒绝 |
| 扫码登录 | 已通过真实手机确认，完整原生会话及 MSF 在线 |
| 私聊 | 已通过文字、图片接收与文字发送；用户确认消息可见 |
| 群聊 | 已通过普通文字和 @ 接收、文字与图片发送；用户确认可见 |
| 重启恢复 | 已多次免扫码恢复同一测试账号，`scan_confirmed: false` |
| 打包版异常恢复 | 仅结束已登录的原生进程后，宿主自动更换进程；同一账号免扫码恢复，网关与登录页进程保持不变 |
| 消息持久化 | 重启后原私聊消息 ID 仍可查询 |
| 撤回 | 获准的 3 条发送均返回撤回成功 |
| 无界面运行 | 已检查宿主及 3 个托管进程没有主窗口；未启动 QQ 主界面 |
| 独立资料目录 | 新的中文及空格路径可以取码，账号未选中，未复用原目录登录 |
| 使用已有 QQ | 匹配版本只读加载、新资料目录取码已通过 |
| 清理进程 | 已登录的完整 Windows 包只结束宿主，三个子进程全部退出，三个端口全部释放；再次启动免扫码恢复并可查询原消息 |
| 宿主边界测试 | 源码构建和打包版均通过：原生进程异常恢复、同资料目录重复启动拒绝且不影响原实例、宿主退出清理、端口释放、网关故障时整体退出 |
| 与用户主号共存 | 用户明确确认 Windows 主号始终正常在线，没有被挤下线 |
| Windows 整机重启恢复 | 按使用者安排暂缓，未执行；已有进程重启验证不能替代整机重启验收 |
| 连续在线 24 小时及断网 5 分钟 | 待完整长期测试，不使用模拟结果替代 |
| 干净 Windows 10 / 11 | 当前开发机不是干净系统，尚需独立干净环境复测 |
| 两个机器人账号同时运行、睡眠唤醒 | 尚未完整验收 |
| Defender | 当前执行环境无法取得 Defender 状态，尚未完成扫描验收；未修改安全设置 |

自动化回归共 284 项：Windows 通过 282 项，因缺少 FFmpeg / ffprobe 跳过 2 项；此前 Linux 隔离容器 259 项全部通过（不含新增动作）。图片工作进程、语音编解码、故障后的资源释放及原有网关功能均在这轮测试范围内。测试容器不连接真实账号。

真实打包版的异常恢复、退出和重启验证不发送聊天消息。以上结果覆盖当前开发机与固定依赖组合，不代表已完成整机重启、24 小时在线或干净系统验收。

Windows 上存在一个已确认的原生清理差异：成功登录后，SDK 已消费二维码轮询对象，再调用 `abortPolling` 会访问空对象。Windows 驱动停止已登录会话时不再调用此方法；未登录时仍可取消轮询。该差异有回归测试，真实被踢下线仍按认证失效处理，不伪造在线状态。

图片解码与缩略图在独立 Node 子进程中执行，避免 QQ 和图像库同名 DLL 混用；限制并行数量、输入输出大小和执行时间。媒体子进程不接收 QQBridge 访问令牌。Windows 包目前不附带 FFmpeg / ffprobe，依赖它们的高级媒体处理需要另外配置，不能由基础图片测试推断全部媒体功能已验收。

## 开发构建

兼容库使用 Visual Studio x64 C / MASM 构建，图形宿主使用 .NET Framework 编译器；这些是构建机依赖，不要求终端用户安装编译器。

```powershell
pwsh -File scripts/build-windows-compat.ps1
pwsh -File scripts/build-windows-host.ps1
pwsh -File scripts/package-windows.ps1 -Destination 'C:\builds\qqbridge-windows-preview'
```

不连接 QQ 的宿主集成测试可以从源码构建，也可以直接检查实际发出的包：

```powershell
pwsh -File scripts/test-windows-host.ps1
pwsh -File scripts/test-windows-host.ps1 -HostExecutable 'C:\builds\qqbridge-windows-preview\qqbridge.exe' -NodeExecutable 'C:\builds\qqbridge-windows-preview\runtime\node.exe'
```

测试使用临时的 Node 传输进程，不加载 QQ SDK，不提供登录或伪造在线能力；分别验证 Windows Job Object、进程恢复和启动冲突。它只结束本次测试启动并校验过的进程。真实账号的免扫码恢复需要独立验证，不能由这些进程测试替代。

打包工具只复制源文件、生产依赖、Node、项目自编译产物及许可证，生成逐文件摘要；不复制 `.env`、QQ 客户端、二维码、原生账号资料、消息记录或测试素材。当前构建清单标记为开发验收中，不代表所有上述项目已通过。
