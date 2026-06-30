# Migration von Supabase Cloud zu Coolify (Self-Hosted)

Dieses Dokument erklärt, wie du deine bestehende Datenbank von Supabase Cloud exportierst und in deine neue selbstgehostete PostgreSQL-Datenbank auf deinem Server (über Coolify) importierst.

---

## Schritt 1: Datenbank-Backup (Dump) von Supabase erstellen

Um deine Tabellen-Strukturen, Indizes und alle bestehenden Daten verlustfrei zu exportieren, nutze das PostgreSQL-Tool `pg_dump`.

Führe den folgenden Befehl auf deinem lokalen Rechner aus. Ersetze die Host-Details mit deinen Supabase-Verbindungsdaten (zu finden unter *Project Settings -> Database*):

```bash
pg_dump -h db.yoursupabaseid.supabase.co -U postgres -d postgres --clean --if-exists --no-owner --no-privileges > supabase_dump.sql
```

> **Hinweis:** Du wirst nach dem Passwort deiner Supabase-Datenbank gefragt. Das Ergebnis ist eine Datei namens `supabase_dump.sql` auf deinem Rechner.

---

## Schritt 2: Dump auf deinen eigenen Server übertragen

Wenn du die Docker-Compose-Umgebung auf deinem Server gestartet hast, übertrage die Datei `supabase_dump.sql` auf den Server.

Du kannst z. B. `scp` nutzen:

```bash
scp supabase_dump.sql root@dein-server-ip:/root/supabase_dump.sql
```

---

## Schritt 3: Dump in die neue PostgreSQL-Datenbank einspielen

Je nachdem, welche Option du gewählt hast (lokaler Container im Compose oder eine eigenständige, von Coolify verwaltete PostgreSQL-Datenbank), spielst du den Dump wie folgt ein:

### Option A: Import in den lokalen Compose-Container (`db` Service)
1. Finde den Containernamen deiner Datenbank heraus:
   ```bash
   docker ps | grep db
   ```
   (Standardmäßig heißt der Container `ai_adminhelper_db`).

2. Führe den Import über die CLI aus:
   ```bash
   docker exec -i ai_adminhelper_db psql -U postgres -d postgres < /root/supabase_dump.sql
   ```

### Option B: Import in eine von Coolify verwaltete PostgreSQL-Datenbank (Empfohlen)
Da Coolify die Datenbank als eigenständigen Service verwaltet, kannst du sie bequem von außen befüllen:
1. Öffne die PostgreSQL-Ressource in deinem **Coolify Dashboard**.
2. Scrolle zu den Verbindungsinformationen und klicke auf **"Port nach außen freigeben"** (Expose port to internet).
3. Verbinde dich von deinem lokalen Rechner mit einem beliebigen Datenbank-Client (z. B. **DBeaver**, **pgAdmin** oder **TablePlus**) unter Verwendung des angegebenen öffentlichen Ports.
4. Führe die Datei `supabase_dump.sql` direkt über den SQL-Editor deines Clients aus.
5. Deaktiviere danach aus Sicherheitsgründen die Port-Freigabe in Coolify wieder.

*Fertig! Deine Tabellen, Daten und Berechtigungen wurden vollständig migriert.*

---

## Funktionsweise der Self-Hosted Anbindung

Da der Bot hunderte von Abfragen über den `@supabase/supabase-js` Client ausführt, haben wir einen nahtlosen Kompatibilitätsmodus implementiert, damit du keinen Datenbankcode anpassen musst:

1. **PostgREST-API:** In deinem Docker-Compose-Stack läuft ein PostgREST-Container. Dieser liest deine PostgreSQL `DATABASE_URL` und stellt die vertraute REST-API bereit.
2. **Path-Rewriting:** Das Supabase-SDK fragt standardmäßig `/rest/v1/...` ab. Unser Code im DB-Client (`src/config/supabase.js`) fängt diese Anfragen ab und leitet sie direkt an PostgREST weiter.
3. **Auto-Authentication:** Die App generiert und signiert die Service-Role JWT-Token zur Autorisierung bei PostgREST vollautomatisch basierend auf deinem `JWT_SECRET`.
