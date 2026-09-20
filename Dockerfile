FROM node:22-alpine

WORKDIR /app

# 依赖安装纳入镜像构建（启动即就绪）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY examples ./examples

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
