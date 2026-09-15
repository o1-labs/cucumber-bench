# the lb2-direct harness: node + tsx, tokenizers.js, the shared lib, and the pinned qwen tokenizer
# files (run fetch-tokenizer.ts first). build from the repo root. the image holds no cases, no keys,
# no core code. run as `docker run cucumber-harness-lb2-direct /app/lb2-direct/src/entry.ts`.
FROM node:24-slim
RUN npm install -g tsx@4
WORKDIR /app
COPY harnesses/lib.ts ./lib.ts
COPY harnesses/lb2-direct/package.json harnesses/lb2-direct/package-lock.json ./lb2-direct/
RUN npm ci --prefix ./lb2-direct --omit=dev
COPY harnesses/lb2-direct/src ./lb2-direct/src
COPY harnesses/lb2-direct/tokenizer ./lb2-direct/tokenizer
# lb2-custom shares this image: the tokenizer and its dependency
COPY harnesses/lb2-custom/src ./lb2-custom/src
USER node
ENTRYPOINT ["tsx"]
