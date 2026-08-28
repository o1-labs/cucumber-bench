# the cite-v1 harness: vercel ai sdk on node, built with tsc. build from the
# repo root. the image holds no cases, no keys, no core code.
# run as `docker run cucumber-harness-cite-v1 /app/dist/entry.js`.
FROM node:24-slim AS build
WORKDIR /app
COPY harnesses/cite-v1/package.json harnesses/cite-v1/package-lock.json ./
RUN npm ci
COPY harnesses/cite-v1/tsconfig.json ./
COPY harnesses/cite-v1/src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node"]
