# Resend 配置与本地收信测试

流程依据 https://resend.com/setup.md。应用使用官方 `resend` SDK，以已发布的 Resend 模板发送验证码，不在前端或 Worker 中内嵌邮件 HTML。

## 账号配置

在 `.local/resend-setup.env` 私密填写以下配置。不要把密钥贴进聊天、命令行参数或 Git：

```dotenv
RESEND_SETUP_API_KEY=临时Full_access密钥
RESEND_DOMAIN=mail.example.com
RESEND_REGION=ap-northeast-1
RESEND_TEST_RECIPIENT=自己的收信邮箱
```

在 `.dev.vars` 填写 `RESEND_FROM="DiviWish 息望 <login@mail.example.com>"`，然后运行 `npm run resend:setup`。

脚本会复用或创建发信域名，创建仅限该域名的 `sending_access` 密钥并私密写入 `.dev.vars`，创建/发布 `diviwish-login-otp` 模板，核对模板变量 `CODE`、`EXPIRES_MINUTES`，并生成 `.local/resend-dns-records.md`。模板 HTML 草稿只在初次配置时从 `.local/resend-otp-template.html` 读取，应用只使用云端模板 ID。

域名的 region 和 return-path 不能随意更改。脚本选择东京区域；已有域名保持其区域。DNS 必须使用 Resend 实际返回的记录，不猜测 DKIM。

## DNS 与验证

脚本不会写入 DNS 或发布网站。审核 `.local/resend-dns-records.md` 中的记录后，在 Resend 域名页面使用 Auto configure，或在 Cloudflare DNS 手动添加，CNAME 使用 DNS only。已有 DMARC 记录需要先确认策略，避免覆盖。

```sh
npm run resend:status
```

看到域名 `verified` 后，在 `.dev.vars` 设置：

```dotenv
AUTH_EMAIL_MODE=resend
RESEND_TEST_RECIPIENT=自己的测试邮箱
```

然后重启本地服务，通过网站的获取验证码按钮测试实际注册/登录。`RESEND_TEST_RECIPIENT` 是本地测试收信白名单；开放其他用户前再移除。

域名未验证时，Resend 测试发件人 `onboarding@resend.dev` 只能向账号本人的邮箱或官方测试地址发信；本项目创建的域名专用发送密钥不能用于该测试域名。

## 邮件投递检查

Worker 仅记录 Resend email ID，不记录真实验证码、密钥或会话 token。发送被 API 接受不等于已经送达，应在 Resend 邮件详情确认 `delivered`，必要时查看 Deliverability Insights。代码发送使用每次挑战独立的幂等键，同一次失败重试复用同一键；网络错误、429、5xx 退避重试并遵守 Retry-After，其余 4xx 不重试。

设置完成后可撤销临时 Full access 密钥；应用只需要 `.dev.vars` 内的发送专用密钥。保留自己的账号、域名和发信配置，不把个人邮箱或生产凭据写入公开示例。
