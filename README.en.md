# UAV Mission Planning

[简体中文](README.md) · [Releases](https://github.com/xmuzr/uav-mission-planning/releases/tag/v0.1.0)

A browser-based UAV route planning application built with Vue 3, CesiumJS and Three.js. It supports waypoint, patrol, polygon mapping, oblique, corridor, slope, geometric and close-range photography routes, with map/model interaction, coverage previews, local mission storage and DJI WPML KMZ import/export.

![Close-range photography planning](docs/images/06-close-photography.png)

This repository contains the route-planning part of a broader research project. Charging management, battery optimization, dynamic task scheduling and flight-control integration are not implemented in this source baseline.

## Run

Use Node.js 22.21.1 or a compatible Node.js 22/24 release and a WebGL-enabled browser.

```bash
git clone https://github.com/xmuzr/uav-mission-planning.git
cd uav-mission-planning
npm ci
npm run dev -- --host 127.0.0.1
```

For the default 3D model views, download `ruansan-model.zip` from the [release](https://github.com/xmuzr/uav-mission-planning/releases/tag/v0.1.0) and extract it into `public/models/`. The resulting tileset must be at `public/models/ruansan/tileset.json`. Online map imagery requires network access.

```bash
npm test
npm run build
npm start
```

The production server binds to `127.0.0.1`, starting at port 5173. Download the model before building if it should be included in the production output.

## Documentation

- [Usage](docs/USAGE.md), [architecture](docs/ARCHITECTURE.md) and [validation](docs/VALIDATION.md) are currently in Chinese.
- Six screenshots in `docs/images/` are extracted from the project's existing technical documents.
- The release contains the sample 3D tiles, technical document, experimental report, presentation and SHA-256 checksums.
- Source retains the existing [GPL-3.0 license](LICENSE). Third-party dependencies and data retain their respective rights.

The existing 26 tests cover selected planning, geometric visibility and KMZ export behavior. They do not establish real-flight performance, physical safety or quantified coverage guarantees.
