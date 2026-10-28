# 系统架构与源码索引

## 运行边界

应用是一个 Vue 单页应用，业务计算主要在浏览器中完成。Vite 提供开发和构建工具，Cesium 静态资源由构建插件配置。`server.cjs` 只负责本地生产构建静态服务，不承担任务调度或飞控通信。

## 主要源码

| 文件或目录 | 职责 |
| --- | --- |
| `src/main.js` | 注册 Vue、Ant Design Vue 和 Vue Cesium |
| `src/App.vue` | 挂载航线规划主界面 |
| `src/components/WaypointGenerator/index.vue` | 任务配置、视图切换、航线生成、保存与导出编排 |
| `MissionLibrary.vue` / `CreateMissionModal.vue` | 航线库与任务创建 |
| `MapViewer.vue` | 地图交互与二维航线显示 |
| `SlopeTilesetViewer.vue` / `SlopeRoutePlanner.vue` | 斜面模型与规划交互 |
| `GeometryTilesetViewer.vue` | 几何体及精细贴近摄影规划、模型拾取和展示 |
| `CloseTilesetViewer.vue` | 贴近摄影模型交互组件 |
| `src/utils/routePlanner.js` | 平面投影与区域扫描工具 |
| `polygonRouteGenerator.js` | 面状、多方向倾斜扫描与相机参考间距 |
| `stripRouteGenerator.js` | 中心线共享截面与带状扫描 |
| `slopeRouteGenerator.js` | 斜面局部坐标、法线与扫描布局 |
| `closeRoutePlanning.js` | 表面采样、拍摄候选、连接段与诊断 |
| `geometryCoverageSurface.js` | 几何体表面可见性与覆盖样本 |
| `geometryCameraFootprint.js` / `geometryCoveragePreview.js` | 摄影覆盖计算与预览 |
| `coordTransform.js` / `geoUtils.js` | 坐标转换与地理计算 |
| `kmzGenerator.js` / `kmzParser.js` | KMZ 打包、解析与 WPML 字段处理 |

表中省略路径的文件位于 `src/utils/` 或上文所示组件目录。部分组件保留早期实现，实际挂载关系以 `index.vue` 为准。

## 规划数据流

任务配置保存航线类型、相机和飞行参数。地图边界、中心线或模型选区进入相应生成器，生成航点及附加属性。主界面将结果交给展示组件，保存到浏览器，或传给 KMZ 生成器。KMZ 导入由解析器转换后接入任务编辑流程。

精细贴近摄影以命中的模型表面为目标，通过法线、视线和净空条件选择拍摄位置。无法安排的目标保留为诊断信息；拍摄点之间通过经过检查的连接段组织连续路线。过渡点不触发拍摄动作。

## 外部资源

- 地图影像：在线高德瓦片。
- 示例模型：本项目既有 `ruansan` 3D Tiles 数据，通过 Release 分发。
- 依赖包：按 `package-lock.json` 使用 npm 安装，许可证各自保留。
- 数据持久化：浏览器 `localStorage`，无服务器数据库。

充电管理、能耗约束优化、任务分配及动态调度没有对应的执行模块，不能从课题名称推定本仓库已有这些能力。
