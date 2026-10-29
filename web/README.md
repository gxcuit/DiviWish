# DiviWish · 息望

当前版本支持邮箱密码和 LinuxDO 登录，使用服务端个人数据库。股票、自选、板块、设置均按账号隔离，不使用浏览器 localStorage 保存业务数据。代码统一维护在 [gxcuit/DiviWish](https://github.com/gxcuit/DiviWish) 的 `multi-user`（稳定）/ `develop`（集成）分支；单机版见同仓库 `main` 分支。分支约定见 [分支与发布流程](docs/branches.md)。

功能介绍与当前界面截图见 [项目首页](../README.md)。本页说明安装、配置与开发。

线上地址：[DiviWish · 息望](https://diviwish.shaunko.tech)，[workers.dev 备用地址](https://diviwish.jackgao-china.workers.dev) 保留。生产部署、独立 D1、密钥管理与回退说明见 [Cloudflare 部署](docs/cloudflare-deployment.md)。

当前工作机在 WSL 中构建与运行时，优先使用 [已验证的 WSL 构建与启动方式](docs/local-wsl.md)（Linux Node + webpack + 静态预览）；其中记录了完整命令、端口检查及平台依赖注意事项。

## 本地启动

需要 Node.js 24+。所有命令从 `web/` 运行：

```sh
npm ci
npm run dev
```

Windows 可双击 `setup.cmd` 安装，再双击 `run.cmd`。开发界面在 http://localhost:3000/discovery，后端在 8787。若已有服务占用端口，可在另一个终端运行 `WEB_PORT=3100 npm start`（Windows PowerShell：`$env:WEB_PORT=3100; npm start`）。`npm start` 预览已构建的静态页面，需要先 `npm run build`。

本地使用 Node.js 运行与 Worker 相同的 TypeScript 请求处理器，使用真实 SQLite 实现 D1 prepared statement / batch 接口。数据文件为 `.local/accounts/diviwish.sqlite3`。Cloudflare 上使用原生 D1 绑定；本地 HTTP 测试不等于原生 workerd 运行时验证。

启动器仅监听本机，不创建远程资源、不上传代码、不发布 Cloudflare。`backend/data/` 的旧 SQLite、备份、seed 和 `.wrangler/state/` 全部保留，不读取、不重建，也不会自动分配给注册用户。

## 登录、注册与密码

- `/login`：邮箱 + 密码登录，或使用 LinuxDO 授权登录。邮箱密码登录不需要每次收取验证码。
- 已有邮箱账号可在“我的 → 绑定 LinuxDO”后共用原有数据；直接首次使用 LinuxDO 登录会创建独立空账号。
- `/register`：填写邮箱、密码和确认密码，获取并验证 6 位邮箱验证码后创建账号。
- `/reset-password`：使用邮箱验证码设置新密码；“我的 → 修改登录密码”也进入此页面。
- 旧验证码账号保留原用户 ID 和全部数据。已登录但尚无密码的用户会看到首次设置密码界面，验证邮箱后继续使用原账号；没有登录的旧账号可使用登录页的“忘记密码”。

密码大于 6 个字符，允许空格和 Unicode，不强制字符组合。后端使用 scrypt（N=16384、r=8、p=5）和每个密码独立的随机盐保存摘要，原始密码不进入日志、浏览器持久存储或数据库。设置或重置密码会撤销旧会话并签发当前会话。

验证码 10 分钟有效，最多尝试 5 次；注册和重置密码的验证码绑定各自用途，不能混用。首次注册不能只凭验证码跳过密码。默认本地 `AUTH_EMAIL_MODE=console` 时，验证码只显示在后端终端；实际邮件模式仍使用现有 Resend 配置。

会话使用 HttpOnly Cookie，30 天有效；退出登录立即撤销服务端会话。新注册账号为空，仅包含“未分类”板块。

## LinuxDO 登录

登录页可使用 LinuxDO 授权登录；已有账号可在“我的 → 绑定 LinuxDO”后共用原有数据。申请表、后端密钥、回调地址与发布步骤见 [LinuxDO 接入](docs/linuxdo.md)。

## Resend 邮件配置

见 [Resend 配置与本地收信测试](docs/resend-setup.md)。两类密钥分开保存：

- `.local/resend-setup.env`：临时 Full access 密钥，仅配置脚本使用。
- `.dev.vars`：应用的 AUTH_SECRET、发送专用 Resend 密钥、发件人、已发布模板 ID。不会进入前端构建。

第一次本地启动会生成随机 AUTH_SECRET。所有私密文件均被 Git 忽略。更换配置后重启服务。

线上要求 `APP_ORIGIN=https://你的应用域名`、`AUTH_EMAIL_MODE=resend` 和完整 Turnstile 配置；公共地址不能使用终端验证码或跳过人机验证。发信密钥与 Turnstile secret 都只在后端使用。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Next.js + Node 本地账号 API |
| `npm run backend` | 只启动本地账号 API |
| `npm run db:migrate:local` | 只迁移新的本地账号库 |
| `npm run build` | 导出静态页面到 out/ |
| `npm start` | 本地预览静态页面 + 同一账号 API |
| `npm test` | 临时数据库账号安全、隔离及旧计算/行情回归 |
| `npm run test:linuxdo:runtime` | 原生 workerd + 临时 D1 验证 LinuxDO 回调、会话及重定向拒绝 |
| `npm run test:runtime` | 真实本地 HTTP、持久化重启、退出与用户隔离检查 |
| `npm run check` | lint、类型、测试、构建、dry-run 打包与 HTTP 检查 |
| `npm run cf:types` | 生成 Cloudflare 绑定类型 |
| `npm run cf:dry-run` | 仅打包 Worker 和静态资源，不上传 |
| `npm run cf:dry-run:production` | 使用生产配置打包，不上传 |
| `npm run db:migrate:production` | 显式迁移独立生产账号 D1 |
| `npm run cf:deploy` | 发布到现有生产 Worker，沿用线上 secrets |
| `npm run resend:setup` | 配置 Resend 域名、发送密钥、验证码模板；输出待审核 DNS 记录 |
| `npm run resend:status` | 读取 Resend 域名验证状态 |
| `npm run dev:legacy` | 保留的旧 Flask 开发流程，需 Python 环境 |

`check` 不发送真实邮件，测试只使用临时数据库。本地开发默认使用 Node/SQLite。生产密码哈希已通过 Cloudflare 远程 workerd 验证；线上检查与真实邮箱注册的验证范围见部署文档。

## 目录

- `src/features/auth/`：邮箱登录注册页面、会话入口和 Turnstile 组件。
- `src/features/dividends/`：通用业务界面；`api.ts` 通过同源 API 访问服务端。
- `worker/index.ts`：当前生产 Worker 入口；`auth.ts`、`linuxdo.ts`、`mail.ts`、`portfolio.ts` 实现账号、邮件和用户隔离。
- `worker/database.ts`、`legacy.ts`：保留的单人 D1 实现和历史回归，不作为生产入口。
- `migrations/0002_accounts.sql`：独立账号表；不删除、不覆盖旧单人数据表。
- `scripts/local-server.mjs`、`local-d1.mjs`：本地 HTTP 和 SQLite 适配。
- `backend/`：保留 Flask 旧实现及本机个人数据。

更多说明：[账号架构](docs/accounts.md)、[股息计算](docs/calculations.md)。网站不运行根目录 Excel 脚本。

添加或编辑股票时，可点击“获取当前价格与股息”查询腾讯行情和东方财富已披露完整年度每股股息（人民币），并填入可核实的除息信息。查询本身不保存数据，核对后点击保存；单项失败保留原值，也可继续手动维护。

行情刷新会同时查询并保存年度股息、滚动股息、所属财年、实施状态和分红明细；股票详情也可单独刷新。价格和股息分别处理失败，失败项保留原值并提示，股息缺失时不会以零替代。登录后会在后台自动补齐缺失或过期的五年历史分位，同日成功结果复用。成功后直接显示，失败时在详情页显示具体原因并允许重试。

历史分位使用腾讯不复权日线与东方财富分红披露记录，按历史日当时已披露的最新完整财年现金股息计算，公告后下一交易日生效。仅使用今日之前完成的交易日，至少需要 60 个有效样本；展示实际覆盖区间。历史计划不是逐日版本快照，送转配股可能影响名义每股口径。港股外币分红缺少可靠历史汇率或不支持的财年时明确显示原因，不用当前汇率替代。
