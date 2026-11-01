# 每个机器人的加密账号存储

首次扫码并勾选“记住这台电脑的登录”后，QQBridge 保存明确选中的账号，原生 QQ 保存可用于快速登录的资料。容器重建时保留整个 profile（包括 `machine-id`、原生数据库和账号缓存），启动会尝试快速登录。`QQBRIDGE_LOGIN_UIN` 覆盖保存的选择；`QQBRIDGE_FORCE_QR=1` 用于手动重新扫码。成功必须以原生登录和会话证据为准。登录许可过期或 QQ 要求确认时，仍需扫码。

加密部署使用 Linux 宿主机的 gocryptfs，为每个机器人创建独立加密文件系统；QQ 运行时只看到挂载后的资料。所有数据库、票据、机器标识、媒体与消息索引都通过同一加密层落盘。密钥在宿主机单独保存，不进入容器环境、接口响应或镜像。该模式与默认未加密的 named volume 模式分开提供。

## 新机器人部署

宿主机需要 Node/Docker Compose、gocryptfs、FUSE3、OpenSSL、util-linux、GNU coreutils 和 Bash。以下命令在 Linux 宿主机执行，机器人 ID 由后端分配，不能使用用户提供的路径。

```bash
sudo bash scripts/bot-storage.sh init bot-a
sudo bash scripts/bot-storage.sh mount bot-a
```

初始化只允许新 ID，不覆盖已有资料或密钥。目录结构：

- `/srv/qqbridge/encrypted/bot-a`：加密资料，持久化到磁盘。
- `/etc/qqbridge/keys/bot-a.key`：每个机器人独立随机密钥，root 0600。生产环境应由独立密钥服务或受控主机秘密存储管理，避免密钥与加密资料处于同一公开备份。
- `/run/qqbridge/profiles/bot-a`：解密挂载点，供 UID 1000 的容器使用。目录在重启后重新创建并挂载。

为机器人创建独立环境配置，运行 `npm run init` 生成不同的 API/内部访问令牌，并设置群/好友白名单。随后用独立 Compose project 启动：

```bash
export QQBRIDGE_BOT_PROFILE=/run/qqbridge/profiles/bot-a
export QQBRIDGE_API_PORT=5700
docker compose --env-file /secure/bot-a.env -p qqbridge-bot-a -f compose.encrypted.yaml up -d --build
```

另一个机器人使用不同 ID、环境文件、project 名、API 端口与挂载点。密钥不需要配置给 QQBridge。容器仍使用非 root 用户，不增加 FUSE 设备或管理权限。

`compose.encrypted.yaml` 开启 `QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE=1`，原生模块加载前解析真实路径和 Linux mountinfo，只有 `fuse.gocryptfs` 文件系统才允许继续。未挂载、目录不存在、普通磁盘目录及嵌套明文挂载均失败，不会回退到明文 profile。手动启动 runtime 也可设置这个变量使用同一检查。

## 后端生命周期

1. 创建：分配不可复用的机器人 ID → `init` → `mount` → 创建该机器人容器 → 首次扫码。
2. 重启或部署：停止容器，保留资料和密钥 → 宿主机确认挂载 → 启动同一机器人容器。不要重建 `machine-id`，不要设置 `QQBRIDGE_FORCE_QR=1`。同一 profile 同时只能运行一个 runtime。
3. 停止：停止并移除容器 → `unmount`。普通卸载遇到忙碌状态会失败，不能强制卸载正在运行的机器人。
4. 删除：先撤销机器人 API 访问并停止、移除容器 → `unmount` → `destroy` → 删除对应环境秘密、业务数据库记录和备份密钥。不要在单纯重启时走删除流程。

```bash
docker compose --env-file /secure/bot-a.env -p qqbridge-bot-a -f compose.encrypted.yaml down
sudo bash scripts/bot-storage.sh unmount bot-a
# 不可恢复：第三个参数必须重复机器人 ID。
sudo bash scripts/bot-storage.sh destroy bot-a bot-a
```

删除工具仅处理固定根目录下匹配 ID 的资料、密钥和空挂载点，拒绝符号链接、仍挂载的资料和嵌套挂载。生产后端负责串行化同一机器人操作、授权用户身份、阻止运行中删除，并清理外部备份。删除本机密钥不会删除异地备份中的密钥。

## 现有明文资料迁移

停止原容器后，先备份原完整资料和环境秘密；初始化并挂载新加密目录，再将原 `/app/data` 的内容完整复制到该挂载点，保留权限和设备标识。切换至加密 Compose 后，验证 `get_login_state`、账号身份和旧消息 ID，再处理旧明文卷及其备份。仅复制 `selected-account.json` 无法恢复登录。不要在线复制原生数据库；不要把旧明文卷误挂到新机器人的目录。

## Docker Desktop / 独立存储容器

`compose.storage.yaml` 将 FUSE 放在独立存储容器，QQBridge 容器继续使用非 root、`cap_drop: ALL`、`no-new-privileges`。只有存储容器可以访问密钥与加密资料卷，并拥有 FUSE 挂载、UID/GID 切换所需权限。它不是 `--privileged` 容器，但其 `SYS_ADMIN` 权限仍属于受信任的宿主机存储组件。不要将其接口开放给机器人用户。

先为每个机器人准备独立随机密钥文件并限制访问权限，设置 `QQBRIDGE_BOT_ID`、`QQBRIDGE_STORAGE_KEY_FILE` 和独立 API 端口。Linux Docker 宿主机执行：

```bash
sudo sh scripts/prepare-storage-host.sh bot-a
export QQBRIDGE_BOT_ID=bot-a
export QQBRIDGE_STORAGE_KEY_FILE=/secure/bot-a.key
export QQBRIDGE_API_PORT=5700
docker compose --env-file /secure/bot-a.env -p qqbridge-bot-a -f compose.storage.yaml up -d --build --wait storage
docker compose --env-file /secure/bot-a.env -p qqbridge-bot-a -f compose.storage.yaml up -d --build qqbridge
```

宿主机目录 `/mnt/qqbridge-encrypted/<机器人 ID>` 仅是解密挂载点，持久化密文保存在该 Compose project 的 `encrypted-data` named volume。密钥作为只读 secret 文件提供给存储容器；不要把密钥文件放进该卷、源码或镜像。

Windows Docker Desktop 使用 PowerShell 7 启动工具，它会启动 Docker、准备 Docker Desktop Linux 主机的共享挂载，再按顺序启动存储与应用：

```powershell
pwsh -File scripts/start-encrypted-desktop.ps1 -BotId bot-a -EnvFile C:/secure/bot-a.env -KeyFile C:/secure/bot-a.key -ApiPort 5700
```

该工具会停止同一 Compose project 的现有服务后重新启动，不能与该机器人的其他生命周期操作同时执行。它不会自动注册开机任务。宿主机或 Docker 完整重启后，应由后端再次调用此工具；仅设置容器 restart policy 无法保证宿主机共享挂载和服务启动顺序。应用挂载点需要在加密存储就绪后重新绑定，不应在运行中的应用下直接重建 FUSE 挂载。

已有资料迁入存储容器时，先只启动 `storage`，将停止状态的原 `/app/data` 完整复制到宿主机解密挂载点，校验内容、所有权及权限，再启动 `qqbridge`。不要把原明文卷挂为 `/cipher`。删除时先 `down`，再按项目名称核对并删除对应密文卷、secret 文件及业务资料；日常重启不要执行 `down -v`。

## 2026-11-01 实机验证

- Docker Desktop / Linux FUSE 挂载成功，非 root QQBridge 的加密文件系统检查通过。
- 停止原服务后迁移 2,358 个文件、229,222,691 字节，逐文件内容、符号链接、所有权及权限校验一致；原明文资料卷保留作回滚。
- 迁移前原账号已不允许快速登录，迁移后缓存许可一致。用户在加密卷上重新扫码并勾选记住登录后，完成以下两轮恢复，均为同一账号、`online: true`、`selected_via_cache: true`、`scan_confirmed: false`：仅重启 QQBridge；停止 QQBridge、重新挂载存储后再启动 QQBridge。
- 只读回归确认旧消息 ID、3 条合并转发子消息、媒体标识及 4 条既有发送别名保留。未发送聊天消息。
- 独立 Compose 测试卷通过非 root 读写及密文视图检查：文件名与测试正文没有以明文出现在原始密文卷。错误密钥被 gocryptfs 拒绝，未挂载资料目录被 QQBridge 拒绝。
- Linux 自动化 255 项通过；Windows 253 项通过、2 项因缺少媒体工具跳过。尚未验证 Windows 整机重启或注册开机任务；删除真实账号的资料未执行。

gocryptfs 提供文件内容与文件名加密，挂载时应用仍可访问明文；宿主机管理员可访问运行中的解密视图。参考 [gocryptfs 官方手册](https://github.com/rfjakob/gocryptfs/blob/master/Documentation/MANPAGE.md)。
