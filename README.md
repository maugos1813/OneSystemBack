# OneSystem Back

Backend de ingesta y API para la plataforma de rastreo de flotas OneSystem. Recibe los
datos que envía un dispositivo Teltonika **FMB204** (protocolo Codec 8 / Codec 8
Extended sobre TCP), los decodifica, los guarda en PostgreSQL (TimescaleDB + PostGIS) y
los expone vía una API REST + WebSocket multi-tenant.

## Arquitectura

- **Servidor TCP de ingesta** (`src/tcp-server`): escucha en `TCP_PORT` (default
  `5027`). El dispositivo abre la conexión, se identifica con su IMEI, y envía paquetes
  AVL binarios (Codec 8 / Codec 8 Extended). El parser (`src/tcp-server/codec8`) está
  validado contra los ejemplos oficiales de Teltonika (ver `test/tcp-server/codec8`).
- **API REST + WebSocket** (`src/api`, `src/realtime`): Fastify, JWT, expone
  organizaciones/usuarios, dispositivos, vehículos e historial de posiciones. Multi-tenant:
  todo queda scoped por `org_id`.
- **Base de datos**: PostgreSQL con TimescaleDB (hypertables para `positions` y
  `device_events`) y PostGIS (columna geoespacial generada para queries de cercanía).
  Definida con Drizzle ORM (`src/db/schema`).

## Requisitos

- Node.js 20+
- Docker (para levantar Postgres+TimescaleDB+PostGIS en desarrollo)

## Puesta en marcha (desarrollo)

```bash
cp .env.example .env
npm install
docker compose up -d          # levanta Postgres con TimescaleDB + PostGIS
npm run db:migrate            # aplica el schema + hypertables + extensión PostGIS
npm run dev                   # arranca la API (HTTP_PORT) y el servidor TCP (TCP_PORT)
```

Para simular un dispositivo FMB204 sin tener el hardware a mano:

```bash
npm run simulate:device
```

Esto abre una conexión TCP local, hace el handshake de IMEI y envía un paquete Codec 8
Extended de ejemplo; el log del servidor debe mostrar el registro guardado.

## Tests

```bash
npm test
```

Incluye:
- Tests unitarios del parser Codec 8 / Codec 8 Extended contra los frames de ejemplo
  publicados por Teltonika (`wiki.teltonika-gps.com/view/Codec`), verificando CRC-16,
  valores decodificados y timestamps exactos.
- Un test de integración que levanta el servidor TCP real y simula la conexión de un
  dispositivo (handshake + ACKs) de punta a punta, sin base de datos.

## Configurar el dispositivo FMB204

Con Teltonika Configurator (o por SMS/FOTA), configurar en el dispositivo:

1. **Server Settings** → Domain/IP: la IP pública (o local, en desarrollo) del backend.
   Puerto: el mismo `TCP_PORT` del `.env` (default `5027`). Protocol: `TCP`.
2. **Data Acquisition / Codec** → Codec 8 Extended (el que usa por defecto la familia
   FMBxxx).
3. Configurar el intervalo de envío (Data Acquisition → Min/Max Period) según la
   frecuencia de posiciones deseada.

Una vez conectado, el dispositivo queda registrado automáticamente en la base como
`unclaimed` (identificado por su IMEI). Un usuario de una organización debe asociarlo
con `POST /devices/claim { "imei": "..." }` antes de que sus posiciones aparezcan
vinculadas a un vehículo.

## API (resumen)

Documentación interactiva completa (OpenAPI/Swagger) en **`/docs`** una vez levantado el
servidor — ahí están todos los endpoints, sus parámetros y se pueden probar en vivo.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/register` | Crea una organización + usuario owner, devuelve JWT |
| POST | `/auth/login` | Login, devuelve JWT |
| GET | `/me` | Datos del usuario/organización autenticados |
| GET/POST | `/api-keys` | Listar/crear API keys de la organización (solo con JWT) |
| DELETE | `/api-keys/:id` | Revocar una API key |
| GET | `/devices` | Dispositivos de la organización |
| POST | `/devices/claim` | Asocia un dispositivo (por IMEI) a la organización |
| GET/POST | `/vehicles` | CRUD de vehículos |
| GET/PATCH/DELETE | `/vehicles/:id` | — |
| GET | `/vehicles/:id/positions/latest` | Última posición conocida |
| GET | `/vehicles/:id/positions?from=&to=&limit=` | Histórico |
| GET | `/vehicles/:id/events?from=&to=&limit=` | Eventos (ignición/movimiento) |
| GET/PATCH | `/settings` | Nombre de la organización, horario laboral y preferencias de alertas |
| GET/POST | `/geofences` | CRUD de geocercas circulares (centro + radio) |
| PATCH/DELETE | `/geofences/:id` | — |
| WS | `/realtime/positions` | Stream de posiciones en vivo (requiere JWT) |

Todas las rutas (salvo `/auth/*`, `/health` y `/docs`) requieren
`Authorization: Bearer <token>` — un JWT (login, para la app) o una **API key**
(`osk_live_...`, creada en `/api-keys`, para integraciones de terceros). Ambos resuelven
al mismo scoping por organización, así que cualquier endpoint que use datos de flota
(dispositivos, vehículos, posiciones) funciona igual con cualquiera de los dos — la
gestión de las keys en sí (`/api-keys`) es la única excepción, esa requiere JWT siempre,
para que una key filtrada no pueda emitir keys nuevas.

## Despliegue

El servidor TCP necesita un **puerto público persistente** (no es compatible con
plataformas serverless ni con Render, que solo soporta HTTP/WebSocket). Este proyecto
está pensado para desplegarse en **Railway**, que soporta exponer HTTP y TCP Proxy en el
mismo servicio.

### Pasos en Railway

1. **Base de datos**: en el dashboard de Railway, `New` → `Template` → buscar
   "TimescaleDB + PostGIS" y desplegarla como servicio (por defecto queda nombrado
   `TimescaleDB`). Ese template **no expone** una variable `DATABASE_URL` propia — solo
   las partes sueltas (`PGUSER`, `PGPASSWORD`, `PGHOST`, `PGPORT`, `PGDATABASE`).
2. **Backend**: `New` → `GitHub Repo` → elegir `maugos1813/OneSystemBack` (rama
   `Maudev`). Railway detecta el `Dockerfile` automáticamente (hay un `railway.json` con
   la config de build/healthcheck).
3. **Variables de entorno** del servicio backend (pestaña `Variables` → `Raw Editor`,
   sin comillas alrededor de las referencias — Railway las vuelve a mostrar con comillas
   al releer, es solo cosmético):
   ```
   DATABASE_URL=postgresql://${{TimescaleDB.PGUSER}}:${{TimescaleDB.PGPASSWORD}}@${{TimescaleDB.PGHOST}}:${{TimescaleDB.PGPORT}}/${{TimescaleDB.PGDATABASE}}
   JWT_SECRET=<un secreto fuerte, no reusar el de .env.example>
   TCP_PORT=5027
   HTTP_PORT=3000
   TCP_HOST=0.0.0.0
   HTTP_HOST=0.0.0.0
   LOG_LEVEL=info
   ```
   Si el servicio de la base no se llama exactamente `TimescaleDB` en tu dashboard,
   ajustá el nombre en cada referencia.
4. **Networking** del servicio backend (pestaña `Settings` → `Networking`):
   - Generar un dominio HTTP público apuntando al puerto `3000` (para la API/WebSocket).
   - Habilitar **TCP Proxy** apuntando al puerto `5027` (para que el FMB204 se conecte).
     Railway asigna un host y puerto propios (ej. `xxxx.proxy.rlwy.net:12345`) — ese es
     el `Domain/IP` y `Puerto` que hay que cargar en el dispositivo.
5. **Migraciones**: se aplican solas al arrancar (`src/index.ts` corre `drizzle-orm`'s
   `migrate()` antes de levantar los servidores) — no hace falta ningún paso manual acá.
   Si alguna vez necesitás correrlas a mano contra la base de Railway desde tu máquina,
   `timescaledb.railway.internal` es un host de **red privada** (no resoluble desde
   afuera, ni con `railway run`): abrí un **TCP Proxy** temporal sobre el puerto `5432`
   del servicio `TimescaleDB` (`Settings` → `Networking` → `+ TCP Proxy`), usalo para
   armar el `DATABASE_URL` y correr `npm run db:migrate`, y después borralo — el backend
   sigue hablándole por red privada sin él.

## Fuera de alcance (por ahora)

Envío de comandos al dispositivo, geocercas con alertas, reportes/analítica avanzada.
