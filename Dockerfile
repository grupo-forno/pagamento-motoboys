# Imagem para o EasyPanel (ou qualquer Docker). O banco fica em /data: monte um volume persistente nesse caminho.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
