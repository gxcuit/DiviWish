# Cloudflare 生产部署

主地址：**https://diviwish.shaunko.tech**；备用地址：**https://diviwish.jackgao-china.workers.dev**。

当前生产版本为 `cc151b70-52b6-40d4-b01b-0514513d8515`，于 2026-11-03（Australia/Perth）从多人版稳定分支 `multi-user` 的源码提交 `0770f95` 发布，标签为 `0770f95`，接收 100% 流量。本次增加跨用户共享的公共分红日缓存，并在刷新时先显示价格，再检查当天分红。上一生产版本为 `e55da894-5d66-433e-9df5-6c50c4684e94`。

2026-10-28 首次账号版部署为 `83c32118-c504-4bb3-b944-e7022b07d27d`；自定义域名 Turnstile 修复为 `52e2b5cd-1edc-406d-98fc-2726ee710195`。2026-10-30 发布前的生产版本为 `76acf25a-657a-44f2-939f-cbbf1f9d2057`（LinuxDO 原生 fetch 修复）。

## 2026-11-03 公共分红日缓存与价格优先刷新发布验证

- 单机版 `main` / `codex/standalone` 源码为 `12584eb`，多人版 `develop` / `multi-user` 源码为 `0770f95`，均已推送。本文档提交晚于部署，实际部署源码仍为 `0770f95`。
- 刷新分为价格与分红两个阶段：价格先显示；分红快照以 UTC+8 自然日首次使用时查询并持久化，当天其他用户及新标的预览复用同一标的结果。数据库租约限制并发重复取数，失败保留原值并延后重试；个人自选、板块、目标股息率、网格和手工值不进入公共缓存。港币现金在应用时按当前汇率折算，公共原始快照保持不变。
- 单机版 86 项、多人版 115 项业务回归通过；两版 lint、前后端类型、webpack 构建、HTTP/临时 SQLite 和 596 像素浏览器验证通过。浏览器确认分红仍在等待时新价格已显示，第二次刷新不再调用分红来源。原生 workerd 临时 D1 验证日缓存和并发锁，以及原有 OAuth、会话与数据隔离通过。
- 生产仅有 `0005_public_dividends.sql` 待执行，已成功新增 `public_dividend_cache` 表；没有移动或删除用户表，没有将个人股票文档回填为公共来源。随后以 `deploy --env production --keep-vars --tag 0770f95` 发布，新版本 `cc151b70-52b6-40d4-b01b-0514513d8515` 接收 100% 流量。发布前后 D1、变量与密钥绑定逐项一致，发布后无待执行迁移。
- 两个域名各 10 项 HTTP 检查通过：D1 健康、登录配置及登录／注册／重置／发现页面正常，未登录股票／板块／历史接口返回 401，跨站刷新返回 403。线上实际引用的各 10 个 JS/CSS 产物均与本次构建 SHA-256 一致，看板脚本为 `3e8691a631e413ec17dc507e8661a55e89e3a327e1595ffda975e7a8c4a9a320`。
- 未登录真实生产用户、发送邮件或批量刷新个人股票；共享缓存和私有设置隔离在临时账号中验证。线上只读报告位于被忽略的 `.local/daily-dividends-production-verification.json`，浏览器报告位于各版 `.local/daily-cache-ui.json`。数据分层详见[账号说明](accounts.md#公开分红与个人数据分层)。

## 2026-11-02 批量刷新续查与 ETF 手工除息日修复发布验证

- 单机版 `main` / `codex/standalone` 源码为 `4b1c282`，多人版 `develop` / `multi-user` 源码为 `a4f4570`，四个分支均已推送至 `gxcuit/DiviWish`。本文档记录提交晚于部署，实际部署源码仍为 `a4f4570`。
- 批量刷新持久化最后尝试位置，再次刷新优先查询其后的股票并循环处理列表；失败批次也推进进度，单股刷新不改变批量进度。进度跨服务重启保留，多人版按账号隔离；删除进度位置对应的股票后仍可续查。
- ETF 日历合并查询日期和手工填写的除息日；没有查询明细时仍显示手工日期，同一标的同一天去重。
- 单机版 80 项、多人版 109 项业务回归通过；两版 lint、前后端类型检查、webpack 静态构建与临时 SQLite HTTP 检查通过。多人版原生 workerd 登录／会话／D1 隔离检查和生产配置 dry-run 通过。
- 使用 Wrangler `4.152.0` 以 `deploy --env production --keep-vars --tag a4f4570` 发布。新版本 `e55da894-5d66-433e-9df5-6c50c4684e94` 接收 100% 流量；发布前后 D1、变量与密钥名称逐项一致，没有执行数据库迁移或改动用户股票。
- 两个线上域名各 10 项 HTTP 检查通过：D1 健康、登录配置及登录／注册／重置／发现页面正常；未登录股票、板块、历史接口返回 401，跨站刷新返回 403。发现页实际引用的各 10 个 JS/CSS 产物均与本次构建 SHA-256 一致，看板脚本 SHA-256 为 `85f1535c5e702fd66cd551feb11cf64c45f18a072c3f675d295bfdbde7a605cd`。
- 本次线上检查未登录真实用户、发送邮件或刷新个人股票；续查、失败保留、账号隔离及日历行为在临时数据库／本地回归中验证。只读线上报告位于被忽略的 `.local/refresh-calendar-production-verification.json`。

## 2026-11-02 ETF 与新用户默认标的发布验证

- 两版通用功能已同步：境内 ETF 报价、天天基金逐次分红及新浪核验、已除息与待除息区分、拆分折算、日历、目标价格网格及所选口径的历史派息率百分位。ETF 历史曲线已按要求移除，保留当前百分位、60／90 分位及对应价格；滚动窗口的分红重叠和空档有说明。
- 添加标的只需名称或代码，自动识别证券类型和交易所；所属板块增加 ETF。新邮箱注册和新 LinuxDO 账号仅在创建时加入招商银行（600036）与红利ETF（510880），已有账号不补加股票，删除默认标的不再补回，行情与股息首次刷新后获取。
- 发布源码：单机版 `main` / `codex/standalone` 为 `96d36b1`，多人版 `develop` / `multi-user` 为 `b3783c5`，均已推送。单机 76 项、多人 105 项业务回归通过；两版 lint、类型、webpack 构建和临时 SQLite HTTP 检查通过。多人版恢复发布工作区后重新完成 105 项测试、完整 lint、前后端类型、webpack 构建、HTTP 账号隔离及生产 dry-run。
- Cloudflare 原生远程运行时真实验证 510880、562060、159331、512890 的报价、分红和历史取数；无分红的 512890 返回不适用。510880 取得 19 笔分红、滚动每份现金 0.143 元。主源偶发错误基金缓存片段和缺记录已增加片段身份／已除息日期检查，最多绕缓存重试一次，仍失败保留旧数据；详见 [ETF 数据说明](etf.md)。探针不绑定生产数据库或应用密钥。
- 使用项目 Wrangler 4.152.0 的 `deploy --env production --keep-vars` 发布，版本 `c0fc6de6-cac9-4a77-b042-959eb122754b` 接收 100% 流量。发布前后生产绑定逐项一致，沿用原 D1、变量和密钥，没有执行迁移、批量刷新或修改个人股票列表。
- 两个线上域名各 10 项 HTTP 检查通过：D1 健康、登录配置、登录／注册／重置／发现页面可访问，未登录的股票／板块／历史接口返回 401，跨站写入返回 403。Turnstile、LinuxDO 和 Resend 配置保持启用。两个域名实际引用的各 10 个 JS/CSS 产物全部与本次构建 SHA-256 一致。
- 看板脚本 SHA-256：`3e8691a631e413ec17dc507e8661a55e89e3a327e1595ffda975e7a8c4a9a320`。线上 Chromium 在两个域名的 1280／320 像素下验证发现页登录跳转、邮箱／密码／LinuxDO 入口及注册表单，无横向溢出或页面脚本错误。本次没有登录真实用户账号改动其列表，也未注册生产测试账号或发送真实邮件；登录后交互由此前临时数据库浏览器测试覆盖。
- 线上报告保存在被忽略的 `.local/etf-production-verification.json`，构建／部署／回归日志均在发布工作区 `.local/release-*`；浏览器报告位于单机工作区 `.local/etf-production-browser.json`。本节的文档提交晚于部署，实际部署源码仍为上文 `b3783c5`。

## 2026-11-01 年内涨跌与股息支付率验证

- 修复年内涨跌仅依赖导入 / 手动年初价、刷新无法自动补齐的问题。当前报价与上一年最后交易日收盘价取同一前复权快照；注明基准交易日和实际复权方式，跨年及缺失基准不会沿用错误旧值。
- 新增同财年年度每股现金股息 ÷ 基本每股收益的股息支付率，标注每股估算口径，与公告总额口径可能存在差异。港股读取原始利润表币种，与原始宣派股息币种匹配，不使用当前汇率混算；收益非正时不计算，零股息可为 0%，不限制 100% 上限。
- 单机版 `main` / `codex/standalone` 源码提交 `49dd304`，多人版 `develop` / `multi-user` 源码提交 `995485d`。单机 47 项、多人 74 项回归及两版 lint、类型、webpack 构建、HTTP 运行检查、多人原生 workerd 检查通过；两版 320/604/1280 像素 Chromium 验证新指标、说明和无横向溢出。回归覆盖证券 / 财年 / 币种匹配、零或负收益、超过 100% 的比率、并发编辑和账号隔离。
- 使用生产兼容日期 `2026-10-27` 的隔离 Cloudflare 远程预览，真实查询招商银行、紫金矿业、中国平安、华能国际、云铝股份、中国移动，六只均取得年内价格基准及年度支付率。招商银行在 2026-10-30 报价下为 +8.65%、每股口径支付率 35.37%；中国移动原始股息与每股收益币种均为 CNY。探针没有绑定数据库或应用密钥，检查后已停止。
- 发布前只读核对生产域名、D1 与密钥名称，生产 dry-run 通过；以 `--env production --keep-vars` 发布，无数据库迁移。新字段按股票 JSON 文档保存，已有股票需点击“刷新行情与股息”补齐，不批量改动线上个人数据。
- 生产版本 `9b139b57-33dc-42b6-bdd0-25473eb3bbcb` 已接收 100% 流量。两个域名的新看板脚本均与发布产物逐字节一致，含股息支付率、基准日期与缺失原因说明；JS SHA-256 为 `260af2f547292caf589d1372008451b44ca57a4974630a145cdb0c449dfd2d91`。D1 健康、登录页面和配置正常，未登录私有 API 返回 401、跨站写入返回 403。
- 本次未登录真实用户账号刷新其个人股票，也未发送真实邮件。线上用户数据保持原样；真实数据链路已在无数据库的 Cloudflare 预览验证，保存、刷新与隔离在临时数据库测试。公开取数和上线只读记录分别保存在被忽略的 `.local/financial-live-source-verification.json` 与 `.local/financial-production-verification.json`。

## 2026-11-01 BOLL 真实行情修复验证

- 已在 Cloudflare 远程临时运行时复现旧入口 `web.ifzq.gtimg.cn` 的 HTTP 501；同一 K 线请求在本机 Node 可返回 200。先前模拟行情和页面/权限检查未覆盖这条真实取数链路。
- 改为优先使用实测可用的腾讯 `ifzq.gtimg.cn`，失败后最多尝试一次同源 `web.ifzq.gtimg.cn`，证券、日周月、复权和日期参数不变。HTTP 错误响应释放连接，429 不切换入口重试；失败原因保留真实状态码，可见页面五秒后自动重试一次。
- 多人版修正每次 BOLL 请求重新创建缓存的问题，复用 Worker 实例内的公开 K 线缓存并支持 `refresh=1`。个人保存报价仍在每个账号请求内应用，新增回归验证两个账号相同证券的不同报价不会串用，且私有接口继续按账号校验。
- 使用生产相同的 `2026-10-27` 兼容日期在 Cloudflare 原生远程预览真实访问腾讯，招商银行、紫金矿业、中国平安、华能国际、云铝股份和港股中国移动共 18 个日/周/月 BOLL 周期全部取得有效 20 根样本，K 线截至 2026-10-30。探针未绑定数据库或应用密钥，检查后已停止。
- 单机版 42 项、多人版 69 项 Node 回归及共享 Flask 58 项回归通过；两版 lint、类型、webpack 构建、HTTP 运行检查及多人版 LinuxDO 原生检查通过。两版 320/604/1280 像素 Chromium 检查包含首次 HTTP 501 后五秒自动恢复，并验证详情刷新联动。
- 修复分别推送单机版 `main` / `codex/standalone` 的 `40f28e1`、多人版 `develop` / `multi-user` 的 `5e571f8`。生产 dry-run 通过，使用 `--env production --keep-vars` 发布，沿用既有变量、密钥和 D1，没有执行迁移或修改个人数据。
- 新生产版本 `45811e6a-4216-439c-a59f-579507545856` 接收 100% 流量；上一版为 `5f4f05cb-d5aa-42c3-9b64-ff06ecfe2e89`。两个域名页面和 D1 健康正常，私有股票/板块/BOLL 返回 401，跨站写入返回 403，登录配置保持启用；新脚本与样式均和发布产物逐字节一致。
- JS SHA-256：`8ae9e8a289e603fab16fb2af55969c584aee97389fbd6b9d2b9dfaa1fbfb15ab`。真实源数据与上线检查记录保存于被忽略的 `.local/boll-fallback-live-source-verification.json`、`.local/boll-production-verification.json`。本次没有登录真实生产账号手动操作标签；已使用真实 Cloudflare 取数和本地完整 API 验证链路。

## 2026-11-01 BOLL 标签发布验证

- 单机版 `main` / `codex/standalone` 已推送 `e2e1e06`，多人版 `develop` / `multi-user` 已推送并发布 `fd498d8`。
- 单机版 40 项、多人版 66 项 Node 测试及共享 Flask 56 项测试通过；两版 lint、类型、webpack 静态构建、本地 HTTP 运行检查通过，多人版 LinuxDO 原生 workerd 和生产配置 dry-run 通过。
- 两版均完成 320 / 604 / 1280 像素 Chromium 检查：两字标签、颜色、5% 邻近虚线、部分周期数据不足、可见行加载、最多两只并发请求、列表和详情共用缓存及刷新联动均通过；没有横向溢出或页面脚本错误。浏览器检查使用模拟行情与临时本机服务。
- 发布前核对生产身份、变量、D1 标识及必需密钥名称，以 Wrangler `4.152.0` 的 `deploy --env production --keep-vars` 发布；沿用原变量、密钥和账号 D1，没有执行数据库迁移。
- 新版本 `5f4f05cb-d5aa-42c3-9b64-ff06ecfe2e89` 接收 100% 生产流量，标签为 `fd498d8`；上一版为 `f6fd7365-f2cd-4260-8741-958523e91283`。
- 主域名及 workers.dev 备用域名的发现、登录、注册、重置密码页均返回 200，D1 健康检查正常，LinuxDO、邮件和 Turnstile 配置仍启用。未登录读取股票、板块及 BOLL 返回 401，跨站写入返回 403。
- 两个域名实际引用的新看板脚本与样式均和发布产物逐字节一致。JS SHA-256：`ba5ef13d9bf80c4e475481d9d0833466777715be31a3eaad82b249c3d63c83c4`；CSS SHA-256：`9ef712eb624fe6af0bc50d792e3da74429549390d33431a67a2fcf584e3d6429`。
- 本次没有登录真实账号操作 BOLL、发送真实邮件或修改生产数据；阈值及交互由本地回归和浏览器检查验证。线上验证记录位于发布工作区被忽略的 `.local/boll-production-verification.json`。

## 2026-11-01 历史分位发布验证

- 两次修复已分别推送单机版 `main` / `codex/standalone`（`27eee42`、`46fcffa`）和多人版 `develop` / `multi-user`（`19e1925`、`c85ee2f`）；多人版通过合并提交 `a6fe13d` 发布。
- 单机版 34 项、多人版 60 项 Node 业务 / 账号测试及共享 Flask 55 项测试通过；两版 lint、类型及 webpack 静态构建通过。本地 HTTP / SQLite、LinuxDO 原生 workerd 和生产配置 dry-run 已通过。
- 发布前确认生产账号、变量、D1 标识和密钥名称。使用锁定的 Wrangler `4.152.0`，以 `deploy --env production --keep-vars` 发布；沿用线上变量、密钥和既有账号 D1，未执行数据库迁移。
- 新版本 `f6fd7365-f2cd-4260-8741-958523e91283` 已接收 100% 生产流量，版本标签为 `a6fe13d`；上一版为 `acd397e9-a225-4b9c-b0e2-9363ee434e59`。
- 主域名与 workers.dev 备用域名的发现、登录、注册和重置密码页均返回 200，健康接口报告 D1 正常，LinuxDO、邮件和 Turnstile 登录配置仍启用。未登录访问股票和板块返回 401，跨站写入返回 403。
- 两个域名引用的新看板脚本与发布产物逐字节一致，包含所选历史序列和随口径变化的 60 / 90 分位标签。脚本 SHA-256：`b423639c45b5ac64b4cb7ae062c65cb8a55b9e05689b65b87d2ccf7aa1e6e55d`。
- 本次线上检查未登录真实账号切换口径，也未发送真实邮件；口径数值与账号隔离由临时数据库回归验证。验证明细保存在发布工作区被忽略的 `.local/percentile-production-verification.json`。

## 2026-10-30 发布验证

- 使用项目锁定的 Wrangler `4.152.0`，从独立多人版工作区构建；WSL 使用 Linux Node `24.21.0`，按 [WSL 流程](local-wsl.md) 显式 `--webpack` 导出静态页面。
- lint、前后端类型检查、57 项业务/账号回归、静态构建、生产环境 dry-run、本地 HTTP/SQLite 和 LinuxDO 原生 workerd 检查全部通过；测试使用临时数据库及模拟邮件/授权服务。
- 发布前确认生产变量、域名和账号 D1 ID 与仓库一致，核对现有密钥名称。通过 `wrangler deploy --env production --keep-vars` 发布，沿用已保存的运行密钥和额外变量；没有执行数据库迁移或更新密钥。
- 主域名和 workers.dev 备用域名的发现页均返回 200，并引用本次构建的网格组件脚本；线上脚本与本地构建逐字节一致，均包含三个 `min="0.1"`、`step="0.1"` 输入框。组件脚本 SHA-256：`08ff0abc5e3b3ed5de3300582607e251ca3e57c9ef826f533e3119dcc358d80a`。
- 两个域名的健康接口均报告 D1 正常；未登录访问股票接口返回 401，登录配置仍启用 LinuxDO。本次未登录真实账号执行网格编辑或真实邮件收发。
- 本机验证明细保存于被忽略的 `.local/grid-step-production-verification.json`。

### 发布登录凭据

当前 WSL 已通过 Wrangler 官方设备授权登录，凭据保存在 `/home/gao/.config/.wrangler/config/default.toml`；先运行项目本地 `wrangler whoami` 检查身份及账号。该文件由 Wrangler 管理，不复制进仓库，也不输出内容。

项目 `.local/production.secrets.json`、`.local/linuxdo-production.secrets.json` 和 `.dev.vars` 保存的是应用运行密钥；它们不包含本次使用的 Cloudflare 发布身份。新工作区不会自动复制被 Git 忽略的 `.local`，但同一 WSL 用户可复用全局 Wrangler 登录。需要重新授权时，可用项目本地 `wrangler login --device --browser=false`；必须在 Cloudflare 完成设备码授权，并等待 CLI 显示 `Successfully logged in.`。

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

原单人 D1 `diviwish`（`fcdcdfe4-b286-4e16-b911-8b0e70fe353e`）、本地 SQLite、快照和备份全部保留。新账号仅在创建时加入招商银行（600036）和红利ETF（510880）两个默认标的，行情与分红需刷新后获取；不导入旧个人数据。已有账号不补加标的，删除默认标的后不会再次生成。

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

先在功能分支完成改动和检查，按多人版分支流程合入 `develop`、`multi-user` 后发布稳定版本；`main` 属于单机版。当前工作机的 WSL 构建优先遵循 [已验证流程](local-wsl.md)，不要先重试默认 Turbopack。当前通过本地 Wrangler 发布，GitHub 推送本身不会触发部署。

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
