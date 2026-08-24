# 构建 Vite 前端产物。
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 运行镜像：Node 同时提供静态前端和长耗时 DDShub 任务代理。
FROM node:22-alpine

COPY --from=web-build /app/web/dist /app/web/dist
COPY server.mjs /app/server.mjs

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
