# Windows、Linux 与 Docker 的统一构建

Windows 原生 Node、Linux 和 WSL 使用相同的构建代码、入口及输出格式。开发服务与生产构建仍是不同用途：`npm run dev` 提供热更新，`npm start` 提供已构建页面和 API。

## 统一命令

安装 Node.js 24+（包含 npm），在当前版本的 `web/` 目录运行。下面这些命令在 PowerShell、cmd 和 Linux shell 中相同：

```sh
npm ci
npm run build
npm start
```

`npm run build:webpack` 是明确指定 webpack 的同义入口，与 `npm run build` 调用同一个 `scripts/build.mjs`。脚本用当前 Node 执行 Next.js，显式传入 `build --webpack`，设置 `DIVIWISH_STATIC_EXPORT=1`，输出到 `web/out/`。环境变量由 Node 设置，不需要 Windows 的 `set`、PowerShell 的 `$env:` 或 Linux 的变量前缀。

脚本根据自身位置确定项目目录，正确处理 Windows 路径、空格和路径分隔符；构建失败会保留非零退出码，后续检查不会继续把失败视为成功。

| 入口 | 实际构建方式 |
| --- | --- |
| `npm run build` | 同一 Node 构建脚本 → `next build --webpack` → 静态导出 |
| `npm run build:webpack` | 与默认构建完全相同 |
| `npm run check` | lint、类型与业务检查后调用 `npm run build`，再验证当前版本运行方式 |
| 单机版 Docker | 镜像内 `npm ci` 后调用 `npm run build`，使用同一构建器 |

多人版包含登录页面和账号接口，单机版不包含这些页面，因此两版产物本来就不同；同一版本在 Windows 和 Linux 下使用相同的应用配置和构建流程。

## 哪些环境差异需要保留

`package-lock.json` 锁定依赖版本，`npm ci` 按锁文件安装。Next.js SWC、Tailwind Oxide、Lightning CSS 等依赖包含操作系统专用的二进制包，因此 **Windows 和 Linux 不能共用已安装的 `node_modules/`**。应分别在各自环境安装，不要把某个平台安装的目录复制给另一平台。

同时使用 Windows 原生 Node 和 WSL 时，推荐使用两个工作副本，例如 Windows 的 `C:\projects\DiviWish` 与 WSL 的 `~/projects/DiviWish`，各自运行 `npm ci`。源码与锁文件通过 Git 同步；`.next/`、`out/` 和依赖目录分别生成。WSL 本身属于 Linux 环境，即使源码位于 `/mnt/c/`，也应使用 Linux Node/npm 安装和构建。本机路径参考 [WSL 记录](local-wsl.md)。

团队或 CI 应尽量使用相同 Node/npm 版本、锁文件及非敏感构建配置。统一流程保证使用相同构建器、页面和运行方式，不承诺不同机器的文件哈希逐字节相同；构建 ID、绝对路径和工具链版本等仍可能影响文件内容。

## 为什么默认选择 webpack

本项目在当前 WSL 工作机上已验证 webpack 能稳定完成静态导出；此前默认 Turbopack 曾长时间停在编译阶段，具体原因尚未定位。默认构建显式固定为 webpack，避免文档、npm 检查和 Docker 因 Next.js 默认值而采用不同构建器。以后评估更换构建器时，应统一修改此脚本，并在两个平台及两个版本上重新验证。

参考：[Next.js 构建参数](https://nextjs.org/docs/app/api-reference/cli/next)、[Next.js 16 构建器说明](https://nextjs.org/docs/app/guides/upgrading/version-16)、[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。


## 2026-11-03 实际验证

使用同一份改动后的源码与各版本锁文件，分别执行正式的 `npm run check`，未绕过构建脚本或手写 webpack 命令：

| 操作系统 | 版本 | 结果 |
| --- | --- | --- |
| WSL Linux，Node 24.21.0 / npm 11.19.0 | 单机版 | 完整检查通过，92 项业务回归，webpack 静态构建及实际 HTTP/SQLite 检查通过 |
| 原生 Windows，Node 24.18.1 / npm 11.16.0 | 单机版 | 在全新、路径含空格的临时副本中 `npm ci` 后执行；相同完整检查通过 |
| WSL Linux，Node 24.21.0 / npm 11.19.0 | 多人版 | 完整检查通过，121 项业务回归，webpack、Worker dry-run、HTTP 与原生 workerd 检查通过 |
| 原生 Windows，Node 24.18.1 / npm 11.16.0 | 多人版 | 在另一独立临时副本中 `npm ci` 后执行；相同完整检查通过 |

两系统导出的同版本 HTML 页面路径完全一致：单机版 4 个（含 404），多人版 7 个（增加登录、注册和重置密码）。两个平台使用独立原生依赖与构建缓存，未覆盖现有 `node_modules`，未读写个人数据库。验证记录与日志保存在主工作区被忽略的 `.local/build-validation/`；测试副本在验证后清理。本次不涉及网站页面或 API 业务变化，无需更新生产部署。
