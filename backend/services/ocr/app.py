"""PaddleOCR HTTP sidecar.

One endpoint the Node worker calls: POST /ocr with a single file (image or PDF).
Returns the concatenated text, a mean confidence in [0, 1], and the page count.

Deliberately tiny and stateless: all pipeline orchestration, retries and storage
live in the Node worker (src/jobs/documentProcessing.processor.js).
"""
import io
import os
import logging

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from PIL import Image
from paddleocr import PaddleOCR
from pdf2image import convert_from_bytes

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ocr")

MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(60 * 1024 * 1024)))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "50"))
DPI = int(os.environ.get("OCR_PDF_DPI", "200"))
DEFAULT_LANG = os.environ.get("OCR_MODEL_LANG", "en")

app = FastAPI(title="dms-ocr", docs_url=None, redoc_url=None)

# One engine per language, built lazily and cached. `use_angle_cls` handles
# rotated scans; models download on first use into the mounted volume.
_engines: dict[str, PaddleOCR] = {}


def _engine(lang: str) -> PaddleOCR:
    lang = lang or DEFAULT_LANG
    if lang not in _engines:
        log.info("loading PaddleOCR engine lang=%s", lang)
        _engines[lang] = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
    return _engines[lang]


def _ocr_image(engine: PaddleOCR, img: Image.Image):
    arr = np.array(img.convert("RGB"))
    result = engine.ocr(arr, cls=True)
    lines, confs = [], []
    for page in result or []:
        for entry in page or []:
            # entry = [box, (text, confidence)]
            try:
                text, conf = entry[1][0], float(entry[1][1])
            except (IndexError, TypeError, ValueError):
                continue
            if text and text.strip():
                lines.append(text.strip())
                confs.append(conf)
    return "\n".join(lines), confs


@app.get("/health")
def health():
    return {"status": "ok", "engines": list(_engines.keys())}


@app.post("/ocr")
async def ocr(file: UploadFile = File(...), lang: str = Form(DEFAULT_LANG)):
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="file too large for OCR")

    engine = _engine(lang)
    content_type = (file.content_type or "").lower()
    name = (file.filename or "").lower()
    is_pdf = "pdf" in content_type or name.endswith(".pdf")

    pages_text: list[str] = []
    all_confs: list[float] = []

    try:
        if is_pdf:
            images = convert_from_bytes(raw, dpi=DPI)
            if len(images) > MAX_PAGES:
                images = images[:MAX_PAGES]
            for img in images:
                text, confs = _ocr_image(engine, img)
                pages_text.append(text)
                all_confs.extend(confs)
            page_count = len(images)
        else:
            img = Image.open(io.BytesIO(raw))
            text, confs = _ocr_image(engine, img)
            pages_text.append(text)
            all_confs.extend(confs)
            page_count = 1
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - surface as a clean 422
        log.exception("ocr failed")
        raise HTTPException(status_code=422, detail=f"ocr failed: {exc}") from exc

    mean_conf = round(sum(all_confs) / len(all_confs), 4) if all_confs else None
    return {
        "text": "\n\n".join(t for t in pages_text if t),
        "confidence": mean_conf,
        "pages": page_count,
    }
