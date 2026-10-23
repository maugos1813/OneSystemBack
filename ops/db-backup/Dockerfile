# Daily encrypted backup of the OneSystec database to Backblaze B2 (an S3-compatible bucket).
# pg_dump has to be the same major version as the server (16 today): bump this tag if the database is upgraded.
FROM postgres:16-alpine
RUN apk add --no-cache age aws-cli bash
COPY backup.sh /backup.sh
ENTRYPOINT ["/bin/bash", "/backup.sh"]
