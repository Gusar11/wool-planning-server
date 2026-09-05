# Образ для деплоя Wool & Hornet Planning
FROM node:20-alpine

WORKDIR /app

# Сначала только манифесты — чтобы кэшировать установку зависимостей
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Затем весь проект
COPY . .

# Эталон и комнаты хранятся тут (том монтируется на этот путь в проде)
ENV DATA_FILE=/data/data.json
# Платформа обычно сама задаёт PORT; локально по умолчанию 3001
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server.js"]
