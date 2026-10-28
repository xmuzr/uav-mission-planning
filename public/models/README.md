# 示例模型

从 [v0.1.0 Release](https://github.com/xmuzr/uav-mission-planning/releases/tag/v0.1.0) 下载 `ruansan-model.zip` 并在本目录解压。

正确结构为 `public/models/ruansan/tileset.json`，以及其引用的瓦片子目录。该模型约 260 MiB，作为 Release 资产分发，不写入 Git 历史。

开发模式直接读取本目录；生产模式会在 `npm run build` 时将模型复制到 `dist/models/`。仅编辑二维航线时可不下载模型。
