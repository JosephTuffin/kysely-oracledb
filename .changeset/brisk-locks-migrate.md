---
"kysely-oracledb": minor
---

Added support for Kysely's `Migrator`. The migration lock uses a session-level `DBMS_LOCK` lock, so the user running migrations needs `grant execute on sys.dbms_lock`. The migrator's tables are created without `if not exists`, so migrations work on Oracle versions before 23ai, and the migrator commits when it finishes, so migrations are saved without `autoCommit`. When the migrator looks for its tables, the introspector only searches the current schema unless `introspectorOptions.schemas` is set.
