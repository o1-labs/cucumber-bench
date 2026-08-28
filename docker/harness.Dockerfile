# the real harness: vercel ai sdk on node, built with tsc. the image holds no
# cases, no keys, no repo code. run as `docker run cucumber-bench-harness /app/dist/entry.js`.
FROM node:24-slim AS build
WORKDIR /app
COPY harness/package.json harness/package-lock.json ./
RUN npm ci
COPY harness/tsconfig.json ./
COPY harness/src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node"]
