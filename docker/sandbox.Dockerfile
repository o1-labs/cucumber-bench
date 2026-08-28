# the sandbox image every system runs in: node runtime + the entry scripts.
# the image holds no cases, no keys, no repo code. the script to run is the
# container argument, e.g. `docker run cucumber-bench-sandbox /app/direct-entry.mjs`.
FROM node:24-slim
COPY src/sandbox/ /app/
USER node
ENTRYPOINT ["node"]
