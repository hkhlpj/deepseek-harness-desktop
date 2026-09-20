# DeepSeek Harness 独立桌面版 v0.1.6（Windows x64）

点击即用、不依赖外部 Node.js、不弹命令行窗口的 DeepSeek Harness 桌面程序。
三种形态都**自带 Node.js 运行时与完整的 dsh 依赖树**，目标机器无需安装 Node.js、pnpm 或任何依赖，
也不需要管理员权限（安装版按当前用户安装）。

## 下载资产

| 资产 | 大小 | 说明 |
| --- | --- | --- |
| `DeepSeek-Harness-win-unpacked-0.1.6.zip` | 252 MB | **推荐**。免安装目录版，解压后双击 `DeepSeek Harness.exe` 运行，启动最快 |
| `DeepSeek-Harness-Portable-0.1.6-x64.exe` | 142 MB | 单文件便携版，一个 exe 即可分发；首次运行需解包到临时目录，启动较慢 |
| `DeepSeek-Harness-Setup-0.1.6.exe` | 142 MB | 安装包，安装到当前用户并创建桌面/开始菜单快捷方式 |

### 校验值（SHA-256）

安装前可自行核对：

```
6fb9d182f0a3653859355456ccd797789b7a46007cab182df0d957d857519e99  DeepSeek-Harness-win-unpacked-0.1.6.zip
16cbb3572b6cea0c68fba923e6e846ca68264a1dae9b401c8e455d904f0a03af  DeepSeek-Harness-Portable-0.1.6-x64.exe
37763ecf26bd450eddd1c57c8759efb45459d0908f5b7530918603269b6d2d82  DeepSeek-Harness-Setup-0.1.6.exe
```

PowerShell 校验：

```powershell
Get-FileHash .\DeepSeek-Harness-win-unpacked-0.1.6.zip -Algorithm SHA256
```

## 快速开始

1. 下载 `DeepSeek-Harness-win-unpacked-0.1.6.zip` 并解压到任意目录；
2. 双击 `DeepSeek Harness.exe`；
3. 程序会静默启动内置的本地服务（无控制台窗口），然后自动显示 DeepSeek Harness 界面。

首次运行若出现 Windows SmartScreen「未知发布者」提示，选择**更多信息 → 仍要运行**即可
（本构建未做商业代码签名）。

## 配置 API 凭据

**本程序不内置、不打包任何 API Key。** 凭据按以下优先级在运行时获取：

1. 环境变量 `DEEPSEEK_API_KEY`（优先级最高，不写入磁盘）：

   ```powershell
   $env:DEEPSEEK_API_KEY='<你的密钥>'
   .\'DeepSeek Harness.exe'
   ```

2. 数据目录下的 `~/.dsh/.credentials.yaml`（由 Harness 自身的引导流程写入）。

用户数据沿用 Harness 默认目录 `C:\Users\<你>\.dsh`，与命令行版共享会话、设置与凭据。

## 主要特性

- **完全自带运行时**：内置 `node.exe` 与 `@deepseek-ai/dsh` 生产依赖树，不读取系统 Node.js
- **隐藏子进程**：`windowsHide` + 管道 stdio，启动宿主时不会闪现命令行窗口
- **随机端口**：默认 `--port 0` 由系统分配空闲端口，不与其他实例冲突
- **提示词设置**：菜单 `文件 → 设置…`（`Ctrl+,`）提供内置预设（通用/编程/简洁/中文/翻译），
  保存后通过 `dsh web --patch` 注入 `personaPrefix` 并自动重启服务生效
- **背景图片**：支持不透明度、模糊与 5 种混合模式（正片叠底/柔光/叠加/滤色/正常）
- **菜单栏**：设置、在浏览器中打开、打开数据目录、重新加载、缩放、全屏、开发者工具、关于

## 构建来源

使用 Harness 官方发布在 npm 上的**已编译产物**（`@deepseek-ai/dsh` 及其完整生产依赖树）作为宿主，
用 Electron 复现官方 `apps/desktop` 的「独立窗口 + 隐藏宿主进程」形态；**未修改上游任何代码**。

构建与重建说明见仓库 README 的「从源码构建」一节。

## 安全与隐私

发布前对全部产物做过逐字节审计：

- 以真实 API 密钥与其浏览器会话 secret 的字面量扫描整棵目录树（含二进制、`app.asar`、各成品 exe），
  命中数 **0**；`app.asar` 内仅 6 个外壳文件，不含任何凭据。
- 仓库配置文件中的构建机本地路径已脱敏为占位符，文档截图中的本地文件路径已覆盖处理。

## 系统要求

- Windows x64（Windows 10 1809 及以上）
- 无需管理员权限
- 无需预装 Node.js / pnpm

---

本仓库的外壳代码以 MIT 许可发布；打包进去的 DeepSeek Harness 与第三方组件遵循其各自许可。
