#!/usr/bin/env python3
"""Generate synthetic "scanned document" test fixtures for the OCR stage of the
document-intelligence pipeline (src/processing/extract, PaddleOCR sidecar).

These are RASTER images (and a PDF built from one) with no embedded text layer,
so they exercise the real OCR path end to end:
  - the .png is uploaded directly            -> extraction_method = ocr_paddle
  - the .pdf has zero native text             -> pdf-parse finds ~0 chars/page,
                                                  processor falls back to OCR too

Requires only Pillow (`pip install pillow`) - no reportlab/imagemagick needed.

Usage:
    python3 scripts/generate-ocr-samples.py [output_dir]
Default output_dir: test/fixtures/document-intelligence/
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TEXT_LINES = [
    "FIR No. 102/2026",
    "Police Station: MG Road, Pune",
    "Date: 12/03/2026",
    "",
    "On 12/03/2026, SI Rao arrested Amit Kumar near MG Road, Pune",
    "in connection with FIR-102, vehicle MH-12-AB-1234, under IPC S420.",
    "Contact: si.rao@police.gov.in  Phone: +91 98765 43210",
    "Seized cash: Rs. 5,00,000. Bail was denied; sent to judicial custody.",
]

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "C:/Windows/Fonts/arial.ttf",
]


def load_font(size=28):
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    print("warning: no truetype font found, falling back to PIL's tiny bitmap font")
    return ImageFont.load_default()


def make_image():
    width, height = 1240, 1754  # ~A4 at 150dpi
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    font = load_font(30)
    y = 80
    for line in TEXT_LINES:
        draw.text((70, y), line, fill="black", font=font)
        y += 55
    return img


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test/fixtures/document-intelligence")
    out_dir.mkdir(parents=True, exist_ok=True)

    img = make_image()

    png_path = out_dir / "scanned-sample.png"
    img.save(png_path)
    print(f"wrote {png_path}  (upload as image/png -> forces PaddleOCR)")

    pdf_path = out_dir / "scanned-sample.pdf"
    img.save(pdf_path, "PDF", resolution=150.0)
    print(f"wrote {pdf_path}  (rasterized PDF, ~0 native text -> triggers OCR fallback)")


if __name__ == "__main__":
    main()
