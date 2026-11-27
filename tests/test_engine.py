from io import BytesIO
import json
from pathlib import Path
import unittest
from zipfile import ZipFile

import numpy as np
from PIL import Image

from engine import decode, detect, extract, png, render
from studio import describe, exported
import neural


ROOT = Path(__file__).resolve().parents[1]


def sample(number):
    return decode((ROOT / "test-assets" / f"{number}.jpg").read_bytes())


class EngineTests(unittest.TestCase):
    def test_real_sheets_produce_native_resolution_masks(self):
        for number, minimum in [(1, 10), (2, 14), (3, 36)]:
            with self.subTest(number=number):
                source = sample(number)
                regions, background, status = detect(source)
                self.assertEqual(status, "ready")
                self.assertGreaterEqual(len(regions), minimum)
                self.assertIsNotNone(background)
                for region in regions:
                    x, y, width, height = region.box
                    result = render(source, region.box, region.alpha)
                    self.assertEqual(result.shape, (height, width, 4))
                    self.assertTrue(np.array_equal(result[:, :, :3], source[y:y+height, x:x+width, :3]))
                    self.assertTrue(np.array_equal(result[:, :, 3], region.alpha))
                mask = np.concatenate([region.alpha.ravel() for region in regions])
                self.assertTrue(np.any((mask > 0) & (mask < 255)))
                self.assertTrue(np.any(mask == 0))

    def test_transparent_pixel_assets_keep_native_alpha(self):
        source = sample(1)[:15, :21].copy()
        source[:, :, 3] = 0
        source[5, 5, 3] = 91
        source[5, 7, 3] = 192
        regions, background, _ = detect(source)
        self.assertIsNone(background)
        self.assertEqual([r.box for r in regions], [(5, 5, 1, 1), (7, 5, 1, 1)])
        self.assertEqual([int(r.alpha[0, 0]) for r in regions], [91, 192])

    def test_white_fringe_cleanup_preserves_interior_of_real_assets(self):
        source = sample(1)
        regions, background, _ = detect(source)
        for top, bottom in [(0, 40), (80, 120)]:
            asset = next(region for region in regions if region.box[0] > 580 and top <= region.box[1] < bottom)
            clean = render(source, asset.box, asset.alpha, background, True)
            base = render(source, asset.box, asset.alpha)
            self.assertTrue(np.all(clean[:, :, 3] <= base[:, :, 3]))
            self.assertGreater(np.count_nonzero((base[:, :, 3] == 255) & (clean[:, :, 3] < 255)), 30)
            if top:
                self.assertTrue(np.array_equal(clean[25:-25, 25:-25], base[25:-25, 25:-25]))

    def test_lantern_openings_are_cleaned_and_glass_is_preserved(self):
        source = sample(1)
        regions, background, _ = detect(source)
        lantern = next(region for region in regions if region.box[0] < 50 and region.box[1] < 55)
        raw = render(source, lantern.box, lantern.alpha, background)
        clean = render(source, lantern.box, lantern.alpha, background, True)
        # Both of the handle openings have an interior fringe, away from the outer silhouette.
        for x0, x1 in [(18, 44), (87, 118)]:
            change = raw[54:167, x0:x1, 3] > clean[54:167, x0:x1, 3]
            self.assertGreater(np.count_nonzero(change), 100)
        self.assertTrue(np.array_equal(clean[83:141, 50:84], raw[83:141, 50:84]))

    def test_box_segment_and_cooperative_cancel(self):
        source = sample(2)
        box = (13, 180, 90, 114)
        crop, _ = extract(source, box, "box")
        matte, _ = extract(source, box, "segment")
        self.assertTrue((crop.alpha == 255).all())
        self.assertEqual(matte.box, box)
        self.assertGreater(np.count_nonzero(matte.alpha), 500)
        self.assertGreater(np.count_nonzero(matte.alpha == 0), 500)

        def cancelled():
            raise InterruptedError()
        with self.assertRaises(InterruptedError):
            detect(source, checkpoint=cancelled)

    def test_bundle_paths_and_manifest(self):
        raw = (ROOT / "test-assets" / "2.jpg").read_bytes()
        assets, bg, _ = detect(decode(raw))
        config = {"source": "2.jpg", "format": "zip", "assets": [
            {**describe(region, bg), "name": "../素材"} for region in assets[:2]
        ]}
        data = json.dumps(config).encode()
        result, media = exported(len(data).to_bytes(4, "big") + data + raw, lambda: None)
        self.assertEqual(media, "application/zip")
        with ZipFile(BytesIO(result)) as bundle:
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual((manifest["width"], manifest["height"]), (600, 372))
            self.assertEqual(len(set(bundle.namelist())), 3)
            for item, region in zip(manifest["assets"], assets):
                self.assertNotIn("/", item["file"])
                with Image.open(BytesIO(bundle.read(item["file"]))) as image:
                    self.assertEqual(image.mode, "RGBA")
                    self.assertEqual(image.size, (item["width"], item["height"]))
                    self.assertTrue(np.array_equal(np.asarray(image)[:, :, 3], region.alpha))

    @unittest.skipUnless(neural.available(), "MobileSAM optional weights not installed")
    def test_real_model_box_and_automatic_proposals(self):
        source = sample(2)
        result = neural.box_mask(source, (13, 180, 90, 114), lambda: None)
        self.assertGreater(np.count_nonzero(result.alpha), 500)
        self.assertGreater(np.count_nonzero(result.alpha == 0), 500)
        regions = neural.propose(source, 25, lambda: None)
        self.assertGreaterEqual(len(regions), 2)

    def test_lossless_native_png_and_transparent_source(self):
        source = sample(1)[45:84, 30:90].copy()
        source[0, 0, 3] = 117
        raw = png(source)
        crop, _ = extract(decode(raw), (0, 0, 60, 39), "box")
        self.assertTrue(np.array_equal(render(source, crop.box, crop.alpha), source))


if __name__ == "__main__":
    unittest.main()
