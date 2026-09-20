# tools/

本项目在打包、发布与安全审计过程中自用的脚本。它们**不参与成品运行**，只是把当时手工做的事固化下来，
方便以后重新校验或重建。全部使用 Node.js 内置模块，不需要 `npm install`——
用 `runtime/node/node.exe` 直接跑即可。

```powershell
$node = "..\runtime\node\node.exe"   # 项目自带的 Node.js 运行时
```

## 打包与构建产物

| 脚本 | 作用 |
| --- | --- |
| `make-zip.js` | 用 `zlib.deflateRawSync` 手工拼 ZIP 结构（本地 ZIP + 中央目录 + EOCD），把 `dist/win-unpacked` 打成发布用的免安装包。之所以自己写：打包后的运行时里没有外部压缩工具可用。 |
| `verify-zip.js` | 反向解析中央目录，**逐条目解压并比对 CRC32**，确认 ZIP 没有静默损坏。 |
| `asar-scan.js` | 解包 Electron 的 `app.asar`（解析 pickle 头部与文件偏移），用于确认打进成品的外壳代码里没有夹带凭据。 |

```powershell
& $node make-zip.js ..\dist\win-unpacked ..\dist\DeepSeek-Harness-win-unpacked-0.1.6.zip
& $node verify-zip.js ..\dist\DeepSeek-Harness-win-unpacked-0.1.6.zip
& $node asar-scan.js ..\dist\win-unpacked\resources\app.asar .\asar-out
```

## 隐私处理

| 脚本 | 作用 |
| --- | --- |
| `redact-band.js` | 对图片某个区域做模糊处理（feather 羽化边缘），用于打码截图里的敏感文字。 |
| `fill-band.js` | 用纯色矩形覆盖图片某个区域，配合取色可做到看不出痕迹。 |

发布前用它们处理了 `docs/screenshots/02-设置窗口.png` 里泄露的本地文件路径。

```powershell
& $node fill-band.js ..\docs\screenshots\02-设置窗口.png out.png 281 626 302 18 "#161a23"
```

## 发布到 GitHub

| 脚本 | 作用 |
| --- | --- |
| `github-create-repo.js` | 建仓库并写入中文简介、主页与 topics；仓库已存在时改为更新元数据。 |
| `github-release.js` | 建 Release 并上传资产，输出可下载 URL；已上传的同名资产会跳过。 |
| `fetch-file.js` | 支持重定向与进度输出的下载器（用于取 npmmirror 上的便携版 Git）。 |
| `git-credential-token.js` | git 凭据助手：从 `GITHUB_TOKEN` 读取令牌应答一次凭据请求，**不写入 remote URL 或 `.git/config`**。 |

> 注意：本机沙箱禁止 `sh.exe` 创建信号管道，因此 `!` 前缀的 git 凭据助手无法工作；
> 实际发布时改用 `git push https://x-access-token:<token>@...` 一次性传参。
> `git-credential-token.js` 保留给不受该限制的环境使用。

## 远程校验

| 脚本 | 作用 |
| --- | --- |
| `verify-artifacts.js` | 逐个目录比对远端关键产物是否存在（比 recursive tree API 省额度，后者在 5 万条目时会超时）。 |
| `verify-redaction.js` | 拉取远端 `dist/builder-debug.yml` 原文，断言脱敏占位符存在、本地路径与用户名 **0 命中**。 |
| `verify-metadata.js` | 校验仓库简介、topics、许可证识别与 Release 资产清单。 |
| `verify-tree.js` | 逐目录遍历远端完整文件树并与本地比对（调用量大，注意 API 速率限制）。 |
| `verify-remote.js` | 早期的合并版校验脚本，保留作参考。 |

```powershell
$env:GITHUB_TOKEN = '<token>'
& $node verify-artifacts.js
& $node verify-redaction.js
```

## 关于令牌

所有脚本只从环境变量 `GITHUB_TOKEN` 读取令牌，不落盘、不打印。
发布用的令牌请在用完后立即到 GitHub 设置页吊销。
