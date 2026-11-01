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

本机当前 Docker 未运行，因此本次没有迁移现有账号卷，也没有验证真实 FUSE 挂载、加密卷上的 QQ 重启登录。自动化覆盖 mountinfo 检查与拒绝回退；实际宿主机部署需要额外验证挂载、重启、错误密钥和删除流程。既有同 profile 快速登录已有真实验证记录，但不等于此次加密部署验证。

gocryptfs 提供文件内容与文件名加密，挂载时应用仍可访问明文；宿主机管理员可访问运行中的解密视图。参考 [gocryptfs 官方手册](https://github.com/rfjakob/gocryptfs/blob/master/Documentation/MANPAGE.md)。
