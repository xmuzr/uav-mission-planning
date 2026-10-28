# v0.1.0 下载资产

[下载页面](https://github.com/xmuzr/uav-mission-planning/releases/tag/v0.1.0)

| 文件 | 大小（字节） | 内容 |
| --- | ---: | --- |
| `ruansan-model.zip` | 237588129 | 完整 ruansan 3D Tiles，解压至 `public/models/` |
| `technical-document.docx` | 3385029 | 原“技术文档.docx” |
| `experiment-report.docx` | 41585760 | 原“无人机多类型航线规划实验报告.docx” |
| `route-planning-demo.pptx` | 183919214 | 原“多模态航线规划算法.pptx” |
| `SHA256SUMS.txt` | — | 上述四个资产的 SHA-256 值 |

原始 Office 文件只修改下载文件名，内容保持不变。

```text
64708c94ae2ebec56e361a41492aa68231b6f2ce1aecdd639a23c24cb37be9ca  ruansan-model.zip
7a76348872d5c0678548a9dfba72dff9001254cb03b3351c4e2de47f34a74c36  technical-document.docx
3c92dcdef0f3132d00f6006fd68778489c094ee19a3dd507cc658eadf31286b7  experiment-report.docx
a68854dd0a71587eee32ecc38fdb7a32eff393a661cd6e8f407b2bca000f00da  route-planning-demo.pptx
```

PowerShell 可使用 `Get-FileHash -Algorithm SHA256 -LiteralPath 'ruansan-model.zip'` 检查下载文件。
