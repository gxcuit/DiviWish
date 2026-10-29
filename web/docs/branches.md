# 仓库与分支约定

长期维护规则见根目录 [MEMORY.md](../../MEMORY.md)，后续修改前先核对仓库与分支。

| 仓库 | 版本 | 分支 |
| --- | --- | --- |
| [gxcuit/DiviWish](https://github.com/gxcuit/DiviWish) | 无登录的本地 SQLite 单机版，npm / Docker 运行 | `main` 为稳定版，`codex/standalone` 为单机工作分支 |
| [gxcuit/DiviWish-private](https://github.com/gxcuit/DiviWish-private) | 登录、注册及用户隔离账号版 | `main` 为稳定版，`develop` 为集成分支，功能分支按账号版流程合入 |

通用功能或 bug 修复必须在两个仓库及各自对应分支实现和验证。共用计算、行情和界面逻辑可以定向移植；涉及数据库、账号和运行环境的差异分别适配。单机版移除登录的改动不能整分支合入账号版。

初次发布单机版以公开仓库现有提交为父提交，导入已检查的源码快照，不连接私有仓库历史。此工作目录的 `origin` 指向私有账号版，`legacy-origin` 指向公开单机版；上传前再次核对 URL，单机分支只推公开仓库。

网站所有开发与检查在 `web/` 进行，根目录 Excel 流程独立。运行 `npm run check` 验证类型、业务回归、构建与真实 HTTP/SQLite 持久化；Docker 另行构建和运行验证。

提交源码、依赖锁文件、迁移、测试、部署文件与文档，不提交个人数据库、快照、备份或账号配置。Git 推送不等于部署现有线上服务。
