# v0.1.0 下载资产

[下载页面](https://github.com/xmuzr/uav-mission-planning/releases/tag/v0.1.0)

| 文件 | 大小（字节） | 内容 |
| --- | ---: | --- |
| `ruansan-model.zip` | 237588129 | 完整 ruansan 3D Tiles，解压至 `public/models/` |
| `route-planning-demo.pptx` | 183919214 | 原“多模态航线规划算法.pptx” |
| `SHA256SUMS.txt` | — | 上述两个资产的 SHA-256 值 |

演示文件只修改下载文件名，内容保持不变。Word 文档不上传 GitHub。

```text
64708c94ae2ebec56e361a41492aa68231b6f2ce1aecdd639a23c24cb37be9ca  ruansan-model.zip
a68854dd0a71587eee32ecc38fdb7a32eff393a661cd6e8f407b2bca000f00da  route-planning-demo.pptx
```

PowerShell 可使用 `Get-FileHash -Algorithm SHA256 -LiteralPath 'ruansan-model.zip'` 检查下载文件。
