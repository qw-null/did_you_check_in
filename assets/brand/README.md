# 打卡了吗 · 头像资产

设计日期：2026-10-28。制作方式：SVG 矢量绘制，使用 rsvg-convert 导出 PNG。

## V3：一起打卡吗？

- 将 V2 优惠券中的“免费”替换为“一起打卡吗？”，按“一起 / 打卡吗？”两行居中排版，保留全角问号。
- 双羊、优惠券、百分号、对勾、配色与其他图形保持不变；V1、V2 均保留。
- 文字为矢量轮廓，SVG 无外部字体依赖。

| 文件 | 用途 |
| --- | --- |
| `avatar-v3.svg` | 可编辑矢量源文件 |
| `avatar-v3-1024.png` | 1024 × 1024 高清头像 |
| `avatar-v3-512.png` | 512 × 512 头像 |
| `avatar-v3-circle-preview.png` | 512 × 512 圆形裁切预览 |

## V2：一起薅福利

- 双羊结伴抱券，表达“一起打卡”和“薅羊毛”。
- 橙色优惠券上的“免费”与百分号突出福利和优惠；绿色对勾表达完成。
- 暖黄背景搭配橙色、蓝色与薄荷绿，使用深色描边和圆润轮廓。
- “免费”文字已转成矢量路径，SVG 不依赖外部字体或位图。
- 已检查方形与圆形裁切，以及 32、48、64 像素预览；极小尺寸主要识别双羊与优惠券的整体轮廓。
- 主体最远半径约 453.39px，小于 1024px 原图的圆形裁切半径 512px。

| 文件 | 用途 |
| --- | --- |
| `avatar-v2.svg` | 可编辑矢量源文件，1024 × 1024 viewBox |
| `avatar-v2-1024.png` | 1024 × 1024 高清头像 |
| `avatar-v2-512.png` | 512 × 512 头像 |
| `avatar-v2-circle-preview.png` | 512 × 512 透明圆形裁切预览 |

正式头像使用完整不透明方形 PNG；圆形文件用于预览裁切。V1 文件保留，V2 未覆盖原版。

## V1：极简清单

- 主色：`#0062CC`，与 PRD 主强调色一致；标记：`#FFFFFF`。
- 以清单和对勾表达任务管理与手动完成，不使用文字，避免小尺寸辨识困难。
- 图形居中，使用圆润笔画，预留圆形裁切的安全空间。
- 正式头像为完整不透明方形图，不预先切掉圆角；圆形文件仅用于裁切预览。

### 文件

| 文件 | 用途 |
| --- | --- |
| `avatar-v1.svg` | 可编辑矢量源文件，1024 × 1024 viewBox |
| `avatar-v1-1024.png` | 1024 × 1024 高清头像 |
| `avatar-v1-512.png` | 512 × 512 头像 |
| `avatar-v1-circle-preview.png` | 512 × 512 透明圆形裁切预览 |

已检查 32、48、64 像素预览，确认主要图形未被圆形裁切截断。后续调整保留原文件，使用 v2 等新版本文件名。

## 重新导出

在项目根目录执行：

```sh
rsvg-convert --width 1024 --height 1024 --output assets/brand/avatar-v1-1024.png assets/brand/avatar-v1.svg
rsvg-convert --width 512 --height 512 --output assets/brand/avatar-v1-512.png assets/brand/avatar-v1.svg
rsvg-convert --width 1024 --height 1024 --output assets/brand/avatar-v2-1024.png assets/brand/avatar-v2.svg
rsvg-convert --width 512 --height 512 --output assets/brand/avatar-v2-512.png assets/brand/avatar-v2.svg
rsvg-convert --width 1024 --height 1024 --output assets/brand/avatar-v3-1024.png assets/brand/avatar-v3.svg
rsvg-convert --width 512 --height 512 --output assets/brand/avatar-v3-512.png assets/brand/avatar-v3.svg
```
