FROM node:24-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production TZ=Europe/Berlin DATA_DIR=/data HOME=/data/home WEB_ROOT=/app/web PORT=8080 \
    DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1
# Claude-Code-CLI: führt die Rezept- und Planungsanfragen im Headless-Modus aus
RUN npm install -g @anthropic-ai/claude-code --no-audit --no-fund && npm cache clean --force
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src ./src
COPY --from=web /web/dist /app/web
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "mkdir -p \"$HOME\" && exec node --disable-warning=ExperimentalWarning src/index.ts"]
