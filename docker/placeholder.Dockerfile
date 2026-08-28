# sandboxed placeholder harness: node runtime + one self-contained entry file.
# the image holds no cases, no keys, no repo code.
FROM node:24-slim
COPY src/sandbox/placeholder-entry.mjs /app/entry.mjs
USER node
ENTRYPOINT ["node", "/app/entry.mjs"]
