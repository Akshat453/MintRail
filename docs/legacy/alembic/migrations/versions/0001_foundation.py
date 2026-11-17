"""Foundation: jobs, ledger, stations, api_keys.

Revision ID: 0001
Revises:
Create Date: 2026-11-16
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # ------------------------------------------------------------------ jobs
    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("queue", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(128), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("run_at", TS, server_default=sa.func.now(), nullable=False),
        sa.Column("locked_by", sa.String(128), nullable=True),
        sa.Column("locked_at", TS, nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("finished_at", TS, nullable=True),
        sa.Column("dedupe_key", sa.String(200), nullable=True),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_jobs"),
        sa.UniqueConstraint("dedupe_key", name="uq_jobs_dedupe_key"),
    )
    op.create_index(
        "ix_jobs_claimable",
        "jobs",
        ["queue", "run_at"],
        postgresql_where=sa.text("status = 'queued'"),
    )
    op.create_index(
        "ix_jobs_running_locked_at",
        "jobs",
        ["locked_at"],
        postgresql_where=sa.text("status = 'running'"),
    )

    # ------------------------------------------------------------------ ledger
    op.create_table(
        "ledger_accounts",
        sa.Column("id", sa.String(40), nullable=False),
        sa.Column("code", sa.String(200), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("owner_id", sa.String(40), nullable=True),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("allow_negative", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "type IN ('asset','liability','equity','revenue','expense')",
            name="ck_ledger_accounts_valid_type",
        ),
        sa.CheckConstraint("status IN ('active','frozen')", name="ck_ledger_accounts_valid_status"),
        sa.PrimaryKeyConstraint("id", name="pk_ledger_accounts"),
        sa.UniqueConstraint("code", name="uq_ledger_accounts_code"),
    )
    op.create_index("ix_ledger_accounts_owner_id", "ledger_accounts", ["owner_id"])

    op.create_table(
        "ledger_balances",
        sa.Column("account_id", sa.String(40), nullable=False),
        sa.Column("debits_total", sa.BigInteger(), nullable=False),
        sa.Column("credits_total", sa.BigInteger(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("debits_total >= 0", name="ck_ledger_balances_debits_non_negative"),
        sa.CheckConstraint("credits_total >= 0", name="ck_ledger_balances_credits_non_negative"),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["ledger_accounts.id"],
            name="fk_ledger_balances_account_id_ledger_accounts",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("account_id", name="pk_ledger_balances"),
    )

    op.create_table(
        "ledger_transactions",
        sa.Column("id", sa.String(40), nullable=False),
        sa.Column("idempotency_key", sa.String(255), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("reference_type", sa.String(40), nullable=True),
        sa.Column("reference_id", sa.String(40), nullable=True),
        sa.Column("reverses_id", sa.String(40), nullable=True),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("effective_at", TS, nullable=False),
        sa.Column(
            "metadata", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["reverses_id"],
            ["ledger_transactions.id"],
            name="fk_ledger_transactions_reverses_id_ledger_transactions",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_ledger_transactions"),
        sa.UniqueConstraint("idempotency_key", name="uq_ledger_transactions_idempotency_key"),
    )
    op.create_index(
        "ix_ledger_transactions_reference",
        "ledger_transactions",
        ["reference_type", "reference_id"],
    )
    op.create_index(
        "uq_ledger_transactions_reverses_id",
        "ledger_transactions",
        ["reverses_id"],
        unique=True,
        postgresql_where=sa.text("reverses_id IS NOT NULL"),
    )

    op.create_table(
        "ledger_postings",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("transaction_id", sa.String(40), nullable=False),
        sa.Column("account_id", sa.String(40), nullable=False),
        sa.Column("direction", sa.String(6), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_ledger_postings_amount_positive"),
        sa.CheckConstraint(
            "direction IN ('debit','credit')", name="ck_ledger_postings_valid_direction"
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["ledger_accounts.id"],
            name="fk_ledger_postings_account_id_ledger_accounts",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["ledger_transactions.id"],
            name="fk_ledger_postings_transaction_id_ledger_transactions",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_ledger_postings"),
    )
    op.create_index("ix_ledger_postings_account_id_id", "ledger_postings", ["account_id", "id"])
    op.create_index("ix_ledger_postings_transaction_id", "ledger_postings", ["transaction_id"])

    # --- Database-enforced ledger invariants (ADR-0003) ---------------------
    op.execute(
        """
        CREATE FUNCTION ledger_postings_balanced_trg() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE bad record; n integer;
        BEGIN
            SELECT currency,
                   SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS net
              INTO bad FROM ledger_postings WHERE transaction_id = NEW.transaction_id
             GROUP BY currency
            HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0 LIMIT 1;
            IF FOUND THEN
                RAISE EXCEPTION 'MR_UNBALANCED_TRANSACTION: % is off by % %',
                    NEW.transaction_id, bad.net, bad.currency USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END $$;

        CREATE FUNCTION ledger_transactions_has_postings_trg() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE n integer;
        BEGIN
            SELECT count(*) INTO n FROM ledger_postings WHERE transaction_id = NEW.id;
            IF n < 2 THEN
                RAISE EXCEPTION 'MR_UNBALANCED_TRANSACTION: % has % posting(s)', NEW.id, n
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END $$;

        CREATE CONSTRAINT TRIGGER ledger_postings_balanced
            AFTER INSERT ON ledger_postings
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION ledger_postings_balanced_trg();

        CREATE CONSTRAINT TRIGGER ledger_transactions_has_postings
            AFTER INSERT ON ledger_transactions
            DEFERRABLE INITIALLY DEFERRED
            FOR EACH ROW EXECUTE FUNCTION ledger_transactions_has_postings_trg();

        CREATE FUNCTION ledger_posting_currency_matches_trg() RETURNS trigger
        LANGUAGE plpgsql AS $$
        DECLARE acct_currency text;
        BEGIN
            SELECT currency INTO acct_currency FROM ledger_accounts WHERE id = NEW.account_id;
            IF acct_currency IS DISTINCT FROM NEW.currency THEN
                RAISE EXCEPTION 'MR_CURRENCY_MISMATCH: posting % vs account % (%)',
                    NEW.currency, NEW.account_id, acct_currency USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END $$;

        CREATE TRIGGER ledger_postings_currency_matches
            BEFORE INSERT ON ledger_postings
            FOR EACH ROW EXECUTE FUNCTION ledger_posting_currency_matches_trg();

        CREATE FUNCTION ledger_forbid_mutation_trg() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
                USING ERRCODE = 'restrict_violation';
        END $$;

        CREATE TRIGGER ledger_postings_immutable
            BEFORE UPDATE OR DELETE ON ledger_postings
            FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation_trg();

        CREATE TRIGGER ledger_transactions_immutable
            BEFORE UPDATE OR DELETE ON ledger_transactions
            FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation_trg();
        """
    )

    # ------------------------------------------------------------------ platform
    op.create_table(
        "stations",
        sa.Column("id", sa.String(40), nullable=False),
        sa.Column("legal_name", sa.String(200), nullable=False),
        sa.Column("display_name", sa.String(100), nullable=False),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("business_category", sa.String(4), nullable=False),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("default_currency", sa.String(3), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("live_enabled", sa.Boolean(), nullable=False),
        sa.Column("suspended_reason", sa.String(500), nullable=True),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("status IN ('active','suspended')", name="ck_stations_valid_status"),
        sa.CheckConstraint("business_category ~ '^[0-9]{4}$'", name="ck_stations_mcc_format"),
        sa.PrimaryKeyConstraint("id", name="pk_stations"),
    )
    op.create_index("uq_stations_email_lower", "stations", [sa.text("lower(email)")], unique=True)

    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(40), nullable=False),
        sa.Column("station_id", sa.String(40), nullable=False),
        sa.Column("mode", sa.String(4), nullable=False),
        sa.Column("secret_hash", sa.String(64), nullable=False),
        sa.Column("hint", sa.String(32), nullable=False),
        sa.Column("status", sa.String(8), nullable=False),
        sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
        sa.Column("last_used_at", TS, nullable=True),
        sa.Column("revoked_at", TS, nullable=True),
        sa.CheckConstraint("mode IN ('test','live')", name="ck_api_keys_valid_mode"),
        sa.CheckConstraint("status IN ('active','revoked')", name="ck_api_keys_valid_status"),
        sa.ForeignKeyConstraint(
            ["station_id"],
            ["stations.id"],
            name="fk_api_keys_station_id_stations",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_api_keys"),
        sa.UniqueConstraint("secret_hash", name="uq_api_keys_secret_hash"),
    )
    op.create_index("ix_api_keys_station_id", "api_keys", ["station_id"])


def downgrade() -> None:
    op.drop_table("api_keys")
    op.drop_table("stations")
    op.execute("DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ledger_transactions")
    op.execute("DROP TRIGGER IF EXISTS ledger_postings_immutable ON ledger_postings")
    op.execute("DROP TRIGGER IF EXISTS ledger_postings_currency_matches ON ledger_postings")
    op.execute("DROP TRIGGER IF EXISTS ledger_transactions_has_postings ON ledger_transactions")
    op.execute("DROP TRIGGER IF EXISTS ledger_postings_balanced ON ledger_postings")
    op.drop_table("ledger_postings")
    op.drop_table("ledger_transactions")
    op.drop_table("ledger_balances")
    op.drop_table("ledger_accounts")
    for fn in (
        "ledger_forbid_mutation_trg",
        "ledger_posting_currency_matches_trg",
        "ledger_transactions_has_postings_trg",
        "ledger_postings_balanced_trg",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
    op.drop_table("jobs")
