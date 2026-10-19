"""Conservative text-only PDF edits inside the original text block geometry."""

import json
import re
import sys
from io import BytesIO
from pathlib import Path
from typing import Any

import pymupdf
from fontTools.ttLib import TTFont, TTLibError, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

def font_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.split("+")[-1].lower())


def unicode_glyphs(document: pymupdf.Document, xref: int, data: bytes) -> dict[int, int]:
    kind, target = document.xref_get_key(xref, "ToUnicode")
    _, descendants = document.xref_get_key(xref, "DescendantFonts")
    descendant = re.search(r"(\d+)\s+0\s+R", descendants)
    if kind != "xref":
        return {}
    cmap = document.xref_stream(int(target.split()[0])).decode("latin1")
    codes: dict[int, str] = {}
    for body in re.findall(r"beginbfchar(.*?)endbfchar", cmap, re.S):
        for cid, value in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", body):
            codes[int(cid, 16)] = value
    for body in re.findall(r"beginbfrange(.*?)endbfrange", cmap, re.S):
        for start, end, values in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", body):
            first, last = int(start, 16), int(end, 16)
            if last - first > 65535:
                raise ValueError("The PDF font character map exceeds the supported range.")
            if values.startswith("["):
                for cid, value in zip(range(first, last + 1), re.findall(r"<([0-9A-Fa-f]+)>", values)):
                    codes[cid] = value
            else:
                value = values[1:-1]
                for cid in range(first, last + 1):
                    codes[cid] = f"{int(value, 16) + cid - first:0{len(value)}X}"
    simple_map: dict[int, int] | None = None
    gid_map = None
    if descendant:
        map_kind, map_target = document.xref_get_key(int(descendant.group(1)), "CIDToGIDMap")
        gid_map = document.xref_stream(int(map_target.split()[0])) if map_kind == "xref" else None
        if gid_map is None and map_target not in ("/Identity", "null"):
            return {}
    else:
        try:
            font = TTFont(BytesIO(data))
            _, encoding = document.xref_get_key(xref, "Encoding")
            tables = [table for table in font["cmap"].tables if table.platformID == 1 and table.platEncID == 0]
            if encoding not in ("null", "/MacRomanEncoding") or not tables:
                return {}
            simple_map = {code: font.getGlyphID(name) for code, name in tables[0].cmap.items()}
        except (TTLibError, KeyError):
            return {}
    result: dict[int, int] = {}
    for cid, encoded in codes.items():
        try:
            text = bytes.fromhex(encoded).decode("utf-16-be")
        except (ValueError, UnicodeDecodeError):
            continue
        if len(text) != 1:
            continue
        if simple_map is not None:
            if cid not in simple_map:
                continue
            gid = simple_map[cid]
        elif gid_map is not None:
            if cid * 2 + 2 > len(gid_map):
                continue
            gid = int.from_bytes(gid_map[cid * 2:cid * 2 + 2], "big")
        else:
            gid = cid
        result[ord(text)] = gid
    return result


def mapped_font(document: pymupdf.Document, xref: int, data: bytes) -> pymupdf.Font | None:
    try:
        original = pymupdf.Font(fontbuffer=data)
    except RuntimeError:
        return None
    glyphs = unicode_glyphs(document, xref, data)
    if not glyphs or all(original.has_glyph(codepoint) == glyph for codepoint, glyph in glyphs.items()):
        return original
    # PDF ToUnicode mappings can exist even when an embedded subset's font cmap is empty.
    # Use this font resource's own ToUnicode/CIDToGIDMap, not another subset with the same family name.
    try:
        font = TTFont(BytesIO(data))
        names = font.getGlyphOrder()
        if any(glyph >= len(names) for glyph in glyphs.values()):
            return None
        mapping = dict(font.getBestCmap() or {})
        mapping.update({codepoint: names[glyph] for codepoint, glyph in glyphs.items()})
        cmap = newTable("cmap")
        cmap.tableVersion = 0
        table = CmapSubtable.newSubtable(12)
        table.platformID = 3
        table.platEncID = 10
        table.language = 0
        table.cmap = mapping
        cmap.tables = [table]
        font["cmap"] = cmap
        buffer = BytesIO()
        font.save(buffer)
        return pymupdf.Font(fontbuffer=buffer.getvalue())
    except (TTLibError, ValueError, KeyError, RuntimeError):
        return None


BASE_FONT_NAMES = {
    "helvetica": "helv", "helveticabold": "hebo",
    "helveticaoblique": "heit", "helveticaboldoblique": "hebi",
    "timesroman": "tiro", "timesbold": "tibo",
    "timesitalic": "tiit", "timesbolditalic": "tibi",
    "courier": "cour", "courierbold": "cobo",
}


def source_font(document: pymupdf.Document, page: pymupdf.Page, name: str, spans: list[dict[str, Any]] | None = None) -> pymupdf.Font | None:
    for item in page.get_fonts(full=True):
        if font_key(item[3]) != font_key(name):
            continue
        if item[0]:
            _, _, _, data = document.extract_font(item[0])
            if data:
                font = mapped_font(document, item[0], data)
                if font and (spans is None or all(
                    all(font.has_glyph(ord(char)) for char in span["text"] if not char.isspace())
                    and 0.75 <= (span["bbox"][2] - span["bbox"][0]) / max(font.text_length(span["text"], fontsize=span["size"]), 0.001) <= 1.25
                    for span in spans
                )):
                    return font
                continue
        base = BASE_FONT_NAMES.get(font_key(name))
        if base:
            return pymupdf.Font(base)
    return None


def style_key(span: dict[str, Any]) -> tuple[str, float, int]:
    return span["font"], round(span["size"], 3), span["color"]


def insert_original_font(page: pymupdf.Page, font: pymupdf.Font, original_name: str, resource_name: str) -> str:
    base = BASE_FONT_NAMES.get(font_key(original_name))
    if base and font.buffer == pymupdf.Font(base).buffer:
        page.insert_font(fontname=base)
        return base
    page.insert_font(fontname=resource_name, fontbuffer=font.buffer)
    return resource_name


def removal_area(span: dict[str, Any]) -> pymupdf.Rect:
    # A narrow band intersects this run's character boxes without catching the next line's ascenders.
    return pymupdf.Rect(
        span["bbox"][0] + 0.05, span["origin"][1] - span["size"] * 0.4,
        span["bbox"][2] - 0.05, span["origin"][1] - span["size"] * 0.3,
    )


def text_regions(block: dict[str, Any]) -> list[dict[str, Any]]:
    spans = [span for line in block["lines"] for span in line["spans"] if span["text"].strip()]
    if len({style_key(span) for span in spans}) <= 1:
        return [block]
    regions: list[dict[str, Any]] = []
    for line in block["lines"]:
        groups: list[list[dict[str, Any]]] = []
        for span in line["spans"]:
            if groups and style_key(groups[-1][-1]) == style_key(span):
                groups[-1].append(span)
            else:
                groups.append([span])
        for group in groups:
            if not any(span["text"].strip() for span in group):
                continue
            bounds = pymupdf.Rect(group[0]["bbox"])
            for span in group[1:]:
                bounds |= pymupdf.Rect(span["bbox"])
            region_line = {**line, "spans": group, "bbox": tuple(bounds)}
            previous = regions[-1] if regions else None
            # Only merge complete, aligned lines of the same style, never across an inline emphasis boundary.
            if (
                len(groups) == 1 and previous and previous["whole_lines"]
                and style_key(previous["lines"][0]["spans"][0]) == style_key(group[0])
                and abs(previous["lines"][0]["bbox"][0] - bounds.x0) < 1
                and tuple(previous["lines"][-1]["dir"]) == tuple(line["dir"])
            ):
                previous["lines"].append(region_line)
                previous["bbox"] = tuple(pymupdf.Rect(previous["bbox"]) | bounds)
            else:
                regions.append({"lines": [region_line], "bbox": tuple(bounds), "whole_lines": len(groups) == 1})
    return regions


def blocks(document: pymupdf.Document) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for page in document:
        fonts: dict[tuple[str, str], pymupdf.Font | None] = {}
        links = [pymupdf.Rect(link["from"]) for link in page.get_links()]
        page_blocks = [block for block in page.get_text("dict", sort=True)["blocks"] if block["type"] == 0]
        for parent in page_blocks:
            context = " ".join("".join(span["text"] for span in line["spans"]).strip() for line in parent["lines"]).strip()
            regions = text_regions(parent)
            for block in regions:
                lines = block["lines"]
                spans = [span for line in lines for span in line["spans"] if span["text"].strip()]
                if not spans:
                    continue
                text = " ".join("".join(span["text"] for span in line["spans"]).strip() for line in lines).strip()
                if not text:
                    continue
                span_ids = {id(span) for span in spans}
                reason: str | None = None
                if any(tuple(line["dir"]) != (1.0, 0.0) for line in lines) or page.rotation:
                    reason = "Rotated text: protected to preserve its placement."
                elif any(pymupdf.Rect(span["bbox"]).intersects(link) for span in spans for link in links):
                    reason = "Contains a link: protected to keep its original target and placement."
                elif any(
                    removal_area(span).intersects(pymupdf.Rect(other_span["bbox"]))
                    for span in spans for other in page_blocks for other_line in other["lines"]
                    for other_span in other_line["spans"] if id(other_span) not in span_ids
                ):
                    reason = "Overlapping text areas: protected to prevent removing neighboring content."
                else:
                    name = spans[0]["font"]
                    key = name, text
                    if key not in fonts:
                        fonts[key] = source_font(document, page, name, spans)
                    font = fonts[key]
                    if font is None:
                        reason = "The original font cannot be reused without substitution."
                result.append({
                    "id": f"p{len(result)}", "text": text, "editable": reason is None,
                    **({"context": context} if len(regions) > 1 else {}),
                    **({"protectedReason": reason} if reason else {}),
                    "page": page.number, "block": block, "spans": spans, "parent": parent,
                })
    return result


def inspect_pdf(path: str) -> dict[str, Any]:
    with pymupdf.open(path) as document:
        if document.is_encrypted:
            raise ValueError("Encrypted PDFs must be unlocked before upload.")
        if len(document) > 5:
            raise ValueError("Upload a resume of five pages or fewer.")
        paragraphs = [
            {key: value for key, value in block.items() if key in ("id", "text", "editable", "protectedReason", "context")}
            for block in blocks(document)
        ]
        if not paragraphs:
            raise ValueError("No editable text was found. Scanned resumes require OCR before upload.")
        if len(paragraphs) > 500 or sum(len(item["text"]) for item in paragraphs) > 60_000:
            raise ValueError("The resume exceeds 500 paragraphs or 60,000 characters.")
        return {"pages": len(document), "paragraphs": paragraphs}


def wrap_text(text: str, font: pymupdf.Font, size: float, widths: list[float]) -> list[str] | None:
    lines: list[str] = []
    current = ""
    for word in text.split():
        if len(lines) >= len(widths):
            return None
        width = widths[len(lines)]
        candidate = f"{current} {word}".strip()
        if font.text_length(candidate, fontsize=size) <= width + 0.05:
            current = candidate
        else:
            if not current:
                return None
            lines.append(current)
            if len(lines) >= len(widths) or font.text_length(word, fontsize=size) > widths[len(lines)] + 0.05:
                return None
            current = word
    if current:
        lines.append(current)
    return lines


def apply_pdf(source: str, request_path: str, output: str) -> dict[str, Any]:
    request = json.loads(Path(request_path).read_text())
    with pymupdf.open(source) as document:
        original = {item["id"]: item for item in blocks(document)}
        plans: list[dict[str, Any]] = []
        issues: list[str] = []
        minimum_scale = 1.0
        for edit in request["edits"]:
            item = original.get(edit["id"])
            if item is None:
                raise ValueError("An edit references an unknown PDF text block.")
            if not item["editable"]:
                raise ValueError(f"{item['id']}: this block's original formatting is protected.")
            if " ".join(edit["text"].split()) == " ".join(item["text"].split()):
                continue
            page = document[item["page"]]
            span = item["spans"][0]
            font = source_font(document, page, span["font"], item["spans"])
            missing = sorted({ord(char) for char in edit["text"] if not char.isspace() and font and not font.has_glyph(ord(char))})
            if font is None or missing:
                characters = ", ".join(f"U+{code:04X}" for code in missing)
                issues.append(f"{item['id']}: replacement needs glyphs missing from the original font ({characters}). Reword without changing the font.")
                continue
            lines = item["block"]["lines"]
            widths = [line["bbox"][2] - line["spans"][0]["origin"][0] for line in lines]
            horizontal_scales = [
                width / max(font.text_length("".join(s["text"] for s in line["spans"]), fontsize=span["size"]), 0.001)
                for line, width in zip(lines, widths)
            ]
            wrapped = None
            scale = 1.0
            for candidate_scale in ([1.0, 0.97, 0.94] if request["allowAdjustments"] else [1.0]):
                size = max(min(9.0, span["size"]), span["size"] * candidate_scale)
                candidate = wrap_text(edit["text"], font, size, [width / horizontal for width, horizontal in zip(widths, horizontal_scales)])
                if candidate and len(candidate) <= len(lines):
                    wrapped = candidate
                    scale = size / span["size"]
                    break
            if wrapped is None:
                issues.append(f"{item['id']}: text does not fit its original area. Shorten this change; the template will not be rebuilt.")
                continue
            minimum_scale = min(minimum_scale, scale)
            plans.append({"item": item, "font": font, "lines": wrapped, "scale": scale, "horizontal_scales": horizontal_scales})

        moved: list[dict[str, Any]] = []
        shifted_links: list[tuple[int, dict[str, Any]]] = []
        edited_spans = {id(span) for plan in plans for span in plan["item"]["spans"]}
        for plan in plans:
            item = plan["item"]
            plan["offset"] = 0.0
            if len(item["block"]["lines"]) != 1:
                continue
            line = item["block"]["lines"][0]
            start = line["spans"][0]["origin"][0]
            end = line["bbox"][2]
            baseline = line["spans"][0]["origin"][1]
            trailing = item["spans"][-1]["text"]
            trailing = trailing[len(trailing.rstrip()):]
            plan["rendered_text"] = plan["lines"][0] + trailing
            width = plan["font"].text_length(plan["rendered_text"], fontsize=item["spans"][0]["size"] * plan["scale"])
            plan["delta"] = start + width * plan["horizontal_scales"][0] - end
            plan["baseline"] = baseline
        for plan in plans:
            item = plan["item"]
            if "delta" not in plan:
                continue
            start = item["spans"][0]["origin"][0]
            prior = [other for other in plans if other is not plan and "delta" in other
                     and other["item"]["page"] == item["page"]
                     and other["item"]["parent"] is item["parent"]
                     and abs(other["baseline"] - plan["baseline"]) < 0.1
                     and other["item"]["block"]["bbox"][2] <= start + 0.1]
            plan["offset"] = sum(other["delta"] for other in prior)
        for page_number in {plan["item"]["page"] for plan in plans}:
            page = document[page_number]
            page_plans = [plan for plan in plans if plan["item"]["page"] == page_number and "delta" in plan]
            seen: set[int] = set()
            for plan in page_plans:
                for line in plan["item"]["parent"]["lines"]:
                    for span in line["spans"]:
                        if id(span) in edited_spans or id(span) in seen:
                            continue
                        offset = sum(other["delta"] for other in page_plans
                                     if other["item"]["parent"] is plan["item"]["parent"]
                                     and abs(other["baseline"] - span["origin"][1]) < 0.1
                                     and other["item"]["block"]["bbox"][2] <= span["origin"][0] + 0.1)
                        if abs(offset) < 0.05:
                            continue
                        seen.add(id(span))
                        font = source_font(document, page, span["font"], [span])
                        if font is None:
                            issues.append("An inline style cannot be moved using its original font. Keep this sentence unchanged.")
                            continue
                        moved.append({"page": page_number, "span": span, "offset": offset, "font": font})
            for link in page.get_links():
                touching = [move for move in moved if move["page"] == page_number
                            and pymupdf.Rect(move["span"]["bbox"]).intersects(link["from"])]
                if touching:
                    offsets = {round(move["offset"], 4) for move in touching}
                    if len(offsets) != 1:
                        issues.append("An inline link spans text moving by different amounts. Keep this sentence unchanged.")
                    else:
                        offset = touching[0]["offset"]
                        shifted_links.append((page_number, {key: value for key, value in link.items() if key not in ("xref", "id")} |
                                              {"from": link["from"] + (offset, 0, offset, 0)}))

        # Do not publish a misleading partial preview when any edit cannot be placed.
        if issues:
            Path(output).write_bytes(Path(source).read_bytes())
            return {"pages": len(document), "scale": 1, "issues": issues}
        if not plans:
            Path(output).write_bytes(Path(source).read_bytes())
            return {"pages": len(document), "scale": 1, "issues": []}

        underlines: list[dict[str, Any]] = []
        for move in moved:
            page = document[move["page"]]
            clip = pymupdf.Rect(move["span"]["bbox"]) + (-0.2, 0, 0.2, 1)
            drawings = page.get_drawings()
            for drawing in drawings:
                bounds = drawing["rect"]
                if bounds.width > 0 and bounds.height <= 1.5 and clip.contains(bounds):
                    if len(drawing["items"]) != 1 or drawing["items"][0][0] not in ("re", "l"):
                        issues.append("An inline decoration cannot be moved safely. Keep this sentence unchanged.")
                        continue
                    # Stroked path bounds include the PDF default miter limit, not just the centerline.
                    padding = max(0.05, (drawing["width"] or 0) * 5 + 0.05)
                    redaction = bounds + (-padding, -padding, padding, padding)
                    if any(other["seqno"] != drawing["seqno"] and redaction.contains(other["rect"]) for other in drawings):
                        issues.append("An inline underline overlaps another decoration. Keep this sentence unchanged.")
                        continue
                    underlines.append({"page": move["page"], "drawing": drawing, "offset": move["offset"]})
                    page.add_redact_annot(redaction, fill=False, cross_out=False)
        if issues:
            Path(output).write_bytes(Path(source).read_bytes())
            return {"pages": len(document), "scale": 1, "issues": issues}
        for page_number in {move["page"] for move in moved}:
            document[page_number].apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                text=pymupdf.PDF_REDACT_TEXT_NONE,
            )
        for move in moved:
            document[move["page"]].add_redact_annot(removal_area(move["span"]), fill=False, cross_out=False)
        for plan in plans:
            item = plan["item"]
            page = document[item["page"]]
            for span in item["spans"]:
                page.add_redact_annot(removal_area(span), fill=False, cross_out=False)
        for page_number in {plan["item"]["page"] for plan in plans}:
            document[page_number].apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                text=pymupdf.PDF_REDACT_TEXT_REMOVE,
            )
        for index, move in enumerate(moved):
            page = document[move["page"]]
            span, font = move["span"], move["font"]
            name = insert_original_font(page, font, span["font"], f"resumatorInline{index}")
            origin = pymupdf.Point(span["origin"][0] + move["offset"], span["origin"][1])
            width = span["bbox"][2] - span["origin"][0]
            horizontal = width / max(font.text_length(span["text"], fontsize=span["size"]), 0.001)
            color = tuple(((span["color"] >> shift) & 255) / 255 for shift in (16, 8, 0))
            page.insert_text(origin, span["text"], fontname=name, fontsize=span["size"], color=color,
                             morph=(origin, pymupdf.Matrix(horizontal, 1)))
        for underline in underlines:
            drawing, offset = underline["drawing"], underline["offset"]
            page = document[underline["page"]]
            options = {"color": drawing["color"], "fill": drawing["fill"], "width": drawing["width"] or 0,
                       "fill_opacity": drawing["fill_opacity"] if drawing["fill_opacity"] is not None else 1,
                       "stroke_opacity": drawing["stroke_opacity"] if drawing["stroke_opacity"] is not None else 1}
            if drawing["items"][0][0] == "re":
                page.draw_rect(drawing["items"][0][1] + (offset, 0, offset, 0), **options)
            else:
                _, start, end = drawing["items"][0]
                page.draw_line(start + (offset, 0), end + (offset, 0),
                               color=drawing["color"], width=drawing["width"], stroke_opacity=drawing["stroke_opacity"],
                               lineCap=max(drawing["lineCap"]), lineJoin=drawing["lineJoin"], dashes=drawing["dashes"])
        for page_number, link in shifted_links:
            document[page_number].insert_link(link)
        for index, plan in enumerate(plans):
            item = plan["item"]
            page = document[item["page"]]
            font = plan["font"]
            span = item["spans"][0]
            font_name = insert_original_font(page, font, span["font"], f"resumator{index}")
            color = tuple(((span["color"] >> shift) & 255) / 255 for shift in (16, 8, 0))
            for line_index, text in enumerate(plan["lines"]):
                origin = item["block"]["lines"][line_index]["spans"][0]["origin"]
                origin = (origin[0] + plan["offset"], origin[1])
                page.insert_text(
                    origin, plan.get("rendered_text", text), fontname=font_name,
                    fontsize=span["size"] * plan["scale"], color=color,
                    morph=(pymupdf.Point(origin), pymupdf.Matrix(plan["horizontal_scales"][line_index], 1)),
                )
        document.save(output, garbage=4, deflate=True)
        return {"pages": len(document), "scale": minimum_scale, "issues": []}


def main() -> None:
    try:
        if sys.argv[1] == "inspect":
            result = inspect_pdf(sys.argv[2])
        else:
            result = apply_pdf(sys.argv[2], sys.argv[3], sys.argv[4])
        print(json.dumps(result))
    except (ValueError, RuntimeError, pymupdf.FileDataError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
