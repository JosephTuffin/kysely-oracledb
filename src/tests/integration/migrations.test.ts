import { Kysely, sql } from "kysely";
import { Migration, MigrationProvider, Migrator, MigratorProps, NO_MIGRATIONS } from "kysely/migration";
import oracledb from "oracledb";
import { describe, expect, it, TestContext } from "vitest";
import { OracleDialect } from "../../dialect/dialect";
import { CompilerOptions } from "../../dialect/query-compiler";

const createProvider = (migrations: Record<string, Migration>): MigrationProvider => ({
    getMigrations: async () => migrations,
});

const migrations: Record<string, Migration> = {
    "001_create_users": {
        up: async (db) => {
            await db.schema
                .createTable("users")
                .addColumn("id", "integer", (col) => col.primaryKey())
                .addColumn("name", "varchar(255)", (col) => col.notNull())
                .execute();
        },
        down: async (db) => {
            await db.schema.dropTable("users").execute();
        },
    },
    "002_add_email": {
        up: async (db) => {
            await db.schema.alterTable("users").addColumn("email", "varchar(255)").execute();
        },
        down: async (db) => {
            await db.schema.alterTable("users").dropColumn("email").execute();
        },
    },
    "003_seed_users": {
        up: async (db) => {
            await db.insertInto("users").values({ id: 1, name: "User" }).execute();
        },
        down: async (db) => {
            await db.deleteFrom("users").execute();
        },
    },
};

const createDb = (context: TestContext, compilerOptions: CompilerOptions, autoCommit = true) =>
    new Kysely<any>({
        dialect: new OracleDialect({
            pool: context.getPool(),
            compilerOptions,
            executeOptions: autoCommit ? { autoCommit: true } : undefined,
        }),
    });

const createMigrator = (db: Kysely<any>, props: Partial<MigratorProps> = {}) =>
    new Migrator({ db, provider: createProvider(migrations), ...props });

const withSys = async <T>(callback: (connection: oracledb.Connection) => Promise<T>) => {
    const connection = await oracledb.getConnection({
        user: "sys",
        password: "oracle",
        connectionString: "localhost:1521/FREEPDB1",
        privilege: oracledb.SYSDBA,
    });
    try {
        return await callback(connection);
    } finally {
        await connection.close();
    }
};

describe.each([
    { mode: "quoted identifiers", compilerOptions: {} },
    { mode: "non-quoted identifiers", compilerOptions: { useNonQuotedIdentifiers: true } },
])("migrations with $mode", ({ compilerOptions }) => {
    it("should migrate to latest and do nothing on a re-run", async (context) => {
        const db = createDb(context, compilerOptions);

        const first = await createMigrator(db).migrateToLatest();

        expect(first.error).toBeUndefined();
        expect(first.results?.map((result) => [result.migrationName, result.status])).toEqual([
            ["001_create_users", "Success"],
            ["002_add_email", "Success"],
            ["003_seed_users", "Success"],
        ]);

        const second = await createMigrator(db).migrateToLatest();

        expect(second.error).toBeUndefined();
        expect(second.results).toEqual([]);

        const executed = await createMigrator(db).getMigrations();

        expect(executed.every((migration) => migration.executedAt instanceof Date)).toBe(true);

        const users = await db.selectFrom("users").select(["id", "name", "email"]).execute();

        expect(users).toEqual([{ id: 1, name: "User", email: null }]);
    });

    it("should leave the migration tables out of introspection", async (context) => {
        const db = createDb(context, compilerOptions);
        const introspected = new Kysely<any>({
            dialect: new OracleDialect({
                pool: context.getPool(),
                compilerOptions,
                introspectorOptions: { schemas: [context.testId] },
            }),
        });

        await createMigrator(db).migrateToLatest();

        const tables = await introspected.introspection.getTables();
        const names = tables.map((table) => table.name.toLowerCase());

        expect(names).not.toContain("kysely_migration");
        expect(names).not.toContain("kysely_migration_lock");
        expect(names).toContain("users");
    });

    it("should migrate down and to no migrations", async (context) => {
        const db = createDb(context, compilerOptions);

        await createMigrator(db).migrateToLatest();

        const down = await createMigrator(db).migrateDown();

        expect(down.error).toBeUndefined();
        expect(down.results?.map((result) => [result.migrationName, result.status])).toEqual([
            ["003_seed_users", "Success"],
        ]);
        expect(await db.selectFrom("users").select("id").execute()).toEqual([]);

        const reset = await createMigrator(db).migrateTo(NO_MIGRATIONS);

        expect(reset.error).toBeUndefined();
        expect(reset.results?.map((result) => result.migrationName)).toEqual(["002_add_email", "001_create_users"]);

        const executed = await createMigrator(db).getMigrations();

        expect(executed.every((migration) => migration.executedAt === undefined)).toBe(true);
    });

    it("should commit migrations without autoCommit", async (context) => {
        const db = createDb(context, compilerOptions, false);
        const check = createDb(context, compilerOptions);

        const result = await createMigrator(db).migrateToLatest();

        expect(result.error).toBeUndefined();

        const executed = await createMigrator(check).getMigrations();

        expect(executed.every((migration) => migration.executedAt instanceof Date)).toBe(true);
        expect(await check.selectFrom("users").select("id").execute()).toEqual([{ id: 1 }]);
    });

    it("should release the lock when a migration fails", async (context) => {
        const failing = createDb(context, compilerOptions);
        const other = new Kysely<any>({
            dialect: new OracleDialect({
                pool: await context.createPool(),
                compilerOptions,
                executeOptions: { autoCommit: true },
            }),
        });

        try {
            const failed = await new Migrator({
                db: failing,
                provider: createProvider({
                    ...migrations,
                    "002_add_email": {
                        up: async () => {
                            throw new Error("Migration failed");
                        },
                    },
                }),
            }).migrateToLatest();

            expect(failed.error).toEqual(new Error("Migration failed"));
            expect(failed.results?.map((result) => [result.migrationName, result.status])).toEqual([
                ["001_create_users", "Success"],
                ["002_add_email", "Error"],
                ["003_seed_users", "NotExecuted"],
            ]);

            // A different pool means a different session, which would wait if the lock had been left held.
            const result = await createMigrator(other).migrateToLatest();

            expect(result.error).toBeUndefined();
            expect(result.results?.map((result) => result.migrationName)).toEqual(["002_add_email", "003_seed_users"]);
        } finally {
            await other.destroy();
        }
    });

    it("should run each migration once when migrating concurrently", async (context) => {
        const runs: string[] = [];

        // Each migration runs DDL, which commits, and then sleeps, so a lock released on commit would let
        // the other migrator in.
        const slowMigrations = Object.fromEntries(
            ["001_first", "002_second"].map((name) => [
                name,
                {
                    up: async (db: Kysely<any>) => {
                        runs.push(name);
                        await db.schema.createTable(`table_${name}`).addColumn("id", "integer").execute();
                        await sql`begin dbms_session.sleep(1); end;`.execute(db);
                    },
                } satisfies Migration,
            ]),
        );

        const dbs = await Promise.all([createDb(context, compilerOptions), createDb(context, compilerOptions)]);

        const results = await Promise.all(
            dbs.map((db) => new Migrator({ db, provider: createProvider(slowMigrations) }).migrateToLatest()),
        );

        expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
        expect(runs.sort()).toEqual(["001_first", "002_second"]);
        expect(results.flatMap((result) => result.results ?? []).map((result) => result.status)).toEqual([
            "Success",
            "Success",
        ]);
    }, 30_000);
});

describe("migrations with non-quoted identifiers", () => {
    it("should migrate with uppercase custom table names", async (context) => {
        const db = createDb(context, { useNonQuotedIdentifiers: true });
        const props = { migrationTableName: "MIGRATIONS", migrationLockTableName: "MIGRATIONS_LOCK" };

        const first = await createMigrator(db, props).migrateToLatest();

        expect(first.error).toBeUndefined();
        expect(first.results).toHaveLength(3);

        const second = await createMigrator(db, props).migrateToLatest();

        expect(second.error).toBeUndefined();
        expect(second.results).toEqual([]);
    });

    it("should throw for a lowercase custom lock table name", async (context) => {
        const db = createDb(context, { useNonQuotedIdentifiers: true });

        const result = await createMigrator(db, {
            migrationTableName: "MIGRATIONS",
            migrationLockTableName: "migrations_lock",
        }).migrateToLatest();

        expect(result.error).toEqual(
            new Error(
                'Migration lock table "migrations_lock" must be uppercase with `useNonQuotedIdentifiers`, e.g. "MIGRATIONS_LOCK". Use uppercase for `migrationTableName` too.',
            ),
        );
        expect(result.results).toBeUndefined();
    });
});

describe("migrations with a migration table schema", () => {
    it("should migrate with the schema in the introspector schemas", async (context) => {
        const db = new Kysely<any>({
            dialect: new OracleDialect({
                pool: context.getPool(),
                executeOptions: { autoCommit: true },
                introspectorOptions: { schemas: [context.testId] },
            }),
        });
        const props = { migrationTableSchema: context.testId };

        const first = await createMigrator(db, props).migrateToLatest();

        expect(first.error).toBeUndefined();
        expect(first.results).toHaveLength(3);

        const second = await createMigrator(db, props).migrateToLatest();

        expect(second.error).toBeUndefined();
        expect(second.results).toEqual([]);
    });
});

describe("migration lock", () => {
    it("should explain a missing grant on DBMS_LOCK", async (context) => {
        await withSys((connection) => connection.execute(`revoke execute on sys.dbms_lock from ${context.testId}`));

        const db = createDb(context, {});

        const result = await createMigrator(db).migrateToLatest();

        expect(result.error).toEqual(
            new Error(
                "Migrations need EXECUTE on DBMS_LOCK for the migration lock. Ask a DBA to run `grant execute on sys.dbms_lock to <user>`.",
            ),
        );
    });
});
