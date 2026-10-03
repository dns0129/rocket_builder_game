# 工作约定

- 每次完成任务后，除了推送到当前开发分支，还要把改动合并到 `main` 并推送（能快进就快进，否则用合并提交，不改写 `main` 的历史）。合并前先跑 `npm test`、`npm run typecheck` 等相关检查。
- 合并进 `main` 之后，再用 `main` 的最新代码更新网页版游戏（claude.ai 上的私有 Artifact，一直沿用这个链接，不要另建新的）：https://claude.ai/artifact/8WFX2o9tB1kpJnEhuxMhnu
  1. `npm run artifact`：构建游戏，生成发布用的页面 `dist/artifact.html`，并打印发布用的文件映射（`page` 和 `files`）。
  2. 用 Artifact 工具先 `read` 这个链接，再 `list`（`scope: "files"`）列出已发布的文件。
  3. 发布：`url` 填上面的链接，`file_path` 填 `dist/artifact.html`，`files` 填第 1 步打印的映射；已发布、但这次映射里没有的 `assets/` 旧文件（文件名带哈希）传 `null` 删掉。
  4. 只改了文档、测试等、不影响构建产物时可以不发布，但要在回复里说明网页已是 `main` 的最新版本。
