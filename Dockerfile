# Multi-stage image:
#  - builder: installs node deps and builds frontend
#  - runtime: lightweight node base + python + chromium + python deps + playwright + undetected-chromedriver
FROM node:20-bullseye AS builder
WORKDIR /app

# Install node deps and build frontend
COPY package.json package-lock.json ./
RUN npm ci --silent

# Copy project & build frontend (frontend build optional — won't fail container runtime)
COPY . .
RUN npm run build || true

# -------------------------
# Final runtime image
# -------------------------
FROM node:20-bullseye-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=off \
    CHROME_BIN=/usr/bin/google-chrome

# Install system packages required by chrome, playwright, python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv build-essential ca-certificates curl wget unzip git gnupg \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 libgbm1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Google Chrome (stable) from Google's repo and fetch matching ChromeDriver
RUN set -eux; \
    # add Google apt key & repo
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add -; \
    echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends google-chrome-stable; \
    # determine installed chrome version and download matching chromedriver
    CHROME_VER=$(google-chrome --version | awk '{print $3}'); \
    CHROME_MAJOR=$(echo "$CHROME_VER" | cut -d. -f1); \
    LATEST_DRIVER=$(wget -qO- "https://chromedriver.storage.googleapis.com/LATEST_RELEASE_${CHROME_MAJOR}"); \
    wget -qO /tmp/chromedriver_linux64.zip "https://chromedriver.storage.googleapis.com/${LATEST_DRIVER}/chromedriver_linux64.zip"; \
    unzip /tmp/chromedriver_linux64.zip -d /usr/local/bin/; \
    chmod +x /usr/local/bin/chromedriver; \
    rm -f /tmp/chromedriver_linux64.zip; \
    # cleanup apt lists to reduce image size
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules and build artifacts from builder to reuse caches
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json

# Copy backend & full repo
COPY backend ./backend
COPY . .

# Install python deps (from backend/requirements.txt) and Python helper packages
RUN python3 -m pip install --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir -r backend/requirements.txt \
 && python3 -m pip install --no-cache-dir undetected-chromedriver playwright==1.55.0 \
 && python3 -m playwright install chromium

# Create non-root user
RUN useradd --create-home appuser || true \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 5000 3000

# Default command runs the Node backend server.
# If you want to run the frontend dev server instead use docker-compose override (provided below).
CMD ["node", "backend/server.js"]