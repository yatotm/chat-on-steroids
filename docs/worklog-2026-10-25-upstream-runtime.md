# 2026-10-25：上游同步与运行时更新

在现有 main 上先同步已发布的 fork 提交 `dc7fff6e`，再合入上游 `fb8c98db`，保留原作者提交历史和已有远程开发定制。没有创建新分支，也没有创建发布标签。

## 适配

- CoS 执行服务与上游 SSH/SFTP 项目按明确绑定区分，保留旧项目、凭据、会话和进程归属；二者共享文件与命令实现。
- 将上游工作区租约、随机进程 ID、终端输出与补丁处理改动适配到共享执行层。远端权限收窄后拒绝继续输入，恢复原权限后仍可使用原句柄。
- 重连项目保留上游新增的隐藏秘密设置与 ChatGPT Project 身份。新增回归先复现设置丢失，再验证修复。
- 保留 Core-only 首启和可选 Plugins 语义，适配上游菜单、文案与复数规则；更新器及发布说明继续指向本 fork。
- 远程后台输出统一经过上游秘密过滤，项目显式关闭过滤时仍按原设置处理。新增回归先复现泄漏，再验证修复。
- 修复原生登录面板先于所属页面销毁时的清理异常，保留退出时撤销凭据交接的语义。
- 开发、执行服务及 CI 的 Node 安全基线为 22.23.4；桌面构建依赖锁定到包含 Node 24.22.1 的 Electron 46.0.0-alpha.1。

## 安全边界（已更正）

此前依据 Chromium 所用 Brotli revision 的日期及文件哈希，判断它未包含本次修复，这个结论不正确，现已撤回。

Chromium 152.0.7977.167、156.0.8078.48 和 158.0.8114.0 使用的 `cfa184a` 是修复提交 `0ed4268` 之后的版本。源码已包含 `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` 检查及错误传播；Electron 的 GN 补丁把 Node 的 Brotli 依赖替换为 Chromium 的 `//third_party/brotli:dec`、`:enc`。因此这些 Electron 版本的 Brotli 修复已覆盖，不能仅因 Node 版本、Brotli 版本串、`node_shared_brotli` 或 JS 常量是否导出而判断未修。

2026-10-25 01:23 UTC 复核官方发布记录及官方 Linux 二进制，并按发布的 SHA-256 校验。无网络的内置 API 回归结果如下：

| Electron | 内嵌 Node | Brotli 源码修复 | DNS NUL 参数 | TLS 非规范 IP 与 DNS SAN |
| --- | --- | --- | --- | --- |
| 44.9.3 | 24.22.0 | 已覆盖 | 仍接受 | 仍接受 |
| 45.0.0 | 24.22.0 | 已覆盖 | 仍接受 | 仍接受 |
| 46.0.0-alpha.1 | 24.22.1 | 已覆盖 | 正确拒绝 | 正确拒绝 |

DNS 检查使用独立 `Resolver.setLocalAddress()`，没有发起查询；TLS 检查使用 `checkServerIdentity()` 与合成证书对象，没有建立连接。稳定版对应内置 JS 也缺少这两处官方校验。因此仍有至少 DNS/TLS 的 Node 补丁缺口，不能将整个 Node 安全合集标记为完成；这不等于已经证明应用中存在可利用路径。

44.9.3 和 45.0.0 都没有消除上述 DNS/TLS 缺口。46.0.0-alpha.1 已通过安全 API 探针、完整项目验证、关键真实界面及远程执行链路，因此将桌面构建依赖精确锁定到这个预发布版本。它仍是 alpha，不能称为稳定版；本次没有发布 Release、创建版本标签或安装桌面程序。此次检查未在四台主机的安装登记、标准程序目录及运行进程中发现已有 CoS 桌面客户端；实际部署的是已修复的独立执行服务。

可核实依据：[Brotli 修复及后续版本关系](https://github.com/google/brotli/compare/0ed4268a4401abcb4472096340477cf4af7d1a2b...cfa184a997ac19454d5a3ae97f6d600aac2445a6)、[Chromium 解码源码](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.167/third_party/brotli/dec/decode.c)、[Electron 的 GN 依赖替换](https://github.com/electron/electron/blob/v44.9.3/patches/node/build_add_gn_build_files.patch)、[Node DNS 修复](https://github.com/nodejs/node/commit/843a1627dc)、[Node TLS 修复](https://github.com/nodejs/node/commit/935918e342)。

## 验证

- 完整 `npm run verify`：10,163 项通过，172 项因平台或显式外部环境条件跳过；随后登录面板生命周期修复的 24 项相关测试、类型检查与重新构建通过。
- Electron 46 候选重新构建及完整 `npm run verify` 通过：10,164 项通过、172 项按原条件跳过。完整测试使用 Node 22.23.4；真实 Electron 使用其内嵌 Node 24.22.1。
- 后续检查发现打包 smoke 的精确版本校验只接受稳定版，误拒本次 alpha。新增 12 项直接运行实际 smoke 脚本入口的回归，先复现 3 个预发布版本失败，再修正校验并全部通过；范围、标签及残缺版本仍拒绝。该回归使用空产物夹具确认合法版本继续进入产物检查，不能代替完整安装包或跨平台打包验收；前述 10,164 项也不包含实际打包 smoke。
- 候选的 9 项真实 Linux Electron 界面检查全部通过：浏览器首启、输入区、登录交接、插件恢复、远端项目设置、远端项目、设置布局、更新操作及工作区终端。没有把 Linux 结果计作 macOS 或 Windows 桌面验收。
- 在 Electron 46 的 Node 24.22.1 进程内连接实际执行服务，完成补丁、读取、交互终端、图片、退出码、会话记录及调用方归属拒绝；测试目录已回收。另有 41 项图片处理与原生 sharp 回归在该运行时全部通过。
- 图片回归仍会产生 Linux GLib 警告。用官方 Electron 44.9.3 运行相同 41 项回归，同样全部通过且出现相同的 2,515 条警告；这是 [sharp 记录的 Electron/Linux 全局 GLib 符号冲突](https://sharp.pixelplumbing.com/install/#electron-and-linux)。本轮没有隐藏该警告，也没有证明这个上游冲突已经修复。
- 新执行服务在 Node 22.23.4 下完成预部署及生产真实 Core 链路验收：文件补丁、读取、交互式终端、图片、退出码、调用方归属与会话记录通过。
- 生产服务保持协议 2、原服务身份、令牌和批准目录；更新后已重启。服务单独明确使用 Bash，避免系统服务环境的 sh 错误读取现有 Bash 登录脚本。
- 真实 Electron 界面共覆盖 61 个脚本：完整运行首次 56 项通过，5 项失败在修复夹具或指定现有 Chromium 后定向复测全部通过；宠物性能另行完整复测通过。
- 登录交接使用隔离站点，不联系真实 Google 或 ChatGPT。真实 PTY 通过键盘输入、工作目录和环境保持、隐藏面板继续执行、Ctrl+C、退出码和关闭回收；830px 窗口下上下终端均位于视口内。
- 夹具修正包括无浏览器服务器的可控入口、fork 发布说明链接，以及每次清空终端验收状态并显示真实窗口，避免隐藏窗口暂停动画造成错误的布局判断。
- 旧执行器目录及验收目录已删除；本次桌面依赖选择与预发布性质按上文记录，Brotli 误判已纠正。
