# Obraz dla Fly.io (albo dowolnego hostingu kontenerów). Serwer nie ma zależności,
# więc kopiujemy tylko pliki gry i uruchamiamy Node.
FROM node:22-alpine

WORKDIR /app
COPY index.html server.mjs ./
COPY js ./js
COPY fonts ./fonts

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.mjs"]
