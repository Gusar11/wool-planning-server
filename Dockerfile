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

# ВАЖНО: порт НЕ фиксируем — платформа (Railway) сама передаёт переменную PORT,
# а сервер слушает process.env.PORT. Локально по умолчанию используется 3001.
EXPOSE 3001

CMD ["node", "server.js"]
