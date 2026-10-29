# DiviWish · 息望

- 所有股息率网站的开发与维护统一在 `web/` 进行，包括前端、Flask 后端、数据库和网站文档。
- 网站源码、依赖、启动器和文档均在本项目的 `web/` 维护，不依赖相邻项目。
- 根目录的 `scripts/`、`data/`、`pictures/` 和 `run.cmd` / `run.sh` 属于 Excel 股息跟踪流程；网站启动器位于 `web/run.cmd`。
- 网站开发与检查命令从 `web/` 运行，详见 `web/README.md`。迁移、清理和检查时保留 `web/backend/data/` 中的 SQLite、备份和初始快照。
- 根 README 展示网站功能与截图；Excel 操作说明位于 `docs/excel-workflow.md`。

## 版本维护记忆

- 开始开发或发布前读取 [MEMORY.md](MEMORY.md)。
- 两个版本统一维护在 `gxcuit/DiviWish`：`main` / `codex/standalone` 为单机版，`multi-user` / `develop` 为多人版；`DiviWish-private` 已停用。
- 通用功能或 bug 修复必须在两版对应分支分别实现、检查并同步；专属功能按版本维护。
