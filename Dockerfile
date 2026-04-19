FROM node:22-slim

# Chromium for puppeteer-core. We don't let puppeteer download its own
# bundled Chromium (huge, slow, and usually mismatched) — we install the
# system package and point PUPPETEER_EXECUTABLE_PATH at it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libxkbcommon0 \
      libgbm1 \
      libasound2 \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Build the Vite frontend so DASH can serve it if/when we add a static
# mount. Skipped if the preview script isn't present.
RUN npm run preview --if-present >/dev/null 2>&1 || true

EXPOSE 3001
CMD ["node", "server/launcher.js"]
