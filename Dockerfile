FROM oven/bun:1.3.3

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json ./
COPY src ./src
COPY README.md ./

ENV NODE_ENV=production
CMD ["bun", "src/index.ts"]
