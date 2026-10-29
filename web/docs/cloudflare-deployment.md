# Cloudflare 生产部署

主地址：**https://diviwish.shaunko.tech**；备用地址：**https://diviwish.jackgao-china.workers.dev**。

2026-10-28 已将邮箱注册、密码登录、重置密码和账号数据隔离版本发布至现有 Worker `diviwish`。当前版本 ID：`52e2b5cd-1edc-406d-98fc-2726ee710195`，包含自定义域名 Turnstile 修复；首次账号版部署为 `83c32118-c504-4bb3-b944-e7022b07d27d`。

## 环境与资源

| 项目 | 生产配置 |
| --- | --- |
| Wrangler 环境 | `production`，Worker 名称明确为 `diviwish` |
| 账号 | `257059339b4cc4e209c48fc4a70dd5fa` |
| 主域名 / APP_ORIGIN | `https://diviwish.shaunko.tech` |
| APP_ALLOWED_ORIGINS | `https://diviwish.jackgao-china.workers.dev` |
| D1 | `diviwish-accounts-production` |
| D1 ID | `b7513e84-bf4a-49ab-963b-3dffc30c1307` |
| 数据库迁移 | `0001_initial.sql`、`0002_accounts.sql`、`0003_passwords.sql` 均已应用 |
| 邮件 | Resend 发送专用密钥 + 已发布的验证码模板；发信域名已验证 |
| 人机验证 | 真实 managed Turnstile，登记上述两个线上 hostname |
| 运行时 | compatibility date `2026-10-27`；保留日志与 5% trace 采样 |

默认 Wrangler 环境仍使用本地占位 D1。生产命令必须选择 `--env production`；此环境的 `remote: true` 允许开发工具访问远程绑定，因此不要用它运行日常本地开发。`npm run dev` 和 `npm start` 继续使用 `.local/accounts/`。

原单人 D1 `diviwish`（`fcdcdfe4-b286-4e16-b911-8b0e70fe353e`）、本地 SQLite、快照和备份全部保留。新账号初始为空，没有自动导入或分配旧个人数据。

自定义域名记录保存在 `env.production.routes`，后续 Wrangler 发布会沿用该绑定。增加新域名时，需要同时更新 Worker 绑定、Turnstile hostname 清单和服务端 `APP_ALLOWED_ORIGINS`。后端还要求 Siteverify 的 hostname 与当前请求域名一致；其他允许域名上的 token 不能拿到本域名使用。两个地址使用同一账号库，但登录 Cookie 分别保存。

## 密钥

生产所需 secrets：`AUTH_SECRET`、`RESEND_API_KEY`、`RESEND_FROM`、`RESEND_OTP_TEMPLATE_ID`、`TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`。

首次部署通过 `wrangler deploy --env production --secrets-file .local/production.secrets.json` 与代码一同上传。该文件被 Git 忽略，生产 AUTH_SECRET 独立于本地开发密钥。不会上传临时 Resend Full access 配置，也不设置本地收信白名单。

后续部署沿用 Cloudflare 已保存的 secrets。需要修改时，在私密文件中只填写要新增或更新的键，再使用 `--secrets-file` 部署；该参数按键追加更新，省略的旧 secrets 保留。不要把密钥写入命令参数、源码、聊天或构建资源。

## 后续发布

在 `web/` 运行：

```sh
npm ci
npm run check
npm run cf:dry-run:production
npm run db:migrate:production
npm run cf:deploy
```

先在功能分支完成改动和检查，按分支流程合入 `develop`、`main` 后发布稳定版本。当前通过本地 Wrangler 发布，GitHub 推送本身不会触发部署。

## 本次验证

- 50 项账号与业务回归、lint、前后端类型、静态构建、本地 HTTP 检查通过；包括两个允许域名的登录、验证码发送与跨域 token 拒绝回归。
- 生产配置 dry-run 成功，远程数据库没有待应用迁移。
- Cloudflare 远程 workerd 验证 scrypt 哈希、正确密码校验与错误密码拒绝通过。
- 线上健康检查确认 D1 可访问；登录、注册、重置密码与发现页均可加载。
- 未登录访问股票、板块返回 401；跨站写入返回 403；缺少 Turnstile token 的登录被拒绝。
- 真实 Chrome 检查桌面登录和手机注册页面，无页面脚本错误和手机横向溢出。
- 自动浏览器停在人机验证步骤；用户随后在正常浏览器手动验证，并确认注册、验证码收信和密码登录均成功。
- 密码重置有回归测试覆盖，但本次未完成真实邮箱的线上重置检查；行情数据可达性也未作本次生产验证。

## 回退

上一个单人版本为 `9dc1a1b2-fb67-40d4-a0f9-5e608cc7c0bf`，使用原 D1 与 Basic Auth。回退会切回旧账号方式和旧数据视图，应在明确需要时执行：

```sh
npx wrangler rollback 9dc1a1b2-fb67-40d4-a0f9-5e608cc7c0bf --env production
```

Worker 代码回退不会撤销 D1 迁移或恢复数据库内容；独立生产账号库应保留，不执行删除或清空。

参考：[Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers Node crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。
