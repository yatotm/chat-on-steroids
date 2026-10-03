# Mac 工作台连接 Linux 开发机

此 fork 保留 CoS 桌面界面、Chrome 扩展、聊天记录、Goal/Loop 和 worker 管理，通过现有 Plugins 把远程项目工具调用交给 CodexPro。

```text
ChatGPT ── MCP 隧道 ── Mac 的 CoS Core / Plugins
                                  │ SSH 转发或 HTTPS
Linux：                        CodexPro ── 项目文件和命令
```

ChatGPT 的 MCP 隧道连接 Mac 的 CoS；Mac 再连接开发机。工具结果经过原有记录和输入投递流程。

## 开发机

使用已有 CodexPro 0.30.0 或兼容版本。源码方式先在 CodexPro 仓库运行 `npm ci`、`npm run build`，下面的 `codexpro` 可替换为 `node /path/to/codexpro/scripts/codexpro.mjs`。

```bash
umask 077
mkdir -p ~/.config/codexpro
test -e ~/.config/codexpro/cos-token || openssl rand -hex 32 > ~/.config/codexpro/cos-token
codexpro start --root /path/to/project \
  --headless --tunnel none --port 8787 \
  --tool-mode full --write workspace --bash full \
  --token-file ~/.config/codexpro/cos-token
```

文件工具只访问 CodexPro 允许的目录，`--bash full` 以开发机系统用户权限执行命令。多个项目需要在 CodexPro 中分别允许，Mac 输入路径不会授予开发机新权限。

## Mac

保持以下 SSH 连接：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8787:127.0.0.1:8787 you@development-server
```

首次打开 CoS，在“连接设置”的第一步“选择工作位置”点击 **连接 Linux 开发机**，无需选择 Mac 本机文件夹。已经完成设置时，也可以点击聊天侧栏“项目”旁的地球按钮 **添加远程项目**。输入：

- 连接：新建 CodexPro 连接，或选择已有连接。
- 开发机 MCP 地址：`http://127.0.0.1:8787/mcp`，也可使用 HTTPS 地址。
- 访问令牌：开发机令牌文件的内容。
- 项目目录：开发机绝对路径，例如 `/srv/project`。

连接并打开工作区成功后才保存项目，第一步显示“已添加远程项目”。凭据保存在 Mac 系统凭据库中，不写入项目或安装包。

继续完成“连接设置”中的 Core 隧道、密钥、ChatGPT 连接和 Chrome 扩展步骤。远程工具还需要 **Chat On Steroids Plugins**：在第 5 步点击“打开插件页面”，再点击“设置插件”，为 Plugins 配置单独的 OpenAI tunnel ID，然后在 ChatGPT 中连接和刷新该插件。远程项目的第 5 步会等待 Plugins 也连通；添加项目本身不代表 ChatGPT 已连接开发机。

全部连接完成后，返回聊天，在左侧远程项目中开始对话。

如果已经安装 2.2.0，它的首次引导只有本机文件夹入口。可直接升级到 2.2.1，或先点左上角“返回聊天”，使用“项目”旁的地球按钮添加远程项目，再返回连接设置。

## 执行边界

- 每次调用携带准确工作区 ID，并发项目不依赖连接最后选择的目录。
- Core 的会话、worker 和计划工具继续工作；远程项目的本机文件与命令工具被拒绝。
- worker 继承项目，Compact & Resume 保留项目和远程进程归属。
- 远程进程只允许创建它的本地会话操作；归属持久保存在 CoS，实际进程仍由开发机管理。
- 变更插件服务地址后需要重新添加远程项目；变更令牌不改变身份。
- 断线不回退到本机执行，也不自动重发可能已执行的工具调用。
- 一个连接可承载多个项目；多个同名工具服务继续由 Plugins 明确拒绝冲突。

Files、Review 和手动终端仍为本机面板。远程任务通过聊天工具执行，结果显示在原有时间线。交互式远程终端可继续使用 SSH。CoS、Chrome、ChatGPT 登录和 SSH 转发需要保持在线。

Apple Silicon 下载 `Chat-On-Steroids-macOS-arm64.dmg`。macOS 15.7.7 满足包声明的 macOS 13 及以上要求。安装包沿用上游未公证分发方式，系统可能要求允许打开。更新和扩展下载指向本 fork。
