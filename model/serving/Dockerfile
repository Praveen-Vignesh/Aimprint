# Serving image for the model layer (Render Blueprint: render.yaml).
#
# ⚠️ PICKLE PORTABILITY — the one deployment gotcha:
# joblib/pickle artifacts do NOT load reliably across Python minor versions or
# across numpy/sklearn versions. This image is Python 3.13, so TRAINING must run
# on 3.13 with the same lib versions. model/requirements.txt now pins the
# artifact-critical libs (scikit-learn, numpy, joblib) to EXACTLY the versions
# below — keep them in lockstep or a trained *.joblib silently fails to load.
FROM python:3.13-slim

WORKDIR /app

# Serving deps only (not the training/notebook extras).
COPY model/serving/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The code. Trained artifacts are NOT baked in — models/* is gitignored, so this
# copies an effectively empty tree. The real artifacts are pulled from the
# private Supabase Storage bucket at startup (src/serving/app.py lifespan ->
# src/common/artifact_store.download_latest). The COPY stays only so the dir
# exists; it is no longer load-bearing.
COPY model/src /app/src
COPY model/models /app/models

# .env (SUPABASE_URL + SUPABASE_SERVICE_KEY) is provided at run time as env vars,
# never baked into the image — templates are read with the service key.
EXPOSE 8000
CMD ["uvicorn", "src.serving.app:app", "--host", "0.0.0.0", "--port", "8000"]
