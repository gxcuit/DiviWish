# LinuxDO 登录

息望保留邮箱密码登录，并支持 LinuxDO Connect 的 OAuth2 授权码登录。已有账号请先用邮箱密码登录，在“我的 → 绑定 LinuxDO”完成授权，之后两种方式共用原有股票、自选和设置。直接从登录页首次授权会创建独立空账号，不能自动合并已有账号。

## 应用申请

在 [LinuxDO Connect](https://connect.linux.do/dash/sso/new) 填写：

| 字段 | 内容 |
| --- | --- |
| 应用名 | `DiviWish · 息望` |
| 应用主页 | `https://diviwish.shaunko.tech` |
| 应用描述 | A股与港股股息观察工具，提供个人自选、股息率跟踪、分红记录与历史分位分析。使用 LinuxDO 账号登录并保存个人观察数据。 |
| 回调地址 | `https://diviwish.shaunko.tech/api/auth/linuxdo/callback` |
| 应用图标 | `https://diviwish.shaunko.tech/icon.svg` |
| 最低等级 | 0级 |
| 最低等级（青春版） | 保留平台默认选项 |

回调地址由 `APP_ORIGIN + /api/auth/linuxdo/callback` 生成，必须与平台登记完全一致。备用 workers.dev 域名的登录入口会先跳至主域名，整个授权流程使用主域名的 Cookie。

## 后端配置与发布

后端读取 `LINUXDO_CLIENT_ID` 和 `LINUXDO_CLIENT_SECRET`。两者完整配置时，登录和注册页面显示“使用 LinuxDO 登录”，已有邮箱账号显示绑定入口。缺少配置时隐藏入口，密码登录继续可用。公开 `/api/auth/config` 只增加布尔字段 `linuxdoEnabled`，不返回凭据。

本机测试使用 `.dev.vars`；需要单独申请回调为 `http://localhost:3000/api/auth/linuxdo/callback` 的开发应用。生产凭据不能用于 localhost 回调。

生产发布使用被忽略的 `.local/linuxdo-production.secrets.json`，只包含上述两个键，避免覆盖现有生产 AUTH_SECRET、邮件和 Turnstile secrets。不要直接上传整份 `.dev.vars`。按 [分支与发布流程](branches.md) 完成代码集成、检查后，在 `web/` 执行：

```sh
npm run check
npm run cf:dry-run:production
npm run db:migrate:production
npx wrangler deploy --env production --secrets-file .local/linuxdo-production.secrets.json
```

必须先应用 `0004_linuxdo.sql`，再部署使用新字段的 Worker。迁移仅增加字段、索引和授权状态表，不重建用户、不修改已有密码或个人业务数据。代码回退可保留该迁移。

## 账号与安全

- 使用 LinuxDO 不可变 `id` 识别身份。用户名更新不创建新账号；不根据提供方邮箱、昵称或用户名合并账号。
- LinuxDO 独立账号无需邮箱和密码，直接进入个人页面。“修改登录密码”只显示给具有验证邮箱的账号。
- 为兼容原 `users.email NOT NULL UNIQUE` 结构，独立账号在数据库使用不能通过邮箱校验的保留键 `linuxdo:<id>`；公开会话返回 `email: null`，不会展示或向该值发邮件。
- 绑定必须通过同源 POST 发起，并在回调中重新核对原账号与原会话。会话退出、重置或变更后不能继续绑定；同一个 LinuxDO 身份不能绑定多个息望账号。
- 每次授权使用随机 state 和 HttpOnly、SameSite=Lax 浏览器 Cookie，服务端只保存摘要。状态 10 分钟过期，通过原子删除防止重放，绑定状态还绑定原会话。
- 只接受 active=true 且 silenced=false 的用户资料。等级门槛由 LinuxDO 应用配置管理。
- 换令牌和查询资料只在服务端进行，固定官方 HTTPS 端点，禁止跟随跳转，设置超时与响应体大小上限。访问令牌、刷新令牌、api_key 均不持久化。
- 完成授权后签发已有的 30 天会话 Cookie，并撤销当前浏览器的旧会话；业务接口仍从会话取得 user_id 并过滤个人数据。

## 验证范围

`worker/tests/linuxdo.test.ts` 使用临时 SQLite 和模拟提供方，覆盖创建与再次登录、会话轮换、账号隔离、资料变更、state 绑定与过期、防重放、取消授权、服务失败、账号停用、绑定冲突和备用域名。`npm run test:runtime` 通过真实本地 HTTP 验证两个独立 Set-Cookie 响应头，使用模拟凭据，不访问真实 LinuxDO 账号。

桌面与 390px 手机宽度的模拟授权浏览器检查已通过，包含登录、退出、已有账号绑定和关闭配置后的入口隐藏；不替代真实提供方授权。

真实验收：从线上登录页授权；已有数据的用户优先通过“我的”绑定，再退出并使用 LinuxDO 登录，确认回到相同账号与自选数据。此步骤需要用户在 LinuxDO 授权页面完成确认。

接口依据：[LinuxDO Connect 官方社区文档](https://wiki.linux.do/Community/LinuxDoConnect)。

## Cloudflare 原生运行时兼容

Cloudflare Workers 的 fetch 只接受 `follow` 和 `manual`，传入浏览器/Node 支持的 `redirect: "error"` 会在发请求前抛出 TypeError。提供方请求使用 `manual`，拒绝所有非 2xx 响应，因此不会跟随重定向发送 Client Secret 或 Authorization。

2026-10-29 已在远程 workerd 复现旧模式的 TypeError，并确认 manual 模式能够连接官方令牌端点、以无效测试授权码得到预期的 `invalid_grant`。原生检查还需要执行实际回调处理器，不能仅以 Node 模拟授权和取消授权流程代替成功路径的运行时验证。

参考：[Cloudflare Request 的 redirect 选项](https://developers.cloudflare.com/workers/runtime-apis/request/)。

`npm run test:linuxdo:runtime` 使用应用实际回调处理器、原生 Request 和临时本地 D1，模拟提供方响应，检查完整的回调、会话及业务访问，并拒绝两个提供方端点的重定向；已加入 `npm run check`。测试日期取应用日期与已安装 workerd 支持日期的较早值，并明确输出两个日期，不修改生产配置；本轮本地测试选择的原生日期为 2026-10-19，生产 2026-10-27 的真实外部请求另经远程 workerd 验证。

2026-10-29：用户已完成线上真实授权并确认 LinuxDO 登录正常；本地与原生运行时检查的具体范围仍如上所述。
