---
"kysely-oracledb": minor
---

With `useNonQuotedIdentifiers`, a lowercase column selected without an alias now gets a quoted alias with the name as written, e.g. `select("name")` compiles to `select name "name"`. Oracle returns unquoted column names in uppercase, so these rows used to come back as `{ NAME }` instead of the `{ name }` their types describe. Uppercase columns, `selectAll()`, and selections in `create view` and `create table ... as` are unchanged. The introspector also leaves out `KYSELY_MIGRATION` and `KYSELY_MIGRATION_LOCK`, so the type generator no longer includes them.
