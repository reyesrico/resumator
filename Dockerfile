FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY shared ./shared
COPY src ./src
COPY server ./server
COPY tests ./tests
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libreoffice-writer fonts-liberation python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir -r requirements.txt
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY package.json package-lock.json tsconfig.json ./
COPY --chmod=755 deploy/start.sh /usr/local/bin/resumator-start
ENV NODE_ENV=production \
    RESUMATOR_PUBLIC=true \
    RESUMATOR_DATA_DIR=/var/data/resumator \
    PDF_PYTHON_BIN=/opt/python/bin/python \
    PDF2DOCX_BIN=/opt/python/bin/pdf2docx \
    LIBREOFFICE_BIN=libreoffice \
    PORT=10000
EXPOSE 10000
CMD ["resumator-start"]
