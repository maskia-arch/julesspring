FROM node:18-alpine

# Arbeitsverzeichnis erstellen
WORKDIR /app

# Abhängigkeiten kopieren und installieren
COPY package*.json ./
RUN npm ci --only=production

# App-Source kopieren
COPY src/ ./src
COPY version.txt ./version.txt

# Port freigeben
EXPOSE 3000

# App starten
CMD ["node", "src/server.js"]
