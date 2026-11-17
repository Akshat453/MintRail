--
-- PostgreSQL database dump
--

\restrict 9DSGnWVO8D5EXWbvTmgBEcxQSDBlbvO4obbkkzNUqXvdCIoMFjQYgXQJQ2IJWQT

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: ledger_forbid_mutation_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_forbid_mutation_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
                USING ERRCODE = 'restrict_violation';
        END $$;


--
-- Name: ledger_posting_currency_matches_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_posting_currency_matches_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE acct_currency text;
        BEGIN
            SELECT currency INTO acct_currency FROM ledger_accounts WHERE id = NEW.account_id;
            IF acct_currency IS DISTINCT FROM NEW.currency THEN
                RAISE EXCEPTION 'MR_CURRENCY_MISMATCH: posting % vs account % (%)',
                    NEW.currency, NEW.account_id, acct_currency USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END $$;


--
-- Name: ledger_postings_balanced_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_postings_balanced_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: ledger_transactions_has_postings_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ledger_transactions_has_postings_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        DECLARE n integer;
        BEGIN
            SELECT count(*) INTO n FROM ledger_postings WHERE transaction_id = NEW.id;
            IF n < 2 THEN
                RAISE EXCEPTION 'MR_UNBALANCED_TRANSACTION: % has % posting(s)', NEW.id, n
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NULL;
        END $$;


--
-- Name: staff_audit_log_forbid_mutation_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_audit_log_forbid_mutation_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
        BEGIN
            RAISE EXCEPTION 'staff_audit_log is append-only: % is not allowed', TG_OP
                USING ERRCODE = 'restrict_violation';
        END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    mode character varying(4) NOT NULL,
    secret_hash character varying(64) NOT NULL,
    hint character varying(32) NOT NULL,
    status character varying(8) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    label character varying(100),
    scopes character varying(32)[] NOT NULL,
    signing_key_enc bytea,
    CONSTRAINT ck_api_keys_ck_api_keys_valid_mode CHECK (((mode)::text = ANY ((ARRAY['test'::character varying, 'live'::character varying])::text[]))),
    CONSTRAINT ck_api_keys_ck_api_keys_valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: conductor_blocklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conductor_blocklist (
    id character varying(40) NOT NULL,
    kind character varying(16) NOT NULL,
    value character varying(255) NOT NULL,
    reason character varying(500) NOT NULL,
    active boolean NOT NULL,
    created_by character varying(40) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    CONSTRAINT ck_conductor_blocklist_valid_kind CHECK (((kind)::text = ANY ((ARRAY['card_bin'::character varying, 'vpa'::character varying])::text[])))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id bigint NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    key character varying(255) NOT NULL,
    method character varying(8) NOT NULL,
    path character varying(500) NOT NULL,
    request_digest character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    response_status integer,
    response_body jsonb,
    locked_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT ck_idempotency_keys_valid_status CHECK (((status)::text = ANY ((ARRAY['in_progress'::character varying, 'completed'::character varying])::text[])))
);


--
-- Name: idempotency_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.idempotency_keys ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.idempotency_keys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id bigint NOT NULL,
    queue character varying(64) NOT NULL,
    kind character varying(128) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(16) NOT NULL,
    attempts integer NOT NULL,
    max_attempts integer NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_by character varying(128),
    locked_at timestamp with time zone,
    last_error text,
    finished_at timestamp with time zone,
    dedupe_key character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.jobs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: junction_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.junction_authorizations (
    ref character varying(20) NOT NULL,
    payment_id character varying(40) NOT NULL,
    merchant_ref character varying(40) NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    method character varying(16) NOT NULL,
    instrument character varying(64) NOT NULL,
    livemode boolean NOT NULL,
    scenario character varying(64),
    status character varying(16) NOT NULL,
    decline_code character varying(64),
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    sequence integer NOT NULL,
    requests_seen integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_junction_authorizations_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_junction_authorizations_valid_status CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'pending'::character varying, 'authorized'::character varying, 'declined'::character varying, 'captured'::character varying, 'voided'::character varying])::text[])))
);


--
-- Name: ledger_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_accounts (
    id character varying(40) NOT NULL,
    code character varying(200) NOT NULL,
    name character varying(200) NOT NULL,
    type character varying(16) NOT NULL,
    currency character varying(3) NOT NULL,
    owner_id character varying(40),
    livemode boolean NOT NULL,
    allow_negative boolean NOT NULL,
    status character varying(16) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ledger_accounts_ck_ledger_accounts_valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'frozen'::character varying])::text[]))),
    CONSTRAINT ck_ledger_accounts_ck_ledger_accounts_valid_type CHECK (((type)::text = ANY ((ARRAY['asset'::character varying, 'liability'::character varying, 'equity'::character varying, 'revenue'::character varying, 'expense'::character varying])::text[])))
);


--
-- Name: ledger_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_balances (
    account_id character varying(40) NOT NULL,
    debits_total bigint NOT NULL,
    credits_total bigint NOT NULL,
    version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ledger_balances_ck_ledger_balances_credits_non_negative CHECK ((credits_total >= 0)),
    CONSTRAINT ck_ledger_balances_ck_ledger_balances_debits_non_negative CHECK ((debits_total >= 0))
);


--
-- Name: ledger_postings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_postings (
    id bigint NOT NULL,
    transaction_id character varying(40) NOT NULL,
    account_id character varying(40) NOT NULL,
    direction character varying(6) NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_ledger_postings_ck_ledger_postings_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_ledger_postings_ck_ledger_postings_valid_direction CHECK (((direction)::text = ANY ((ARRAY['debit'::character varying, 'credit'::character varying])::text[])))
);


--
-- Name: ledger_postings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ledger_postings ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.ledger_postings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ledger_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_transactions (
    id character varying(40) NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    fingerprint character varying(64) NOT NULL,
    description character varying(500) NOT NULL,
    reference_type character varying(40),
    reference_id character varying(40),
    reverses_id character varying(40),
    livemode boolean NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    receipt character varying(40),
    notes jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(16) NOT NULL,
    amount_paid bigint NOT NULL,
    attempts integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_orders_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_orders_valid_currency CHECK (((currency)::text = ANY ((ARRAY['INR'::character varying, 'USD'::character varying])::text[]))),
    CONSTRAINT ck_orders_valid_status CHECK (((status)::text = ANY ((ARRAY['created'::character varying, 'attempted'::character varying, 'paid'::character varying])::text[])))
);


--
-- Name: payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_events (
    id bigint NOT NULL,
    payment_id character varying(40) NOT NULL,
    source character varying(16) NOT NULL,
    type character varying(64) NOT NULL,
    junction_event_id character varying(64),
    sequence integer,
    applied boolean NOT NULL,
    note character varying(300),
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.payment_events ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.payment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id character varying(40) NOT NULL,
    order_id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    method character varying(16) NOT NULL,
    capture_mode character varying(16) NOT NULL,
    status character varying(16) NOT NULL,
    card_network character varying(16),
    card_bin character varying(8),
    card_last4 character varying(4),
    card_expiry_month integer,
    card_expiry_year integer,
    vpa character varying(256),
    bank_code character varying(16),
    instrument_fingerprint character varying(64) NOT NULL,
    customer_email character varying(320),
    junction_ref character varying(20),
    junction_sequence integer NOT NULL,
    test_scenario character varying(64),
    error_code character varying(64),
    error_description character varying(300),
    risk_decision character varying(8) NOT NULL,
    risk_score integer NOT NULL,
    risk_reasons jsonb DEFAULT '[]'::jsonb NOT NULL,
    risk_review_status character varying(16) NOT NULL,
    risk_reviewed_by character varying(40),
    risk_reviewed_at timestamp with time zone,
    fee bigint,
    tax bigint,
    authorized_at timestamp with time zone,
    captured_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_payments_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_payments_valid_capture_mode CHECK (((capture_mode)::text = ANY ((ARRAY['automatic'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT ck_payments_valid_currency CHECK (((currency)::text = ANY ((ARRAY['INR'::character varying, 'USD'::character varying])::text[]))),
    CONSTRAINT ck_payments_valid_method CHECK (((method)::text = ANY ((ARRAY['card'::character varying, 'upi'::character varying, 'netbanking'::character varying])::text[]))),
    CONSTRAINT ck_payments_valid_risk_decision CHECK (((risk_decision)::text = ANY ((ARRAY['allow'::character varying, 'review'::character varying, 'block'::character varying])::text[]))),
    CONSTRAINT ck_payments_valid_risk_review_status CHECK (((risk_review_status)::text = ANY ((ARRAY['not_required'::character varying, 'pending'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT ck_payments_valid_status CHECK (((status)::text = ANY ((ARRAY['created'::character varying, 'pending'::character varying, 'authorized'::character varying, 'captured'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: rate_limit_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_state (
    bucket character varying(120) NOT NULL,
    tat timestamp with time zone NOT NULL
);


--
-- Name: staff_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_audit_log (
    id bigint NOT NULL,
    staff_id character varying(40),
    staff_email character varying(320) NOT NULL,
    action character varying(64) NOT NULL,
    target_type character varying(40),
    target_id character varying(64),
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    request_id character varying(64),
    ip character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.staff_audit_log ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.staff_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: staff_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_sessions (
    id character varying(40) NOT NULL,
    staff_id character varying(40) NOT NULL,
    token_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip character varying(64),
    user_agent character varying(300)
);


--
-- Name: staff_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_users (
    id character varying(40) NOT NULL,
    email character varying(320) NOT NULL,
    full_name character varying(200) NOT NULL,
    role character varying(16) NOT NULL,
    password_hash character varying(200) NOT NULL,
    status character varying(16) NOT NULL,
    failed_logins integer NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_staff_users_valid_role CHECK (((role)::text = ANY ((ARRAY['ops'::character varying, 'finance'::character varying, 'security'::character varying, 'admin'::character varying])::text[]))),
    CONSTRAINT ck_staff_users_valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))
);


--
-- Name: stations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stations (
    id character varying(40) NOT NULL,
    legal_name character varying(200) NOT NULL,
    display_name character varying(100) NOT NULL,
    email character varying(320) NOT NULL,
    business_category character varying(4) NOT NULL,
    country character varying(2) NOT NULL,
    default_currency character varying(3) NOT NULL,
    status character varying(16) NOT NULL,
    suspended_reason character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kyc_status character varying(16) NOT NULL,
    settlement_schedule character varying(4) NOT NULL,
    fee_plan character varying(16) NOT NULL,
    auto_capture boolean NOT NULL,
    rate_limit_per_sec integer NOT NULL,
    rate_limit_burst integer NOT NULL,
    kyc_rejection_reason character varying(500),
    kyc_reviewed_by character varying(40),
    kyc_reviewed_at timestamp with time zone,
    webhook_url character varying(500),
    max_payment_amount bigint,
    CONSTRAINT ck_stations_ck_stations_mcc_format CHECK (((business_category)::text ~ '^[0-9]{4}$'::text)),
    CONSTRAINT ck_stations_ck_stations_valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[]))),
    CONSTRAINT ck_stations_rate_limit CHECK (((rate_limit_per_sec > 0) AND (rate_limit_burst > 0))),
    CONSTRAINT ck_stations_valid_fee_plan CHECK (((fee_plan)::text = ANY ((ARRAY['standard'::character varying, 'growth'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT ck_stations_valid_kyc CHECK (((kyc_status)::text = ANY ((ARRAY['pending'::character varying, 'verified'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT ck_stations_valid_settlement_schedule CHECK (((settlement_schedule)::text = ANY ((ARRAY['T+1'::character varying, 'T+2'::character varying, 'T+3'::character varying])::text[])))
);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: api_keys pk_api_keys; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT pk_api_keys PRIMARY KEY (id);


--
-- Name: conductor_blocklist pk_conductor_blocklist; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conductor_blocklist
    ADD CONSTRAINT pk_conductor_blocklist PRIMARY KEY (id);


--
-- Name: idempotency_keys pk_idempotency_keys; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT pk_idempotency_keys PRIMARY KEY (id);


--
-- Name: jobs pk_jobs; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT pk_jobs PRIMARY KEY (id);


--
-- Name: junction_authorizations pk_junction_authorizations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_authorizations
    ADD CONSTRAINT pk_junction_authorizations PRIMARY KEY (ref);


--
-- Name: ledger_accounts pk_ledger_accounts; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT pk_ledger_accounts PRIMARY KEY (id);


--
-- Name: ledger_balances pk_ledger_balances; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_balances
    ADD CONSTRAINT pk_ledger_balances PRIMARY KEY (account_id);


--
-- Name: ledger_postings pk_ledger_postings; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_postings
    ADD CONSTRAINT pk_ledger_postings PRIMARY KEY (id);


--
-- Name: ledger_transactions pk_ledger_transactions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT pk_ledger_transactions PRIMARY KEY (id);


--
-- Name: orders pk_orders; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT pk_orders PRIMARY KEY (id);


--
-- Name: payment_events pk_payment_events; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT pk_payment_events PRIMARY KEY (id);


--
-- Name: payments pk_payments; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT pk_payments PRIMARY KEY (id);


--
-- Name: rate_limit_state pk_rate_limit_state; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_state
    ADD CONSTRAINT pk_rate_limit_state PRIMARY KEY (bucket);


--
-- Name: staff_audit_log pk_staff_audit_log; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_audit_log
    ADD CONSTRAINT pk_staff_audit_log PRIMARY KEY (id);


--
-- Name: staff_sessions pk_staff_sessions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT pk_staff_sessions PRIMARY KEY (id);


--
-- Name: staff_users pk_staff_users; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_users
    ADD CONSTRAINT pk_staff_users PRIMARY KEY (id);


--
-- Name: stations pk_stations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stations
    ADD CONSTRAINT pk_stations PRIMARY KEY (id);


--
-- Name: api_keys uq_api_keys_secret_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT uq_api_keys_secret_hash UNIQUE (secret_hash);


--
-- Name: idempotency_keys uq_idempotency_keys_scope; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT uq_idempotency_keys_scope UNIQUE (station_id, livemode, key);


--
-- Name: jobs uq_jobs_dedupe_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT uq_jobs_dedupe_key UNIQUE (dedupe_key);


--
-- Name: junction_authorizations uq_junction_authorizations_payment_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_authorizations
    ADD CONSTRAINT uq_junction_authorizations_payment_id UNIQUE (payment_id);


--
-- Name: ledger_accounts uq_ledger_accounts_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_accounts
    ADD CONSTRAINT uq_ledger_accounts_code UNIQUE (code);


--
-- Name: ledger_transactions uq_ledger_transactions_idempotency_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT uq_ledger_transactions_idempotency_key UNIQUE (idempotency_key);


--
-- Name: payment_events uq_payment_events_junction_event_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT uq_payment_events_junction_event_id UNIQUE (junction_event_id);


--
-- Name: staff_sessions uq_staff_sessions_token_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT uq_staff_sessions_token_hash UNIQUE (token_hash);


--
-- Name: ix_api_keys_station_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_api_keys_station_id ON public.api_keys USING btree (station_id);


--
-- Name: ix_jobs_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_jobs_claimable ON public.jobs USING btree (queue, run_at) WHERE ((status)::text = 'queued'::text);


--
-- Name: ix_jobs_running_locked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_jobs_running_locked_at ON public.jobs USING btree (locked_at) WHERE ((status)::text = 'running'::text);


--
-- Name: ix_ledger_accounts_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_accounts_owner_id ON public.ledger_accounts USING btree (owner_id);


--
-- Name: ix_ledger_postings_account_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_postings_account_id_id ON public.ledger_postings USING btree (account_id, id);


--
-- Name: ix_ledger_postings_transaction_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_postings_transaction_id ON public.ledger_postings USING btree (transaction_id);


--
-- Name: ix_ledger_transactions_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_ledger_transactions_reference ON public.ledger_transactions USING btree (reference_type, reference_id);


--
-- Name: ix_orders_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_orders_station_mode_id ON public.orders USING btree (station_id, livemode, id);


--
-- Name: ix_payment_events_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payment_events_payment_id ON public.payment_events USING btree (payment_id);


--
-- Name: ix_payments_fingerprint_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_fingerprint_created ON public.payments USING btree (instrument_fingerprint, created_at);


--
-- Name: ix_payments_junction_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_junction_ref ON public.payments USING btree (junction_ref);


--
-- Name: ix_payments_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_order_id ON public.payments USING btree (order_id);


--
-- Name: ix_payments_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_station_mode_id ON public.payments USING btree (station_id, livemode, id);


--
-- Name: ix_staff_audit_log_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_staff_audit_log_staff_id ON public.staff_audit_log USING btree (staff_id);


--
-- Name: ix_staff_audit_log_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_staff_audit_log_target ON public.staff_audit_log USING btree (target_type, target_id);


--
-- Name: ix_staff_sessions_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_staff_sessions_staff_id ON public.staff_sessions USING btree (staff_id);


--
-- Name: uq_conductor_blocklist_active_value; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_conductor_blocklist_active_value ON public.conductor_blocklist USING btree (kind, value) WHERE active;


--
-- Name: uq_ledger_transactions_reverses_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ledger_transactions_reverses_id ON public.ledger_transactions USING btree (reverses_id) WHERE (reverses_id IS NOT NULL);


--
-- Name: uq_payments_order_in_flight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payments_order_in_flight ON public.payments USING btree (order_id) WHERE ((status)::text <> 'failed'::text);


--
-- Name: uq_staff_users_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_staff_users_email_lower ON public.staff_users USING btree (lower((email)::text));


--
-- Name: uq_stations_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_stations_email_lower ON public.stations USING btree (lower((email)::text));


--
-- Name: ledger_postings ledger_postings_balanced; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ledger_postings_balanced AFTER INSERT ON public.ledger_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ledger_postings_balanced_trg();


--
-- Name: ledger_postings ledger_postings_currency_matches; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_postings_currency_matches BEFORE INSERT ON public.ledger_postings FOR EACH ROW EXECUTE FUNCTION public.ledger_posting_currency_matches_trg();


--
-- Name: ledger_postings ledger_postings_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_postings_immutable BEFORE DELETE OR UPDATE ON public.ledger_postings FOR EACH ROW EXECUTE FUNCTION public.ledger_forbid_mutation_trg();


--
-- Name: ledger_transactions ledger_transactions_has_postings; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER ledger_transactions_has_postings AFTER INSERT ON public.ledger_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ledger_transactions_has_postings_trg();


--
-- Name: ledger_transactions ledger_transactions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ledger_transactions_immutable BEFORE DELETE OR UPDATE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION public.ledger_forbid_mutation_trg();


--
-- Name: staff_audit_log staff_audit_log_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staff_audit_log_immutable BEFORE DELETE OR UPDATE ON public.staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.staff_audit_log_forbid_mutation_trg();


--
-- Name: api_keys fk_api_keys_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT fk_api_keys_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: ledger_balances fk_ledger_balances_account_id_ledger_accounts; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_balances
    ADD CONSTRAINT fk_ledger_balances_account_id_ledger_accounts FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: ledger_postings fk_ledger_postings_account_id_ledger_accounts; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_postings
    ADD CONSTRAINT fk_ledger_postings_account_id_ledger_accounts FOREIGN KEY (account_id) REFERENCES public.ledger_accounts(id) ON DELETE RESTRICT;


--
-- Name: ledger_postings fk_ledger_postings_transaction_id_ledger_transactions; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_postings
    ADD CONSTRAINT fk_ledger_postings_transaction_id_ledger_transactions FOREIGN KEY (transaction_id) REFERENCES public.ledger_transactions(id) ON DELETE RESTRICT;


--
-- Name: ledger_transactions fk_ledger_transactions_reverses_id_ledger_transactions; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT fk_ledger_transactions_reverses_id_ledger_transactions FOREIGN KEY (reverses_id) REFERENCES public.ledger_transactions(id);


--
-- Name: orders fk_orders_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: payment_events fk_payment_events_payment_id_payments; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT fk_payment_events_payment_id_payments FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;


--
-- Name: payments fk_payments_order_id_orders; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT fk_payments_order_id_orders FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;


--
-- Name: payments fk_payments_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT fk_payments_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: staff_sessions fk_staff_sessions_staff_id_staff_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT fk_staff_sessions_staff_id_staff_users FOREIGN KEY (staff_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict 9DSGnWVO8D5EXWbvTmgBEcxQSDBlbvO4obbkkzNUqXvdCIoMFjQYgXQJQ2IJWQT

