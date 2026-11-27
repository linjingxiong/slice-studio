from pathlib import Path
from statistics import median
from threading import Event, Thread
from time import perf_counter
import json

import numpy as np
from PIL import Image, ImageDraw
from psutil import Process

from engine import decode, detect, render
from neural import available, propose


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "artifacts"


def measure(run, repeats=1):
    process = Process()
    baseline = process.memory_info().rss
    peak = baseline
    done = Event()

    def sample_memory():
        nonlocal peak
        while not done.wait(.008):
            peak = max(peak, process.memory_info().rss)

    monitor = Thread(target=sample_memory)
    monitor.start()
    times = []
    try:
        for _ in range(repeats):
            start = perf_counter()
            result = run()
            times.append(round((perf_counter() - start) * 1000))
            peak = max(peak, process.memory_info().rss)
    finally:
        done.set()
        monitor.join()
    return result, {"time_ms": times, "median_ms": median(times), "rss_peak_mib": round(peak / 2**20, 1),
                    "rss_before_mib": round(baseline / 2**20, 1)}


def panel(source, regions, background, outlined):
    original = Image.fromarray(source)
    if outlined:
        draw = ImageDraw.Draw(original)
        for i, region in enumerate(regions, 1):
            x, y, w, h = region.box
            draw.rectangle((x, y, x+w-1, y+h-1), outline="#199c74", width=2)
            draw.rectangle((x, y, x+16, y+12), fill="#1a5e47")
            draw.text((x+1, y), str(i), fill="#ffffff")
        return original
    result = Image.new("RGBA", original.size, "#303741")
    for region in regions:
        result.alpha_composite(Image.fromarray(render(source, region.box, region.alpha, background)), region.box[:2])
    return result


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    summary = {}
    sheet = Image.new("RGB", (1296, 1272), "#20242a")
    labels = ImageDraw.Draw(sheet)
    sources = []
    for column, file in enumerate(sorted((ROOT / "test-assets").glob("*.jpg"))):
        source = decode(file.read_bytes())
        sources.append((file.name, source))
        (regions, background, status), color = measure(lambda: detect(source), 3)
        masks = np.concatenate([region.alpha.ravel() for region in regions])
        summary[file.name] = {
            "size": [source.shape[1], source.shape[0]],
            "color": {**color, "assets": len(regions), "status": status,
                      "partial_alpha_pixels": int(np.count_nonzero((masks > 0) & (masks < 255)))},
        }
        panels = [("color proposals", panel(source, regions, background, True)),
                  ("transparency preview", panel(source, regions, background, False))]
        for row, (label, view) in enumerate(panels):
            view.thumbnail((416, 395))
            left, top = column * 432 + 8, row * 424
            labels.text((left, top+4), f"{file.name}  {label}", fill="#ffffff")
            sheet.paste(view, (left, top+23), view)
    if available():
        for column, (name, source) in enumerate(sources):
            sam, timing = measure(lambda: propose(source, 50, lambda: None))
            summary[name]["mobilesam"] = {**timing, "assets": len(sam)}
            view = panel(source, sam, None, True)
            view.thumbnail((416, 395))
            left, top = column * 432 + 8, 848
            labels.text((left, top+4), f"{name}  MobileSAM proposals", fill="#ffffff")
            sheet.paste(view, (left, top+23), view)
    sheet.save(OUT / "algorithm-review.jpg", quality=92)
    result = json.dumps(summary, indent=2)
    (OUT / "benchmark.json").write_text(result, encoding="utf-8")
    print(result)
