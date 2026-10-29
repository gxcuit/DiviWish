# 版本与分支维护

唯一维护仓库为 [gxcuit/DiviWish](https://github.com/gxcuit/DiviWish)。完整长期规则见 [MEMORY.md](../../MEMORY.md)。原 `DiviWish-private` 已停用，不再开发或推送，旧仓库保留。

| 分支 | 版本 | 用途与运行方式 |
| --- | --- | --- |
| [main](https://github.com/gxcuit/DiviWish/tree/main) | 单机版 | 稳定分支，无需登录，本地 SQLite，npm / Docker |
| [codex/standalone](https://github.com/gxcuit/DiviWish/tree/codex/standalone) | 单机版 | 单机开发分支，检查通过后合入 `main` |
| [multi-user](https://github.com/gxcuit/DiviWish/tree/multi-user) | 多人版 | 稳定分支，邮箱及 LinuxDO 登录、注册、会话、用户数据隔离；部署说明见该分支 `web/README.md` |
| [develop](https://github.com/gxcuit/DiviWish/tree/develop) | 多人版 | 多人集成开发分支，检查通过后合入 `multi-user` |

通用功能与 bug 修复必须分别在两版对应分支实现和验证。定向移植公共计算、行情与界面代码，适配各版数据库和账号模型，不整分支覆盖另一版。交付时记录两版分支、提交及验证结果。

本地 `origin` 统一指向公开仓库。多人版首次迁入采用当前源码快照，以公开仓库提交为父提交，不连接原私有仓库提交历史。两版使用独立本地数据库，切换分支不代表数据转换，不共用同一个 SQLite 文件。

所有网站开发及检查从 `web/` 运行。遵循当前分支的 `README.md` 与检查命令；单机版 Docker 需另行构建运行验证。根目录 Excel 流程独立；保留个人 SQLite、备份与快照，不提交真实密钥或数据。

推送代码不自动部署线上服务，也不迁移生产数据库。
