import json
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

import pymupdf
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from pdf_layout import apply_pdf, inspect_pdf, source_font


class PdfLayoutTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="resumator-pdf-test-")
        self.directory = Path(self.temp.name)
        self.source = self.directory / "original.pdf"
        document = pymupdf.open()
        page = document.new_page(width=612, height=792)
        page.draw_rect(pymupdf.Rect(0, 0, 165, 792), fill=(0.12, 0.16, 0.23), color=None)
        page.draw_line((185, 70), (570, 70), color=(0.3, 0.4, 0.7), width=2)
        page.insert_text((185, 50), "CANDIDATE NAME", fontsize=20, fontname="hebo")
        page.insert_text((185, 100), "Engineer with 10+ years of experience.", fontsize=11)
        page.insert_text((185, 140), "Built reliable web applications.", fontsize=11)
        page.insert_text((185, 200), "Contact details remain unchanged.", fontsize=10)
        page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(185, 185, 370, 203), "uri": "https://example.com"})
        image = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8))
        image.clear_with(120)
        page.insert_image(pymupdf.Rect(35, 35, 95, 95), pixmap=image)
        document.save(self.source)
        document.close()
        self.blocks = inspect_pdf(str(self.source))["paragraphs"]

    def tearDown(self) -> None:
        self.temp.cleanup()

    def render(self, edits: list[dict[str, str]], allow: bool = True) -> tuple[dict, Path]:
        request = self.directory / "request.json"
        output = self.directory / "tailored.pdf"
        request.write_text(json.dumps({"edits": edits, "allowAdjustments": allow}))
        result = apply_pdf(str(self.source), str(request), str(output))
        return result, output

    def test_empty_edits_preserve_exact_pdf_bytes(self) -> None:
        result, output = self.render([])
        self.assertEqual(output.read_bytes(), self.source.read_bytes())
        self.assertEqual(result["issues"], [])

    def test_local_edit_preserves_graphics_images_links_and_every_pixel_outside_text_area(self) -> None:
        block = next(item for item in self.blocks if item["text"] == "Built reliable web applications.")
        result, output = self.render([{"id": block["id"], "text": "Built robust web applications."}])
        self.assertEqual(result["issues"], [])
        with pymupdf.open(self.source) as before, pymupdf.open(output) as after:
            self.assertEqual(after.page_count, before.page_count)
            self.assertEqual(after[0].rect, before[0].rect)
            self.assertIn("10+ years", after[0].get_text())
            self.assertIn("Built robust web applications.", after[0].get_text())
            self.assertNotIn("Built reliable", after[0].get_text())
            self.assertEqual(after[0].get_links()[0]["uri"], before[0].get_links()[0]["uri"])
            self.assertEqual(len(after[0].get_images()), len(before[0].get_images()))
            rect = before[0].search_for(block["text"])[0] + (-2, -2, 2, 2)
            original_pixels = before[0].get_pixmap(alpha=False)
            edited_pixels = after[0].get_pixmap(alpha=False)
            a, b = original_pixels.samples, edited_pixels.samples
            changed_pixels = 0
            for y in range(original_pixels.height):
                for x in range(original_pixels.width):
                    offset = (y * original_pixels.width + x) * 3
                    if a[offset:offset + 3] != b[offset:offset + 3]:
                        changed_pixels += 1
                        self.assertTrue(rect.contains(pymupdf.Point(x, y)), f"Unrelated pixel changed at {x},{y}")
            self.assertGreater(changed_pixels, 0)

    def test_overflow_is_blocked_and_preview_stays_original(self) -> None:
        block = next(item for item in self.blocks if item["text"].startswith("Built reliable"))
        result, output = self.render([{"id": block["id"], "text": "Long replacement wording " * 30}])
        self.assertIn("does not fit", result["issues"][0])
        self.assertEqual(output.read_bytes(), self.source.read_bytes())

    def test_missing_glyph_is_blocked_without_font_substitution(self) -> None:
        block = next(item for item in self.blocks if item["text"].startswith("Built reliable"))
        result, output = self.render([{"id": block["id"], "text": "Built 🚀 applications."}])
        self.assertIn("missing from the original font", result["issues"][0])
        self.assertEqual(output.read_bytes(), self.source.read_bytes())

    def test_hyperlinked_content_is_protected(self) -> None:
        block = next(item for item in self.blocks if item["text"].startswith("Contact details"))
        self.assertFalse(block["editable"])
        self.assertIn("link", block["protectedReason"])

    def test_mixed_font_content_has_independently_editable_regions_with_full_context(self) -> None:
        path = self.directory / "mixed.pdf"
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((50, 50), "Mixed", fontsize=12)
        page.insert_text((85, 50), "bold", fontsize=12, fontname="hebo")
        document.save(path)
        document.close()
        regions = inspect_pdf(str(path))["paragraphs"]
        self.assertEqual([region["text"] for region in regions], ["Mixed", "bold"])
        self.assertTrue(all(region["editable"] for region in regions))
        self.assertTrue(all(region["context"] == "Mixed bold" for region in regions))

    def test_inline_bold_keeps_style_and_flows_with_shorter_neighboring_text(self) -> None:
        path = self.directory / "emphasis.pdf"
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((50, 60), "Built ", fontsize=12)
        page.insert_text((80, 60), "reliable", fontsize=12, fontname="hebo")
        page.insert_text((125, 60), " web applications.", fontsize=12)
        document.save(path)
        document.close()
        regions = inspect_pdf(str(path))["paragraphs"]
        editable = next(region for region in regions if region["text"] == "Built")
        self.assertTrue(editable["editable"])
        request = self.directory / "inline.json"
        output = self.directory / "inline-result.pdf"
        request.write_text(json.dumps({"edits": [{"id": editable["id"], "text": "Led"}], "allowAdjustments": False}))
        result = apply_pdf(str(path), str(request), str(output))
        self.assertEqual(result["issues"], [])
        with pymupdf.open(path) as before, pymupdf.open(output) as after:
            bold_before = next(span for block in before[0].get_text("dict")["blocks"] for line in block.get("lines", []) for span in line["spans"] if span["text"] == "reliable")
            bold_after = next(span for block in after[0].get_text("dict")["blocks"] for line in block.get("lines", []) for span in line["spans"] if span["text"] == "reliable")
            for key in ("font", "size", "color", "flags", "text"):
                self.assertEqual(bold_after[key], bold_before[key])
            self.assertLess(bold_after["origin"][0], bold_before["origin"][0])
            self.assertEqual(bold_after["origin"][1], bold_before["origin"][1])
            rect = pymupdf.Rect(49, 45, 225, 65)
            pix_before, pix_after = before[0].get_pixmap(), after[0].get_pixmap()
            a, b = pix_before.samples, pix_after.samples
            for y in range(pix_before.height):
                for x in range(pix_before.width):
                    offset = (y * pix_before.width + x) * 3
                    if a[offset:offset + 3] != b[offset:offset + 3]:
                        self.assertTrue(rect.contains(pymupdf.Point(x, y)), f"Neighboring style changed at {x},{y}")

    def test_inline_link_label_underline_suffix_and_uri_move_together(self) -> None:
        for real_link, stroked in ((False, False), (True, False), (False, True), (True, True)):
            path = self.directory / f"inline-link-{real_link}.pdf"
            document = pymupdf.open()
            page = document.new_page()
            prefix = "Implemented a new global website with "
            x = 50 + pymupdf.get_text_length(prefix, fontsize=11)
            width = pymupdf.get_text_length("Spigit", fontsize=11)
            page.insert_text((50, 80), prefix, fontsize=11)
            page.insert_text((x, 80), "Spigit", fontsize=11, color=(0, 0, 1))
            if stroked:
                page.draw_line((x, 81), (x + width, 81), color=(0, 0, 1), width=0.7)
            else:
                page.draw_rect(pymupdf.Rect(x, 81, x + width, 81.7), color=None, fill=(0, 0, 1))
            page.insert_text((x + width, 80), " (platform).", fontsize=11)
            page.insert_text((50, 110), "Unrelated line stays identical.", fontsize=11)
            if real_link:
                page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(x + 0.1, 69, x + width - 0.1, 83), "uri": "https://example.com/platform"})
            document.save(path)
            document.close()
            regions = inspect_pdf(str(path))["paragraphs"]
            region = next(region for region in regions if region["text"].startswith("Implemented"))
            self.assertTrue(region["editable"])
            request = self.directory / "link-request.json"
            output = self.directory / "link-result.pdf"
            request.write_text(json.dumps({"edits": [{"id": region["id"], "text": "Built a website with"}], "allowAdjustments": False}))
            result = apply_pdf(str(path), str(request), str(output))
            self.assertEqual(result["issues"], [])
            with pymupdf.open(path) as before, pymupdf.open(output) as after:
                spans = [s for b in after[0].get_text("dict")["blocks"] for line in b.get("lines", []) for s in line["spans"]]
                label = next(s for s in spans if s["text"] == "Spigit")
                prefix_after = next(s for s in spans if s["text"].startswith("Built"))
                suffix = next(s for s in spans if s["text"].startswith(" (platform)"))
                self.assertAlmostEqual(label["origin"][0], prefix_after["bbox"][2], delta=0.1)
                self.assertAlmostEqual(suffix["origin"][0], label["bbox"][2], delta=0.1)
                self.assertEqual(label["color"], 255)
                self.assertLess(label["origin"][0], x - 60)
                underlines = [d for d in after[0].get_drawings() if d["rect"].height < 1]
                self.assertEqual(len(underlines), 1)
                self.assertAlmostEqual(underlines[0]["rect"].x0, label["origin"][0], delta=0.1)
                self.assertAlmostEqual(underlines[0]["rect"].width, width, delta=0.1)
                self.assertEqual(len(after[0].get_links()), int(real_link))
                if real_link:
                    link = after[0].get_links()[0]
                    self.assertEqual(link["uri"], "https://example.com/platform")
                    self.assertAlmostEqual(link["from"].x0, label["origin"][0] + 0.1, delta=0.1)
                pix_before, pix_after = before[0].get_pixmap(), after[0].get_pixmap()
                self.assertEqual(pix_before.samples[100 * pix_before.stride:], pix_after.samples[100 * pix_after.stride:])

    def test_multiple_inline_edits_accumulate_width_changes_without_losing_spacing(self) -> None:
        path = self.directory / "multiple-inline.pdf"
        document = pymupdf.open()
        page = document.new_page()
        x = 50.0
        for text, font, color in (
            ("Implemented ", "helv", (0, 0, 0)),
            ("reliable ", "hebo", (0, 0, 0)),
            ("web applications", "helv", (0, 0, 1)),
        ):
            page.insert_text((x, 80), text, fontname=font, fontsize=11, color=color)
            x += pymupdf.get_text_length(text, fontname=font, fontsize=11)
        document.save(path)
        document.close()
        regions = inspect_pdf(str(path))["paragraphs"]
        edits = [{"id": region["id"], "text": replacement} for region, replacement in zip(regions, ["Built", "robust"])]
        request = self.directory / "multiple-inline.json"
        output = self.directory / "multiple-inline-result.pdf"
        request.write_text(json.dumps({"edits": edits, "allowAdjustments": False}))
        result = apply_pdf(str(path), str(request), str(output))
        self.assertEqual(result["issues"], [])
        with pymupdf.open(output) as document:
            spans = [span for block in document[0].get_text("dict")["blocks"] for line in block.get("lines", []) for span in line["spans"]]
            spans.sort(key=lambda span: span["origin"][0])
            self.assertEqual("".join(span["text"] for span in spans), "Built robust web applications")
            self.assertTrue("Bold" in spans[1]["font"])
            self.assertEqual(spans[2]["color"], 255)
            for previous, following in zip(spans, spans[1:]):
                self.assertAlmostEqual(previous["bbox"][2], following["origin"][0], delta=0.1)

    def test_bold_heading_does_not_lock_multiline_body_in_the_same_block(self) -> None:
        path = self.directory / "heading-body.pdf"
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((50, 60), "EXPERIENCE", fontsize=12, fontname="hebo")
        page.insert_text((50, 75), "Built reliable web applications.", fontsize=11)
        page.insert_text((50, 89), "Led product delivery teams.", fontsize=11)
        document.save(path)
        document.close()
        regions = inspect_pdf(str(path))["paragraphs"]
        self.assertEqual(len(regions), 2)
        body = regions[1]
        self.assertEqual(body["text"], "Built reliable web applications. Led product delivery teams.")
        self.assertTrue(body["editable"])
        request = self.directory / "body.json"
        output = self.directory / "body-result.pdf"
        request.write_text(json.dumps({
            "edits": [{"id": body["id"], "text": "Built robust web applications. Led product delivery teams."}],
            "allowAdjustments": False,
        }))
        self.assertEqual(apply_pdf(str(path), str(request), str(output))["issues"], [])
        with pymupdf.open(path) as before, pymupdf.open(output) as after:
            self.assertEqual(before[0].search_for("EXPERIENCE"), after[0].search_for("EXPERIENCE"))
            self.assertIn("Built robust", after[0].get_text())

    def test_longer_inline_replacement_is_blocked_instead_of_covering_bold_neighbor(self) -> None:
        path = self.directory / "inline-overflow.pdf"
        document = pymupdf.open()
        page = document.new_page()
        page.insert_text((50, 60), "Built ", fontsize=12)
        page.insert_text((80, 60), "reliable", fontsize=12, fontname="hebo")
        document.save(path)
        document.close()
        region = inspect_pdf(str(path))["paragraphs"][0]
        request = self.directory / "inline-overflow.json"
        output = self.directory / "inline-overflow-result.pdf"
        request.write_text(json.dumps({"edits": [{"id": region["id"], "text": "Architected"}], "allowAdjustments": True}))
        self.assertTrue(apply_pdf(str(path), str(request), str(output))["issues"])
        self.assertEqual(path.read_bytes(), output.read_bytes())

    def test_custom_encoded_true_type_subsets_restore_unicode_without_substituting_fonts(self) -> None:
        path = self.directory / "custom-subsets.pdf"
        document = pymupdf.open()
        page = document.new_page()
        resources = []
        for index, order in enumerate([["a", "b", "c", "space"], ["c", "a", "space", "b"]]):
            names = [".notdef", *order]
            builder = FontBuilder(1000, isTTF=True)
            builder.setupGlyphOrder(names)
            builder.setupCharacterMap({ord(char) if char != "space" else 32: char for char in order})
            outlines = {}
            for name in names:
                pen = TTGlyphPen(None)
                if name != "space":
                    pen.moveTo((50, 0))
                    pen.lineTo((200 + (ord(name[0]) % 3) * 100, 0))
                    pen.lineTo((200, 650))
                    pen.closePath()
                outlines[name] = pen.glyph()
            builder.setupGlyf(outlines)
            builder.setupHorizontalMetrics({name: (600, 0) for name in names})
            builder.setupHorizontalHeader(ascent=800, descent=-200)
            builder.setupNameTable({"familyName": "SyntheticSubset", "styleName": "Regular", "uniqueFontIdentifier": f"subset{index}", "fullName": "SyntheticSubset", "psName": "SyntheticSubset"})
            builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
            builder.setupPost()
            mac = CmapSubtable.newSubtable(6)
            mac.platformID, mac.platEncID, mac.language = 1, 0, 0
            mac.cmap = {33 + offset: name for offset, name in enumerate(order)}
            cmap = newTable("cmap")
            cmap.tableVersion, cmap.tables = 0, [mac]
            builder.font["cmap"] = cmap
            buffer = BytesIO()
            builder.font.save(buffer)
            font_file = document.get_new_xref()
            document.update_object(font_file, "<<>>")
            document.update_stream(font_file, buffer.getvalue())
            descriptor = document.get_new_xref()
            document.update_object(descriptor, f"<< /Type /FontDescriptor /FontName /SyntheticSubset /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 650 /StemV 80 /FontFile2 {font_file} 0 R >>")
            to_unicode = document.get_new_xref()
            document.update_object(to_unicode, "<<>>")
            entries = " ".join(f"<{33 + offset:02X}><{32 if name == 'space' else ord(name):04X}>" for offset, name in enumerate(order))
            document.update_stream(to_unicode, f"begincmap 1 begincodespacerange <00><FF> endcodespacerange 4 beginbfchar {entries} endbfchar endcmap".encode())
            font_xref = document.get_new_xref()
            document.update_object(font_xref, f"<< /Type /Font /Subtype /TrueType /BaseFont /SyntheticSubset /FirstChar 33 /LastChar 36 /Widths [600 600 600 600] /FontDescriptor {descriptor} 0 R /ToUnicode {to_unicode} 0 R >>")
            resources.append((font_xref, order))
        document.xref_set_key(page.xref, "Resources", f"<< /Font << /F0 {resources[0][0]} 0 R /F1 {resources[1][0]} 0 R >> >>")
        stream = document.get_new_xref()
        document.update_object(stream, "<<>>")
        content = []
        for index, (_, order) in enumerate(resources):
            encoding = {name if name != "space" else " ": 33 + offset for offset, name in enumerate(order)}
            encoded = "".join(f"{encoding[char]:02X}" for char in "cab cab")
            content.append(f"BT /F{index} 12 Tf 0.98 0 0 1 50 {750 - index * 40} Tm <{encoded}> Tj ET")
        document.update_stream(stream, "\n".join(content).encode())
        document.xref_set_key(page.xref, "Contents", f"{stream} 0 R")
        document.save(path)
        document.close()
        regions = inspect_pdf(str(path))["paragraphs"]
        self.assertEqual([item["text"] for item in regions], ["cab cab", "cab cab"])
        self.assertTrue(all(item["editable"] for item in regions))
        with pymupdf.open(path) as original:
            font = source_font(original, original[0], "SyntheticSubset")
            self.assertTrue(font.has_glyph(ord("a")))
        request = self.directory / "subset-request.json"
        output = self.directory / "subset-result.pdf"
        request.write_text(json.dumps({"edits": [{"id": regions[0]["id"], "text": "bac cab"}], "allowAdjustments": False}))
        self.assertEqual(apply_pdf(str(path), str(request), str(output))["issues"], [])
        with pymupdf.open(output) as edited:
            text = edited[0].get_text().replace("\u00a0", " ")
            self.assertIn("bac cab", text)
            self.assertIn("cab cab", text)


if __name__ == "__main__":
    unittest.main()
