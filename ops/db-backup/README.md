# Copias de seguridad diarias de la base de datos → Backblaze B2

Un servicio programado de Railway que cada día (03:00 UTC):

1. hace `pg_dump` de la base por la red privada de Railway,
2. la **cifra** con una clave pública (`age`): solo quien tenga la clave privada puede abrirla, así que un bucket filtrado no expone nada (la copia contiene hashes de contraseñas, PIN/PUK de SIMs y posiciones),
3. la sube a un bucket privado de B2,
4. conserva solo las últimas `BACKUP_RETENTION_COUNT` copias (30 por defecto).

Si la copia sale vacía o falla, el servicio termina con error y **no** borra copias buenas.

## Puesta en marcha

### 1. Backblaze B2
1. Crea una cuenta en backblaze.com y, en *Buckets*, un bucket **privado** (por ejemplo `onesystec-backups`). Sin cifrado del lado del servidor no hace falta: la copia ya va cifrada.
2. En *Application Keys* crea una clave **limitada a ese bucket** con permisos de lectura y escritura (incluye borrar archivos, que usa la retención). Guarda el `keyID` y la `applicationKey` (solo se muestra una vez).
3. En la página del bucket anota el *Endpoint* S3, con la forma `https://s3.us-west-004.backblazeb2.com`; la región es la parte `us-west-004`.

### 2. Clave de cifrado
La clave **privada** está solo en tu Mac (`~/OneSystec-backups/backup-key.txt`). Guárdala también en tu gestor de contraseñas: **sin ella las copias no se pueden abrir**. A Railway solo va la clave **pública** (la línea `# public key: age1...` de ese archivo).

### 3. Servicio en Railway
1. En el proyecto: *New* → *GitHub Repo* → este repositorio. En *Settings* del servicio nuevo pon **Root Directory** = `ops/db-backup`. El `railway.json` de esta carpeta ya trae la programación (`0 3 * * *`) y que no se reintente en bucle.
2. Variables del servicio:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | `${{OneSystemBack.DATABASE_URL}}` (la misma que usa el backend: referencia al servicio de la base por la red privada; el servicio de la base no define `DATABASE_URL`, solo `PG*`) |
| `B2_ENDPOINT` | el endpoint del paso 1 |
| `B2_REGION` | la región, p. ej. `us-west-004` |
| `B2_BUCKET` | el nombre del bucket |
| `B2_KEY_ID` | el `keyID` |
| `B2_APP_KEY` | la `applicationKey` (**séllala**) |
| `BACKUP_AGE_PUBLIC_KEY` | `age1...` (la clave pública) |
| `BACKUP_RETENTION_COUNT` | opcional, por defecto 30 |

3. Lanza una ejecución manual una vez y comprueba en B2 que aparece `db/onesystec-AAAAMMDD-HHMMSS.dump.age`.

## Restaurar (probado)
Las copias se restauran en una base con las mismas extensiones (TimescaleDB, PostGIS y timescaledb_toolkit); la imagen `timescale/timescaledb-ha:pg16-ts2.13` las trae.

```bash
# 1. Descifrar con la clave privada
age -d -i backup-key.txt -o restaurada.dump onesystec-AAAAMMDD-HHMMSS.dump.age

# 2. En la base de destino (vacía)
psql "$DESTINO" -c "create extension if not exists timescaledb" \
                -c "create extension if not exists postgis" \
                -c "create extension if not exists timescaledb_toolkit" \
                -c "select timescaledb_pre_restore()"
pg_restore -d "$DESTINO" --no-owner restaurada.dump
psql "$DESTINO" -c "select timescaledb_post_restore()"
```

Hay que usar `timescaledb_pre_restore()` y `timescaledb_post_restore()` alrededor de `pg_restore`; sin ellos la restauración de las tablas de series temporales falla.

## Mantenimiento
- `pg_dump` debe ser de la misma versión mayor que el servidor. Hoy es PostgreSQL 16: si Railway/la base pasa a 17, cambia `FROM postgres:16-alpine` en el `Dockerfile`.
- Revisa de vez en cuando que el bucket tenga copias recientes, y prueba una restauración cada trimestre.
