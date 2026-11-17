"""Payments core: orders, payments, Junction, Conductor, staff, audit, idempotency.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-17
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conductor_blocklist",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("value", sa.String(length=255), nullable=False),
        sa.Column("reason", sa.String(length=500), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_by", sa.String(length=40), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('card_bin','vpa')", name=op.f("ck_conductor_blocklist_valid_kind")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_conductor_blocklist")),
    )
    op.create_index(
        "uq_conductor_blocklist_active_value",
        "conductor_blocklist",
        ["kind", "value"],
        unique=True,
        postgresql_where=sa.text("active"),
    )
    op.create_table(
        "idempotency_keys",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("station_id", sa.String(length=40), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("key", sa.String(length=255), nullable=False),
        sa.Column("method", sa.String(length=8), nullable=False),
        sa.Column("path", sa.String(length=500), nullable=False),
        sa.Column("request_digest", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("response_status", sa.Integer(), nullable=True),
        sa.Column("response_body", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "locked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('in_progress','completed')", name=op.f("ck_idempotency_keys_valid_status")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_idempotency_keys")),
        sa.UniqueConstraint("station_id", "livemode", "key", name="uq_idempotency_keys_scope"),
    )
    op.create_table(
        "junction_authorizations",
        sa.Column("ref", sa.String(length=20), nullable=False),
        sa.Column("payment_id", sa.String(length=40), nullable=False),
        sa.Column("merchant_ref", sa.String(length=40), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("instrument", sa.String(length=64), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("scenario", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("decline_code", sa.String(length=64), nullable=True),
        sa.Column(
            "plan",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("requests_seen", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('received','pending','authorized','declined','captured','voided')",
            name=op.f("ck_junction_authorizations_valid_status"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_junction_authorizations_amount_positive")),
        sa.PrimaryKeyConstraint("ref", name=op.f("pk_junction_authorizations")),
        sa.UniqueConstraint("payment_id", name=op.f("uq_junction_authorizations_payment_id")),
    )
    op.create_table(
        "rate_limit_state",
        sa.Column("bucket", sa.String(length=120), nullable=False),
        sa.Column("tat", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("bucket", name=op.f("pk_rate_limit_state")),
    )
    op.create_table(
        "staff_audit_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("staff_id", sa.String(length=40), nullable=True),
        sa.Column("staff_email", sa.String(length=320), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("target_type", sa.String(length=40), nullable=True),
        sa.Column("target_id", sa.String(length=64), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_staff_audit_log")),
    )
    op.create_index("ix_staff_audit_log_staff_id", "staff_audit_log", ["staff_id"], unique=False)
    op.create_index(
        "ix_staff_audit_log_target", "staff_audit_log", ["target_type", "target_id"], unique=False
    )
    op.create_table(
        "staff_users",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("full_name", sa.String(length=200), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("password_hash", sa.String(length=200), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("failed_logins", sa.Integer(), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('ops','finance','security','admin')", name=op.f("ck_staff_users_valid_role")
        ),
        sa.CheckConstraint(
            "status IN ('active','disabled')", name=op.f("ck_staff_users_valid_status")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_staff_users")),
    )
    op.create_index(
        "uq_staff_users_email_lower", "staff_users", [sa.text("lower(email)")], unique=True
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("station_id", sa.String(length=40), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("receipt", sa.String(length=40), nullable=True),
        sa.Column(
            "notes",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("amount_paid", sa.BigInteger(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("currency IN ('INR','USD')", name=op.f("ck_orders_valid_currency")),
        sa.CheckConstraint(
            "status IN ('created','attempted','paid')", name=op.f("ck_orders_valid_status")
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_orders_amount_positive")),
        sa.ForeignKeyConstraint(
            ["station_id"],
            ["stations.id"],
            name=op.f("fk_orders_station_id_stations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
    )
    op.create_index(
        "ix_orders_station_mode_id", "orders", ["station_id", "livemode", "id"], unique=False
    )
    op.create_table(
        "staff_sessions",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("staff_id", sa.String(length=40), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ip", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=300), nullable=True),
        sa.ForeignKeyConstraint(
            ["staff_id"],
            ["staff_users.id"],
            name=op.f("fk_staff_sessions_staff_id_staff_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_staff_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_staff_sessions_token_hash")),
    )
    op.create_index("ix_staff_sessions_staff_id", "staff_sessions", ["staff_id"], unique=False)
    op.create_table(
        "payments",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("order_id", sa.String(length=40), nullable=False),
        sa.Column("station_id", sa.String(length=40), nullable=False),
        sa.Column("livemode", sa.Boolean(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("capture_mode", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("card_network", sa.String(length=16), nullable=True),
        sa.Column("card_bin", sa.String(length=8), nullable=True),
        sa.Column("card_last4", sa.String(length=4), nullable=True),
        sa.Column("card_expiry_month", sa.Integer(), nullable=True),
        sa.Column("card_expiry_year", sa.Integer(), nullable=True),
        sa.Column("vpa", sa.String(length=256), nullable=True),
        sa.Column("bank_code", sa.String(length=16), nullable=True),
        sa.Column("instrument_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("customer_email", sa.String(length=320), nullable=True),
        sa.Column("junction_ref", sa.String(length=20), nullable=True),
        sa.Column("junction_sequence", sa.Integer(), nullable=False),
        sa.Column("test_scenario", sa.String(length=64), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_description", sa.String(length=300), nullable=True),
        sa.Column("risk_decision", sa.String(length=8), nullable=False),
        sa.Column("risk_score", sa.Integer(), nullable=False),
        sa.Column(
            "risk_reasons",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("risk_review_status", sa.String(length=16), nullable=False),
        sa.Column("risk_reviewed_by", sa.String(length=40), nullable=True),
        sa.Column("risk_reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fee", sa.BigInteger(), nullable=True),
        sa.Column("tax", sa.BigInteger(), nullable=True),
        sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "capture_mode IN ('automatic','manual')", name=op.f("ck_payments_valid_capture_mode")
        ),
        sa.CheckConstraint("currency IN ('INR','USD')", name=op.f("ck_payments_valid_currency")),
        sa.CheckConstraint(
            "method IN ('card','upi','netbanking')", name=op.f("ck_payments_valid_method")
        ),
        sa.CheckConstraint(
            "risk_decision IN ('allow','review','block')",
            name=op.f("ck_payments_valid_risk_decision"),
        ),
        sa.CheckConstraint(
            "risk_review_status IN ('not_required','pending','approved','rejected')",
            name=op.f("ck_payments_valid_risk_review_status"),
        ),
        sa.CheckConstraint(
            "status IN ('created','pending','authorized','captured','failed')",
            name=op.f("ck_payments_valid_status"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_payments_amount_positive")),
        sa.ForeignKeyConstraint(
            ["order_id"],
            ["orders.id"],
            name=op.f("fk_payments_order_id_orders"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["station_id"],
            ["stations.id"],
            name=op.f("fk_payments_station_id_stations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payments")),
    )
    op.create_index(
        "ix_payments_fingerprint_created",
        "payments",
        ["instrument_fingerprint", "created_at"],
        unique=False,
    )
    op.create_index("ix_payments_junction_ref", "payments", ["junction_ref"], unique=False)
    op.create_index("ix_payments_order_id", "payments", ["order_id"], unique=False)
    op.create_index(
        "ix_payments_station_mode_id", "payments", ["station_id", "livemode", "id"], unique=False
    )
    op.create_index(
        "uq_payments_order_in_flight",
        "payments",
        ["order_id"],
        unique=True,
        postgresql_where=sa.text("status <> 'failed'"),
    )
    op.create_table(
        "payment_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("payment_id", sa.String(length=40), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("junction_event_id", sa.String(length=64), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=True),
        sa.Column("applied", sa.Boolean(), nullable=False),
        sa.Column("note", sa.String(length=300), nullable=True),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["payments.id"],
            name=op.f("fk_payment_events_payment_id_payments"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payment_events")),
        sa.UniqueConstraint("junction_event_id", name=op.f("uq_payment_events_junction_event_id")),
    )
    op.create_index("ix_payment_events_payment_id", "payment_events", ["payment_id"], unique=False)
    # --- api_keys: labels, scopes, encrypted signing key ---------------------
    op.add_column("api_keys", sa.Column("label", sa.String(length=100), nullable=True))
    op.add_column(
        "api_keys",
        sa.Column(
            "scopes",
            postgresql.ARRAY(sa.String(length=32)),
            server_default=sa.text("'{*}'"),
            nullable=False,
        ),
    )
    op.alter_column("api_keys", "scopes", server_default=None)
    # Keys issued before 0002 have no signing key; they keep working with Bearer auth.
    op.add_column("api_keys", sa.Column("signing_key_enc", sa.LargeBinary(), nullable=True))

    # --- stations: KYC + settings ---------------------------------------------
    for column, default in (
        (sa.Column("kyc_status", sa.String(length=16), nullable=False), "'pending'"),
        (sa.Column("settlement_schedule", sa.String(length=4), nullable=False), "'T+2'"),
        (sa.Column("fee_plan", sa.String(length=16), nullable=False), "'standard'"),
        (sa.Column("auto_capture", sa.Boolean(), nullable=False), "true"),
        (sa.Column("rate_limit_per_sec", sa.Integer(), nullable=False), "25"),
        (sa.Column("rate_limit_burst", sa.Integer(), nullable=False), "50"),
    ):
        column.server_default = sa.DefaultClause(sa.text(default))
        op.add_column("stations", column)
        op.alter_column("stations", column.name, server_default=None)
    op.add_column(
        "stations", sa.Column("kyc_rejection_reason", sa.String(length=500), nullable=True)
    )
    op.add_column("stations", sa.Column("kyc_reviewed_by", sa.String(length=40), nullable=True))
    op.add_column(
        "stations", sa.Column("kyc_reviewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("stations", sa.Column("webhook_url", sa.String(length=500), nullable=True))
    op.add_column("stations", sa.Column("max_payment_amount", sa.BigInteger(), nullable=True))
    # Stations that were live-enabled had passed KYC.
    op.execute("UPDATE stations SET kyc_status = 'verified' WHERE live_enabled")
    op.drop_column("stations", "live_enabled")
    op.create_check_constraint(
        "valid_kyc", "stations", "kyc_status IN ('pending','verified','rejected')"
    )
    op.create_check_constraint(
        "valid_settlement_schedule", "stations", "settlement_schedule IN ('T+1','T+2','T+3')"
    )
    op.create_check_constraint(
        "valid_fee_plan", "stations", "fee_plan IN ('standard','growth','enterprise')"
    )
    op.create_check_constraint(
        "rate_limit", "stations", "rate_limit_per_sec > 0 AND rate_limit_burst > 0"
    )

    # --- staff audit log is append-only -----------------------------------------
    op.execute(
        """
        CREATE FUNCTION staff_audit_log_forbid_mutation_trg() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'staff_audit_log is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'restrict_violation';
        END $$;

        CREATE TRIGGER staff_audit_log_immutable
            BEFORE UPDATE OR DELETE ON staff_audit_log
            FOR EACH ROW EXECUTE FUNCTION staff_audit_log_forbid_mutation_trg();
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS staff_audit_log_immutable ON staff_audit_log")
    op.execute("DROP FUNCTION IF EXISTS staff_audit_log_forbid_mutation_trg()")
    op.add_column(
        "stations",
        sa.Column("live_enabled", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.execute("UPDATE stations SET live_enabled = (kyc_status = 'verified')")
    op.alter_column("stations", "live_enabled", server_default=None)
    for name in ("rate_limit", "valid_fee_plan", "valid_settlement_schedule", "valid_kyc"):
        op.drop_constraint(op.f(f"ck_stations_{name}"), "stations", type_="check")
    for col in (
        "rate_limit_burst",
        "rate_limit_per_sec",
        "max_payment_amount",
        "auto_capture",
        "webhook_url",
        "fee_plan",
        "settlement_schedule",
        "kyc_reviewed_at",
        "kyc_reviewed_by",
        "kyc_rejection_reason",
        "kyc_status",
    ):
        op.drop_column("stations", col)
    op.drop_column("api_keys", "signing_key_enc")
    op.drop_column("api_keys", "scopes")
    op.drop_column("api_keys", "label")
    op.drop_index("ix_payment_events_payment_id", table_name="payment_events")
    op.drop_table("payment_events")
    op.drop_index(
        "uq_payments_order_in_flight",
        table_name="payments",
        postgresql_where=sa.text("status <> 'failed'"),
    )
    op.drop_index("ix_payments_station_mode_id", table_name="payments")
    op.drop_index("ix_payments_order_id", table_name="payments")
    op.drop_index("ix_payments_junction_ref", table_name="payments")
    op.drop_index("ix_payments_fingerprint_created", table_name="payments")
    op.drop_table("payments")
    op.drop_index("ix_staff_sessions_staff_id", table_name="staff_sessions")
    op.drop_table("staff_sessions")
    op.drop_index("ix_orders_station_mode_id", table_name="orders")
    op.drop_table("orders")
    op.drop_index("uq_staff_users_email_lower", table_name="staff_users")
    op.drop_table("staff_users")
    op.drop_index("ix_staff_audit_log_target", table_name="staff_audit_log")
    op.drop_index("ix_staff_audit_log_staff_id", table_name="staff_audit_log")
    op.drop_table("staff_audit_log")
    op.drop_table("rate_limit_state")
    op.drop_table("junction_authorizations")
    op.drop_table("idempotency_keys")
    op.drop_index(
        "uq_conductor_blocklist_active_value",
        table_name="conductor_blocklist",
        postgresql_where=sa.text("active"),
    )
    op.drop_table("conductor_blocklist")
