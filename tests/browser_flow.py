"""Run the normal workbench flows against real images in Chromium."""

from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
from time import monotonic, sleep
from urllib.request import urlopen
from zipfile import ZipFile

import numpy as np
from PIL import Image
from playwright.sync_api import expect, sync_playwright

from engine import decode


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "artifacts"
URL = "http://127.0.0.1:8768"


def screenshot(page, name):
    page.screenshot(path=OUT / f"workspace-{name}.png", animations="disabled")


def source_point(page, x, y, size=(600, 372)):
    view = page.locator("#canvas").bounding_box()
    width, height = size
    scale = min(1, max(20, view["width"] - 52) / width, max(20, view["height"] - 48) / height)
    return (view["x"] + (view["width"] - width * scale) / 2 + x * scale,
            view["y"] + (view["height"] - height * scale) / 2 + y * scale)


def drag(page, points):
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    page.mouse.move(*source_point(page, *points[0]))
    page.mouse.down()
    for point in points[1:]:
        page.mouse.move(*source_point(page, *point), steps=8)
    page.mouse.up()


def save_export(page, destination, scope=None):
    page.locator("#export").click()
    if scope:
        page.locator("#export-scope").select_option(scope)
    with page.expect_download() as event:
        page.locator("#export-confirm").click()
    event.value.save_as(OUT / destination)
    expect(page.locator("#cancel")).to_be_hidden()


def flow(browser, installed):
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto(URL)
    expect(page.locator("#engine-state")).to_have_class("engine-state online")
    expect(page.locator("#empty")).to_be_visible()
    screenshot(page, "empty")

    page.locator("#image-input").set_input_files(ROOT / "test-assets" / "2.jpg")
    expect(page.locator("#dimensions")).to_have_text("600 × 372 px")
    page.locator("#analyze").click()
    expect(page.locator("#asset-count")).not_to_have_text("0")
    initial = int(page.locator("#asset-count").text_content())
    expect(page.locator(".asset-thumb canvas").first).to_be_visible()
    page.mouse.click(*source_point(page, 470, 53))
    expect(page.locator(".asset").first).to_have_class("asset selected")
    page.locator(".asset").nth(1).click(modifiers=["Shift"])
    expect(page.locator(".asset.selected")).to_have_count(2)
    page.locator(".asset").first.click()
    page.locator(".asset").first.click(button="right")
    page.locator("#context-preview").click()
    expect(page.locator("#preview-image")).to_be_visible()
    page.locator("#preview-background").select_option("checker")
    expect(page.locator("#preview-stage")).to_have_attribute("data-background", "checker")
    page.locator("#preview-zoom").select_option("2")
    old_preview = page.locator("#preview-image").get_attribute("src")
    expect(page.locator("#preview-edge")).to_be_checked()
    page.locator("#preview-edge").uncheck()
    expect(page.locator("#preview-image")).not_to_have_attribute("src", old_preview)
    expect(page.locator("#preview-image")).to_be_visible()
    old_preview = page.locator("#preview-image").get_attribute("src")
    page.locator("#preview-edge").check()
    expect(page.locator("#preview-image")).not_to_have_attribute("src", old_preview)
    expect(page.locator("#preview-image")).to_be_visible()
    with page.expect_download() as download:
        page.locator("#preview-download").click()
    download.value.save_as(OUT / "solo-preview.png")
    assert Image.open(OUT / "solo-preview.png").mode == "RGBA"
    page.locator("#preview-close").click()
    expect(page.locator("#asset-preview")).to_be_hidden()
    expect(page.locator("#decontaminate")).to_be_checked()

    page.locator('[data-tool="box"]').click()
    drag(page, [(13, 180), (103, 294)])
    expect(page.locator(".asset")).to_have_count(initial + 1)
    page.locator("#asset-name").fill("等距屋")
    page.locator("#asset-name").press("Enter")
    expect(page.locator(".asset.selected .asset-name")).to_have_text("等距屋")
    save_export(page, "rect.png")
    before = np.asarray(Image.open(OUT / "rect.png"))
    expected = decode((ROOT / "test-assets" / "2.jpg").read_bytes())
    # Fractional pointer rounding may extend a rectangle by one source pixel.
    assert 90 <= before.shape[1] <= 92 and 114 <= before.shape[0] <= 116
    assert np.array_equal(before[12:-12, 12:-12, :3], expected[
        192:192 + before.shape[0] - 24, 25:25 + before.shape[1] - 24, :3])
    assert (before[:, :, 3] == 255).all()

    page.locator('[data-tool="erase"]').click()
    page.locator("#fit").click()
    drag(page, [(38, 218), (61, 239)])
    expect(page.locator("#status")).to_have_text("蒙版已更新")
    save_export(page, "edited.png")
    edited = np.asarray(Image.open(OUT / "edited.png"))
    assert np.count_nonzero(edited[:, :, 3] == 0) > 200
    assert np.array_equal(edited[:, :, :3], before[:, :, :3])
    page.keyboard.press("Control+z")
    expect(page.locator("#status")).to_have_text("已撤销")
    page.keyboard.press("Control+Shift+z")
    expect(page.locator("#status")).to_have_text("已重做")
    page.locator('[data-tool="brush"]').click()
    drag(page, [(39, 219), (59, 238)])
    expect(page.locator("#status")).to_have_text("蒙版已更新")
    save_export(page, "restored.png")
    restored = np.asarray(Image.open(OUT / "restored.png"))
    assert np.count_nonzero(restored[:, :, 3] == 0) < np.count_nonzero(edited[:, :, 3] == 0)

    page.locator('[data-tool="segment"]').click()
    if installed:
        page.locator("#segment-method").select_option("sam")
    drag(page, [(13, 180), (103, 294)])
    expect(page.locator(".asset")).to_have_count(initial + 2, timeout=10000)
    save_export(page, "segment.png")
    segmentation = np.asarray(Image.open(OUT / "segment.png"))
    assert np.count_nonzero(segmentation[:, :, 3]) > 500
    assert np.count_nonzero(segmentation[:, :, 3] == 0) > 500
    page.locator('[data-tool="lasso"]').click()
    drag(page, [(451, 178), (461, 178), (462, 204), (451, 204), (451, 178)])
    expect(page.locator(".asset")).to_have_count(initial + 3)
    page.locator("#delete").click()
    expect(page.locator(".asset")).to_have_count(initial + 2)
    page.locator("#undo").click()
    expect(page.locator(".asset")).to_have_count(initial + 3)

    page.locator('[data-view="compare"]').click()
    page.locator("#compare-position").fill("64")
    page.locator("#zoom-in").click()
    page.locator('[data-tool="pan"]').click()
    page.mouse.move(*source_point(page, 200, 160))
    page.mouse.down()
    page.mouse.move(*source_point(page, 275, 198), steps=10)
    page.mouse.up()
    page.locator("#fit").click()
    save_export(page, "bundle.zip", "all")
    with ZipFile(OUT / "bundle.zip") as bundle:
        manifest = json.loads(bundle.read("manifest.json"))
        assert len(manifest["assets"]) == initial + 3
        for entry in manifest["assets"]:
            with Image.open(BytesIO(bundle.read(entry["file"]))) as png:
                assert png.mode == "RGBA" and png.size == (entry["width"], entry["height"])

    if installed:
        page.locator("#analysis-menu summary").click()
        page.locator("#method").select_option("sam")
        page.locator("#analyze").click()
        expect(page.locator("#cancel")).to_be_visible()
        page.locator("#cancel").click()
        expect(page.locator("#status")).to_have_text("已取消")
        expect(page.locator(".asset")).to_have_count(initial + 3)

    expect(page.locator("#saved")).to_have_text("已保存到本机")
    page.locator("#project-menu summary").click()
    with page.expect_download() as event:
        page.locator("#project-save").click()
    event.value.save_as(OUT / "portable.slice")
    page.reload()
    expect(page.locator(".asset")).to_have_count(initial + 3)
    old = page.evaluate("localStorage.getItem('slice-studio-active')")
    page.locator("#project-input").set_input_files(OUT / "portable.slice")
    page.wait_for_function("(previous) => localStorage.getItem('slice-studio-active') !== previous", arg=old)
    expect(page.locator("#saved")).to_have_text("已保存到本机")
    expect(page.locator(".asset")).to_have_count(initial + 3)

    page.locator("#image-input").set_input_files({"name": "bad.png", "mimeType": "image/png", "buffer": b"not a png"})
    expect(page.locator("#notice")).to_be_visible()
    expect(page.locator(".asset")).to_have_count(initial + 3)
    page.locator("#notice-close").click()
    page.evaluate("""async () => {
        const image = await (await fetch("/samples/3.jpg")).blob();
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([image], "3.jpg", {type: "image/jpeg"}));
        document.querySelector("#viewport").dispatchEvent(new DragEvent("drop", {dataTransfer, bubbles: true}));
    }""")
    expect(page.locator("#dimensions")).to_have_text("1784 × 1681 px")
    page.locator("#analyze").click()
    expect(page.locator(".asset-thumb canvas").first).to_be_visible()
    page.locator(".asset").nth(4).click()
    screenshot(page, "plant")
    page.locator(".asset").nth(4).dblclick()
    expect(page.locator("#preview-image")).to_be_visible()
    screenshot(page, "single-asset")
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 420, "height": 760})
    screenshot(page, "narrow")
    page.get_by_role("button", name="素材面板").click()
    expect(page.locator("#inspector")).to_be_visible()
    screenshot(page, "narrow-inspector")
    page.get_by_role("button", name="素材面板").click()
    expect(page.locator("#inspector")).to_be_hidden()
    assert page.evaluate("document.documentElement.scrollWidth === innerWidth")
    page.set_viewport_size({"width": 960, "height": 720})
    metrics = page.context.new_cdp_session(page)
    metrics.send("Emulation.setDeviceMetricsOverride", {
        "width": 960, "height": 720, "deviceScaleFactor": 2, "mobile": False
    })
    page.wait_for_function("""() => {
        const canvas = document.querySelector("#canvas");
        return innerWidth === 960 && innerHeight === 720 && window.devicePixelRatio === 2 &&
            canvas.width === canvas.clientWidth * 2;
    }""")
    screenshot(page, "highdpi")
    assert not errors, errors


def main():
    OUT.mkdir(exist_ok=True)
    with (OUT / "browser-server.log").open("w", encoding="utf-8") as log:
        server = subprocess.Popen([sys.executable, str(ROOT / "studio.py"), "--port", "8768"],
                                  cwd=ROOT, stdout=log, stderr=log, env={**os.environ, "PYTHONUTF8": "1"})
        try:
            limit = monotonic() + 15
            while True:
                try:
                    with urlopen(URL + "/api/v1/status", timeout=1) as response:
                        installed = json.load(response)["model"]
                    break
                except OSError:
                    if server.poll() is not None or monotonic() >= limit:
                        raise RuntimeError("Browser test service failed to start.")
                    sleep(.15)
            with sync_playwright() as playwright:
                channel = os.environ.get("SLICE_BROWSER", "chrome")
                browser = playwright.chromium.launch(channel=channel, headless=True)
                flow(browser, installed)
                print(f"Browser flow passed ({channel} {browser.version}, MobileSAM={installed}).")
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=8)


if __name__ == "__main__":
    main()
