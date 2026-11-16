FROM node:22-slim

# git: a Baileys baixa uma dependência direto do GitHub | tzdata: fuso horário correto
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    AUTH_DIR=/app/estado/auth \
    DATA_DIR=/app/estado/data

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

CMD ["node", "src/index.js"]
