FROM ghcr.io/puppeteer/puppeteer:21.5.2

WORKDIR /app

COPY package*.json ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
