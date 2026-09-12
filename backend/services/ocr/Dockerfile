# PaddleOCR sidecar for the document-intelligence pipeline. The Node worker
# POSTs image/PDF bytes to /ocr and gets back { text, confidence, pages }.
# CPU-only; no outbound network needed at runtime once models are cached.
FROM python:3.11-slim

# poppler-utils: pdf2image backend. libgl/libglib: OpenCV runtime deps pulled by
# paddleocr. libgomp1: OpenMP runtime paddleocr/numpy's native extensions need.
# curl is only for debugging.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
