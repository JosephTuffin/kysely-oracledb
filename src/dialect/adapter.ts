import { DialectAdapterBase, Kysely, MigrationLockOptions, RawBuilder, sql } from "kysely";
import { DEFAULT_MIGRATION_LOCK_TABLE } from "kysely/migration";
import oracledb from "oracledb";
import { OracleQueryResult } from "./connection.js";
import { CompilerOptions } from "./query-compiler.js";

const LOCK_TIMEOUT_SECONDS = 60 * 60;
const STATUS_BIND = { dir: oracledb.BIND_OUT, type: oracledb.NUMBER };

const getLockName = (schema: string | null, table: string) =>
    sql`substr('kysely_migration_lock:' || nvl(${schema}, sys_context('USERENV', 'CURRENT_SCHEMA')) || '.' || ${table}, 1, 128)`;

export class OracleAdapter extends DialectAdapterBase {
    #supportsReturning = true;
    #supportsTransactionalDdl = false;
    #useNonQuotedIdentifiers: boolean;

    constructor(compilerOptions?: CompilerOptions) {
        super();
        this.#useNonQuotedIdentifiers = compilerOptions?.useNonQuotedIdentifiers ?? false;
    }

    override get supportsReturning(): boolean {
        return this.#supportsReturning;
    }

    override get supportsTransactionalDdl(): boolean {
        return this.#supportsTransactionalDdl;
    }

    /**
     * `if not exists` on `create table` needs Oracle 23ai. The migrator creates its tables without it and
     * handles the "already exists" race itself, so turning it off keeps migrations working on older versions.
     */
    override get supportsCreateIfNotExists(): boolean {
        return false;
    }

    /**
     * Takes a session-level `DBMS_LOCK` lock. Oracle commits on every DDL statement, which would release a
     * transaction lock, but a session lock survives commits and is freed by Oracle if the session ends.
     */
    async acquireMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
        const { schema, table } = this.#getLockTarget(options);

        const status = await this.#executeLockBlock(
            db,
            sql`declare
    l_handle varchar2(128);
begin
    dbms_lock.allocate_unique_autonomous(${getLockName(schema, table)}, l_handle);
    ${STATUS_BIND} := dbms_lock.request(l_handle, dbms_lock.x_mode, ${LOCK_TIMEOUT_SECONDS}, false);
end;`,
        );

        // 0: acquired, 4: this session already holds the lock.
        if (status === 0 || status === 4) {
            return;
        }

        if (status === 1) {
            throw new Error(`Timed out after ${LOCK_TIMEOUT_SECONDS} seconds waiting for the migration lock.`);
        }

        throw new Error(`Failed to acquire the migration lock (DBMS_LOCK.REQUEST returned ${status}).`);
    }

    /**
     * Commits before releasing the lock. Without `autoCommit`, closing the pooled connection would roll back
     * the last migration's record and any rows a migration inserted.
     */
    async releaseMigrationLock(db: Kysely<any>, options: MigrationLockOptions): Promise<void> {
        const { schema, table } = this.#getLockTarget(options);

        const status = await this.#executeLockBlock(
            db,
            sql`declare
    l_handle varchar2(128);
begin
    commit;
    dbms_lock.allocate_unique_autonomous(${getLockName(schema, table)}, l_handle);
    ${STATUS_BIND} := dbms_lock.release(l_handle);
end;`,
        );

        // 0: released, 4: not held, e.g. when acquiring the lock failed.
        if (status !== 0 && status !== 4) {
            throw new Error(`Failed to release the migration lock (DBMS_LOCK.RELEASE returned ${status}).`);
        }
    }

    /**
     * Names the lock after the schema and lock table as Oracle stores them, so separate schemas in one
     * database don't block each other.
     */
    #getLockTarget(options: MigrationLockOptions) {
        if (!this.#useNonQuotedIdentifiers) {
            return { schema: options.lockTableSchema ?? null, table: options.lockTable };
        }

        if (
            options.lockTable !== DEFAULT_MIGRATION_LOCK_TABLE &&
            options.lockTable !== options.lockTable.toUpperCase()
        ) {
            throw new Error(
                `Migration lock table "${options.lockTable}" must be uppercase with \`useNonQuotedIdentifiers\`.`,
            );
        }

        return {
            schema: options.lockTableSchema?.toUpperCase() ?? null,
            table: options.lockTable.toUpperCase(),
        };
    }

    async #executeLockBlock(db: Kysely<any>, block: RawBuilder<unknown>): Promise<number> {
        let result: OracleQueryResult<unknown, unknown[]>;

        try {
            result = await block.execute(db);
        } catch (error) {
            if (error instanceof Error && error.message.includes("PLS-00201") && /DBMS_LOCK/i.test(error.message)) {
                throw new Error("Migrations need EXECUTE on DBMS_LOCK for the migration lock.", { cause: error });
            }
            throw error;
        }

        return Number(result.outBinds?.[0]);
    }
}
