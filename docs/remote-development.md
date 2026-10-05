# Mac 工作台与 Linux 执行服务

远程项目只使用 **Chat On Steroids Core**。ChatGPT 通过一条 OpenAI tunnel 连接 Mac 上的 CoS；Core 将项目的文件、补丁和命令交给 Linux 上的 CoS 执行服务。

```text
ChatGPT → 一条 tunnel → Mac CoS Core → SSH 私有连接 → Linux CoS 执行服务
                       会话、记录、队列、worker       项目文件、命令、进程与输出
```

CodexPro 是独立工具，不参与这条链路。远程项目不需要 Chat On Steroids Plugins 或额外的 Plugins tunnel。原有可选 Plugins、Desktop 功能仍保持独立。

## 本地与远程并存，以及第三方插件

执行位置属于会话的项目或插件自己的连接，不是整个应用的全局二选一开关。

| 功能 | 执行位置由谁决定 |
| --- | --- |
| Core 文件、补丁、命令和项目图片保存 | 确切会话关联的项目；本地项目在本机，远程项目在对应 CoS 执行服务。不同会话可以并发操作不同位置。 |
| 浏览器与桌面控制 | CoS 所在电脑及其所连接的浏览器；切换项目不会把桌面控制移到 Linux。 |
| npm、Python、命令、MCPB 第三方插件 | 当前安装及运行它的 CoS 电脑；工作目录和权限属于插件自己的配置。 |
| HTTP MCP 第三方插件 | 用户明确填写的 MCP 服务端，可能是云服务，也可能是自己部署的 Linux 服务。 |

第三方 MCP 的工具参数和权限由它自己定义，当前没有通用的“自动搬到开发机”或路径翻译功能。
若插件需要直接操作 Linux 文件或 Linux 上的应用，需确认它支持该环境，并在适当服务端部署后
明确连接。不能把插件来源中的 remote（HTTP 服务）等同于当前项目的远程开发机。

插件页只管理这些可选第三方集成。Core 读写成功不证明其中一个独立服务在线；反过来，未启用
Plugins 连接器也不影响本地或远程 Core 开发。缓存的工具数量不等于当前可用数量。

## Linux：构建和启动

使用 Node 22.22.2 或与锁定依赖兼容的版本，在本 fork 的源码目录执行：

```bash
npm ci
npm run build:executor
npm run rg

umask 077
mkdir -p ~/.config/chat-on-steroids-executor
test -e ~/.config/chat-on-steroids-executor/token || \
  openssl rand -hex 32 > ~/.config/chat-on-steroids-executor/token
chmod 600 ~/.config/chat-on-steroids-executor/token

npm run executor -- \
  --root /srv/project \
  --token-file ~/.config/chat-on-steroids-executor/token \
  --port 18787
```

`--root` 可以重复，明确批准多个目录。服务只监听 `127.0.0.1`，并要求访问令牌。它不启动 Electron、浏览器、ChatGPT 或 Codex。生产部署可将 `node out/executor/index.cjs ...` 交给服务管理器运行；工作目录保留该构建及锁定的生产依赖、`resources/rg`。

`--state-dir` 默认为 `~/.local/state/chat-on-steroids-executor`，保存稳定的服务身份和运行日志。保留身份文件，才能在更新后继续识别同一服务；每次进程启动仍产生新的执行代际。

文件工具按指定项目执行目录、越界和链接检查。命令使用服务运行账户的系统权限，批准目录只限定初始工作目录，不构成命令的操作系统沙箱。Mac 中的权限、只读模式和命令策略仍在每次执行前生效。

## Mac：选择开发机和主目录

自动 SSH 目前支持 macOS 和 Linux。先在本机 `~/.ssh/config` 配好主机别名，并能在终端用 `ssh <别名>` 完成主机密钥确认和密钥解锁。例如：

```sshconfig
Host my-dev
  HostName development.example.com
  User developer
  IdentityFile ~/.ssh/id_ed25519
```

在连接设置中点击 **连接 Linux 开发机**，或点击侧栏的 **添加远程项目**：

1. 下拉选择已经保存的开发机，或 SSH 配置中的主机。
2. 新连接首次填写 CoS 执行服务令牌，端口默认 `18787`；同机后续项目自动复用凭据。
3. 在 **允许访问的目录** 中逐条添加远端目录，例如 `/srv/projects`、`/srv/shared`。它们必须落在执行器的批准上限内。
4. 单独填写 **主项目目录**，例如 `/srv/projects/app`。要新建它时勾选 **目录不存在时创建**；需要先批准其现有父目录。
5. 点击 **连接并添加项目**。CoS 自动建立并验证自己的 SSH 映射，多个项目共用这一条连接。

侧栏按开发机展示 SSH 主机名、执行服务连接状态、最近验证时间、刷新、重连和设置。本地项目单独显示。状态证明服务握手成功，不保证目录随后不会被移动或删除。

执行服务令牌用于 Mac 到 Linux；连接设置中的 OpenAI API 密钥用于 Mac 的 Core tunnel，两者用途不同。只需一条 **专用于 CoS Core** 的公共 tunnel，不能复用独立 CodexPro 的 Tunnel ID，也不需要另建 Plugins tunnel。工具更新后在 ChatGPT 刷新 Core 声明。

启用受管 SSH 后，点击主窗口红色关闭按钮或使用 ⌘Q 都会退出 CoS，并清理它创建的映射。睡眠/断线会撤下旧的可用状态，唤醒后重新验证。CoS 不会停止用户手动创建的 SSH；迁移验证通过后，由用户关闭原手动转发。

内部使用系统 OpenSSH 的配置求值和独立复用控制套接字，避免继承用户已有映射；配置与控制选项见 [ssh 手册](https://man.openbsd.org/ssh) 和 [ssh_config 手册](https://man.openbsd.org/ssh_config)。

## 迁移已有远程项目

选择 **迁移已有连接**，再明确选择它所在的 SSH 主机。旧 CoS 连接会复用已保存令牌，并在服务 UUID 一致时迁移同服务的项目；项目和聊天 ID 保留。来自旧 CodexPro 的项目需要填写新的 CoS 执行服务令牌，只迁移所选项目，不改变 CodexPro。

连接记录迁移不会改变项目主目录。要在多个目录间工作，编辑该开发机的允许目录列表，再从所需的主项目发起任务。旧的 `/root` 父工作区也可以保留。

推荐在迁移后新建一个项目聊天，让新的远端目录说明生效。Mac 应用与 Linux 执行器须配套使用协议 2；升级执行器会结束旧服务内的进程并使旧句柄失效。SSH 重连本身不重跑命令。

## 执行与恢复

- Core 的 `read`、`view_image`、`find`、`apply_patch`、`save_image`、`exec_command` 和 `write_stdin` 使用相同实现，在确定执行位置后才解析路径。
- Mac 独占请求归属、会话、记录、输入队列、计划、worker 和 finish；执行服务不会创建另一套聊天状态。
- Linux 独占进程、退出结果、输出游标及进程归属。Mac 保存的只是输出传输回执。
- 远程 `session_id` 是包含服务身份、启动代际和进程实例的 `cos:…` 句柄，原样传给 `write_stdin`。它不授予其他会话权限。
- worker 继承项目；Compact & Resume 保留本地会话 ID，因此仍可操作自己的远程进程。
- Mac 重启后，只要 Linux 执行服务仍是原进程且结果未被其有界保留策略淘汰，原句柄仍有效。Linux 执行服务重启后旧句柄失效，不能当作新进程使用。
- 断线不会回退到 Mac，也不会自动重发文件修改、补丁或命令。结果不明时先检查已有工作。
- 已完成的后台输出保留在 Linux，按准确会话交付。丢失的传输回执只会导致输出重新提供，不会重跑命令。

Files、Review 和手动终端仍是本机面板。远程项目操作通过 Core 聊天工具完成；需要手动交互终端时使用 SSH。

## 本地开发和验证

日常在 Mac 使用 `npm run dev`，Chrome 加载本仓库 `extension/`，不必为每次改动生成 DMG。已有安装版与开发版不要同时占用同一份应用数据。

```bash
npm run typecheck
npm test -- test/executor.test.ts test/remote-projects.test.ts test/remote-hosts.test.ts test/ssh-tunnel.test.ts
npm run build
npm run verify:ui -- remote-project
npm run verify
```

已部署服务的跨机器验收需要一个明确批准的临时目录。令牌从文件读取，不写入测试代码或日志：

```bash
COS_EXECUTION_TEST_URL=http://127.0.0.1:18787/mcp \
COS_EXECUTION_TEST_TOKEN_FILE=~/.config/chat-on-steroids-executor/token \
COS_EXECUTION_TEST_DIRECTORY=/srv/cos-validation \
npx vitest run test/remote-executor-live.test.ts
```

执行器构建会检查依赖图，拒绝带入 Electron 及桌面的会话、队列、agents 等权威模块。测试使用隔离目录和进程；测试通过不等同于用户账号的 ChatGPT 全链路通过。实际验收应分别核对扩展配对、Core 连接、远程文件与命令、记录回流、并发项目、worker 和接续。
