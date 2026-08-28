# the shared sandbox image for harnesses without their own dependencies:
# node + tsx + the harness sources. the image holds no cases, no keys, no core code.
# run as `docker run cucumber-harness-base /app/<name>/src/entry.ts`.
FROM node:24-slim
RUN npm install -g tsx@4
WORKDIR /app
COPY harnesses/ ./
USER node
ENTRYPOINT ["tsx"]
