# Slice Studio

在浏览器中把素材合集和 UI 参考图切成独立 PNG。识别、模型推理和导出均在本机运行，项目自动保存在当前浏览器。

## 启动

使用 64 位 Python 3.12。在项目根目录打开 PowerShell。

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe install_models.py
.venv\Scripts\python.exe studio.py
```

打开 [本地工作台](http://127.0.0.1:8765)。安装脚本下载并校验约 42.6 MiB 的 MobileSAM 模型文件。明确背景的颜色分割、GrabCut、蒙版编辑和导出可以在跳过模型安装的情况下使用。安装完成后，处理素材无需联网。

macOS / Linux 的虚拟环境解释器路径为 `.venv/bin/python`。当前验收环境为 Windows 11 和 Chrome。

## 工作流

1. 导入或拖入静态 PNG、JPG、WebP。本地有参考图时，初始界面提供对应的快捷入口。
2. 点击「智能识别」。有主导背景色的素材表使用颜色分割，遇到复杂背景时，自动模式可调用本地 MobileSAM。也可以在下拉菜单指定引擎和灵敏度。
3. 在画布或右侧列表选择素材，通过框选、分割或套索补加素材；用画笔和橡皮擦修整蒙版。查看原图、识别边界、蒙版、透明预览或可滑动对比。
4. 双击素材打开单独预览，切换深色、浅色或棋盘格背景。能估算背景色的素材默认开启「清理白边」，可在预览内切换并直接下载当前透明 PNG。批量导出生成原尺寸 PNG 和 `manifest.json`。清单中的 X、Y 从已应用 EXIF 方向的原图左上角开始，以原图像素计。
5. 通过「项目 → 下载项目文件」保存可携带的 `.slice`，包含原图、坐标和蒙版。浏览器还会恢复最近一次打开的项目。

Ctrl / ⌘ + O 导入，Ctrl / ⌘ + Z 撤销，Ctrl / ⌘ + Shift + Z 重做，滚轮缩放，空格加拖动平移，0 适合窗口，Shift / Ctrl / ⌘ 加点选可多选。工作台右上角提供完整帮助。

## 验证

复现实测需要将有权使用的原始参考图放入 `test-assets/`，文件名依次为 `1.jpg`（复古物件）、`2.jpg`（等距场景）、`3.jpg`（植物水彩）。公开仓库包含测试脚本和实测结果，图像输入由运行测试的一方提供。使用自己的素材时，可直接从工作台导入，验证识别、编辑和导出。

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-test.txt
.venv\Scripts\python.exe -m unittest discover -s tests -v
.venv\Scripts\python.exe -m tests.browser_flow
.venv\Scripts\python.exe -m tests.benchmark
```

浏览器测试使用已安装的 Chrome，测试端口为 8768，产物写入 `tests/artifacts/`。可设置 `$env:SLICE_BROWSER = "msedge"` 使用已安装的 Edge。

原图像素尺寸和原始文件会保留。「清理白边」会估算外轮廓与透明镂空附近的覆盖和颜色。关闭后，导出保留解码后的源 RGB。重叠后被遮挡的像素、浅色对象与同色背景无法可靠分离。更完整的架构、测量方法、视觉复核和授权来源见 [技术选型与验证报告](docs/05-技术选型与验证报告.md)。
