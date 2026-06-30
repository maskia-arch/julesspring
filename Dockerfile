FROM node:22-alpine

# Arbeitsverzeichnis erstellen
WORKDIR /app

# Systemabhängigkeiten installieren und PostgREST downloaden
RUN apk add --no-cache curl tar xz && \
    curl -L -o postgrest.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.0/postgrest-v12.2.0-linux-static-x64.tar.xz && \
    tar -xJf postgrest.tar.xz && \
    mv postgrest /usr/local/bin/ && \
    rm postgrest.tar.xz && \
    apk del curl xz

# Abhängigkeiten kopieren und installieren
COPY package*.json ./
RUN npm ci --only=production

# App-Source kopieren
COPY src/ ./src
COPY version.txt ./version.txt

# Port freigeben (für das Dashboard / Webhook)
EXPOSE 3000

# App starten
CMD ["node", "src/server.js"]
