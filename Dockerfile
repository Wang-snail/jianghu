FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @anthropic-ai/claude-code

WORKDIR /app
COPY --from=build /app/out/mcp ./out/mcp
COPY --from=build /app/out/ui ./out/ui

WORKDIR /app/out/mcp
RUN npm install --omit=dev

WORKDIR /app
ENV NODE_ENV=production \
    COMPANY_DEPLOYMENT_MODE=cloud \
    COMPANY_BIND_HOST=0.0.0.0 \
    COMPANY_DATA_DIR=/data \
    COMPANY_SKIP_MCP_REGISTER=1 \
    COMPANY_NO_AUTO_OPEN=1

VOLUME ["/data"]
EXPOSE 4700

CMD ["sh", "-c", "node out/mcp/cli.js serve --port ${PORT:-4700}"]
