# Deploy-ready image for the model serving layer. NOT built/deployed yet.
#
# ⚠️ PICKLE PORTABILITY — the one deployment gotcha:
# joblib/pickle artifacts do NOT load reliably across Python minor versions or
# across numpy/sklearn versions. Training currently runs on Python 3.15; this
# image is 3.13. A 3.15-produced *.joblib WILL likely fail to load here.
# Before deploying, do ONE of:
#   (a) retrain inside this image (same stack), or
#   (b) standardize training and serving on one Python+lib set (pin both).
# "Deploy-ready" means the structure is in place — not that a cross-version
# pickle will load.
FROM python:3.13-slim

WORKDIR /app

# Serving deps only (not the training/notebook extras).
COPY model/serving/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The code and the trained artifacts. models/ must contain artifacts produced on
# THIS stack (see the portability note above).
COPY model/src /app/src
COPY model/models /app/models

# .env (SUPABASE_URL + SUPABASE_SERVICE_KEY) is provided at run time as env vars,
# never baked into the image — templates are read with the service key.
EXPOSE 8000
CMD ["uvicorn", "src.serving.app:app", "--host", "0.0.0.0", "--port", "8000"]
