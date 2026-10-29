# 账号与数据隔离

```text
浏览器（安全会话 Cookie） → 同源 /api → Worker 处理器
                                      ├─ 邮箱挑战：HMAC 摘要、10 分钟、最多 5 次
                                      ├─ Resend：已发布模板 + 独立幂等键
                                      ├─ Turnstile：服务端核对 success、hostname、action
                                      └─ D1：用户、会话、个人股票/板块/设置
本地：同一处理器 + Node HTTP + SQLite D1 适配
```

`GET /api/auth/config` 仅返回公开 sitekey、本地邮件模式与 LinuxDO 启用状态。`GET /api/auth/session` 返回当前用户或 null。`POST /api/auth/send-code` 要求 `purpose=register` 或 `reset_password`，发送验证码并返回 challengeId 和冷却时间，不返回验证码。`POST /api/auth/register` 要求有效的注册验证码和密码；`POST /api/auth/login` 验证邮箱和密码；`POST /api/auth/reset-password` 验证专用重置验证码并修改密码。原自动注册接口 `/api/auth/verify` 已移除。`POST /api/auth/logout` 撤销当前会话并清除 Cookie。

邮箱注册只有完成邮箱验证后才会创建账号。验证码使用安全随机源，保存带服务端 AUTH_SECRET 的 HMAC；会话 token 有 256 位随机性，只保存 SHA-256 摘要。数据库原子更新保证尝试次数、有效期和单次使用，防止并发重复消费。默认每邮箱冷却 60 秒、每小时 5 封；每 IP 每小时 20 次发送申请，全局每天最多 90 次发送申请。失败发送也计入申请预算，避免绕过限额。验证接口另有 IP 频率限制。

所有业务接口要求有效会话，从会话提取 user_id，不信任客户端传入的用户身份。`user_stocks`、`user_sectors` 和 `user_metadata` 的查询、更新及唯一约束都包含用户归属；其他用户请求资源 ID 返回 404。报价刷新只作用于请求用户，公共行情信息不会包含其他用户的自选、设置或身份。

生产环境要求 HTTPS、安全 Cookie、Resend 和 Turnstile。仅当请求和 APP_ORIGIN 都为 loopback 时允许终端验证码和不配置 Turnstile。写请求检查 Origin / Sec-Fetch-Site 和 JSON Content-Type。前端 401 会清除已显示账号视图并返回登录页；退出或切换用户会销毁旧界面状态。

`APP_ORIGIN` 指定主域名；`APP_ALLOWED_ORIGINS` 用逗号列出其他允许登录的完整 HTTPS origin。Turnstile 站点同时登记这些 hostname；服务端要求请求 origin 在明确配置中，且 Siteverify 返回的 hostname 与当前请求域名一致，不能跨域名复用 token。两个域名共用账号数据库，Cookie 只属于当前域名，因此切换地址后需分别登录。

`0001_initial.sql` 与旧单人表保留；`0002_accounts.sql` 新建独立账号表，不自动认领历史数据。`.local/accounts/diviwish.sqlite3` 为本地账号库；`backend/data/` 和 `.wrangler/state/` 保留。没有把个人 seed、SQLite、SQL 或 JSON 备份放入 out/。

本地 SQLite 适配执行真实 SQL 和事务，验证业务行为；不能替代 Cloudflare workerd 原生兼容验证。`wrangler.jsonc` 默认环境保留本地占位 D1；`env.production` 已绑定独立账号 D1，配置 HTTPS 地址、Resend 和真实 Turnstile，并已发布。生产 AUTH_SECRET 独立生成，应用 secrets 保存在 Cloudflare，私密部署文件放在被忽略的 `.local/`。密码哈希已通过远程原生 workerd 检查；具体验证范围见 [Cloudflare 部署](cloudflare-deployment.md)。

## 密码与旧账号迁移

`0003_passwords.sql` 为 users 增加可空 password_hash，为验证码增加用途。既有账号和会话保留；旧的未消费验证码标记为 legacy，不能用于新的注册或重置流程。新注册必须有密码，旧账号只能在证明邮箱归属后设置首个密码，不能重新注册覆盖原账号。

密码只要求大于 6 个 Unicode 字符，不要求字符组合；注册、首次设置和重置使用相同规则。登录页显示“忘记密码”入口。

密码使用 Node/Workers 的原生 scrypt，N=2^14、r=8、p=5，独立 128 位随机盐，32 字节摘要；采用 OWASP 的 16 MiB 配置，不截断密码，比较使用 timingSafeEqual。Cloudflare 当前 compatibility_date 下提供 node:crypto 支持。部署前应在原生运行时核对 scrypt 的 CPU 和并发内存预算，不承诺免费 Workers CPU 额度足够。

密码登录每 IP 10 分钟最多 30 次、每邮箱 15 分钟最多 10 次。未知邮箱和旧无密码账号会执行相同的虚拟哈希运算，统一返回“邮箱或密码不正确”。线上登录要求 action=password_login 的 Turnstile 验证；发验证码要求 action=send_otp，两种 token 不能混用。

密码校验后签发会话时再次匹配当前密码摘要，防止并发密码重置后旧密码登录创建新会话。重置密码原子更新凭据并撤销该账号全部旧会话；竞争修改失败时要求重新获取验证码。

参考：[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[Cloudflare node:crypto 支持](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)。

## LinuxDO 授权登录

新增独立授权码流程、原账号绑定和 `0004_linuxdo.sql` 迁移。按不可变提供方 ID 识别账号，绑定要求原登录会话仍然有效；不按邮箱自动合并。具体配置、数据兼容与安全检查见 [LinuxDO 接入](linuxdo.md)。
