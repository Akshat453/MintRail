--
-- PostgreSQL database dump
--

\restrict b5YTwxYgacKv3L83JXoCkbL9B7gfDr2pbTgPi4sKrjNyYbwgTtcza5KKiLPDWLp

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
-- Name: m2_forbid_mutation_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.m2_forbid_mutation_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;


--
-- Name: outbox_events_notify_trg(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outbox_events_notify_trg() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('mintrail_outbox', NEW.id);
  RETURN NULL;
END;
$$;


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
-- Name: dashboard_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_sessions (
    id character varying(40) NOT NULL,
    user_id character varying(40) NOT NULL,
    token_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip character varying(64),
    user_agent character varying(300)
);


--
-- Name: dashboard_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_users (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
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
    CONSTRAINT ck_dashboard_users_valid_role CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'developer'::character varying, 'viewer'::character varying])::text[]))),
    CONSTRAINT ck_dashboard_users_valid_status CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'disabled'::character varying])::text[])))
);


--
-- Name: derailment_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derailment_notes (
    id bigint NOT NULL,
    derailment_id character varying(40) NOT NULL,
    staff_id character varying(40) NOT NULL,
    body character varying(4000) NOT NULL,
    status_change character varying(16),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: derailment_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.derailment_notes ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.derailment_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: derailments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derailments (
    id character varying(40) NOT NULL,
    title character varying(200) NOT NULL,
    severity character varying(8) NOT NULL,
    status character varying(16) NOT NULL,
    summary character varying(2000) NOT NULL,
    affected jsonb DEFAULT '[]'::jsonb NOT NULL,
    commander_id character varying(40) NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_derailments_valid_severity CHECK (((severity)::text = ANY ((ARRAY['sev1'::character varying, 'sev2'::character varying, 'sev3'::character varying, 'sev4'::character varying])::text[]))),
    CONSTRAINT ck_derailments_valid_status CHECK (((status)::text = ANY ((ARRAY['investigating'::character varying, 'mitigated'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: dispute_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispute_evidence (
    id character varying(40) NOT NULL,
    dispute_id character varying(40) NOT NULL,
    kind character varying(32) NOT NULL,
    filename character varying(200) NOT NULL,
    content_type character varying(64) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 character varying(64) NOT NULL,
    content bytea NOT NULL,
    uploaded_by character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_dispute_evidence_size CHECK ((size_bytes > 0)),
    CONSTRAINT ck_dispute_evidence_valid_kind CHECK (((kind)::text = ANY ((ARRAY['receipt'::character varying, 'shipping_proof'::character varying, 'customer_communication'::character varying, 'refund_policy'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disputes (
    id character varying(40) NOT NULL,
    payment_id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    reason character varying(32) NOT NULL,
    status character varying(16) NOT NULL,
    junction_ref character varying(20) NOT NULL,
    evidence_due_by timestamp with time zone NOT NULL,
    evidence_text character varying(5000),
    evidence_submitted_at timestamp with time zone,
    outcome_reason character varying(200),
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_disputes_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_disputes_valid_status CHECK (((status)::text = ANY ((ARRAY['needs_response'::character varying, 'under_review'::character varying, 'won'::character varying, 'lost'::character varying])::text[])))
);


--
-- Name: fx_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fx_rates (
    id character varying(40) NOT NULL,
    base character varying(3) NOT NULL,
    quote character varying(3) NOT NULL,
    rate numeric(20,10) NOT NULL,
    source character varying(40) NOT NULL,
    as_of timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_fx_rates_positive CHECK ((rate > (0)::numeric))
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
-- Name: junction_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.junction_disputes (
    ref character varying(20) NOT NULL,
    auth_ref character varying(20) NOT NULL,
    payment_id character varying(40) NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    reason character varying(32) NOT NULL,
    scenario character varying(64),
    status character varying(24) NOT NULL,
    evidence_count integer NOT NULL,
    due_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_junction_disputes_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_junction_disputes_valid_status CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'evidence_submitted'::character varying, 'won'::character varying, 'lost'::character varying])::text[])))
);


--
-- Name: junction_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.junction_inbox (
    event_id character varying(64) NOT NULL,
    type character varying(64) NOT NULL,
    outcome character varying(16) NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: junction_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.junction_payouts (
    ref character varying(20) NOT NULL,
    payout_id character varying(40) NOT NULL,
    amount bigint NOT NULL,
    mode character varying(8) NOT NULL,
    destination character varying(64) NOT NULL,
    scenario character varying(64),
    status character varying(16) NOT NULL,
    utr character varying(22),
    failure_reason character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_junction_payouts_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_junction_payouts_valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: junction_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.junction_refunds (
    ref character varying(20) NOT NULL,
    refund_id character varying(40) NOT NULL,
    auth_ref character varying(20) NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    speed character varying(8) NOT NULL,
    scenario character varying(64),
    status character varying(16) NOT NULL,
    failure_reason character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_junction_refunds_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_junction_refunds_valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
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
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id character varying(40) NOT NULL,
    seq bigint NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    type character varying(64) NOT NULL,
    data jsonb NOT NULL,
    dispatched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbox_events_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outbox_events ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.outbox_events_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
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
-- Name: payout_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_batches (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    filename character varying(200) NOT NULL,
    row_count integer NOT NULL,
    accepted_count integer NOT NULL,
    rejected_count integer NOT NULL,
    total_amount bigint NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payouts (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    batch_id character varying(40),
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    mode character varying(8) NOT NULL,
    purpose character varying(32) NOT NULL,
    beneficiary_name character varying(120) NOT NULL,
    account_number character varying(20),
    ifsc character varying(11),
    vpa character varying(256),
    reference character varying(40),
    narration character varying(30),
    status character varying(20) NOT NULL,
    junction_ref character varying(20),
    utr character varying(22),
    test_scenario character varying(64),
    failure_reason character varying(200),
    approved_by character varying(40),
    approved_at timestamp with time zone,
    rejected_reason character varying(500),
    processed_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_payouts_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_payouts_destination CHECK (((vpa IS NOT NULL) <> ((account_number IS NOT NULL) AND (ifsc IS NOT NULL)))),
    CONSTRAINT ck_payouts_valid_currency CHECK (((currency)::text = 'INR'::text)),
    CONSTRAINT ck_payouts_valid_mode CHECK (((mode)::text = ANY ((ARRAY['IMPS'::character varying, 'NEFT'::character varying, 'RTGS'::character varying, 'UPI'::character varying])::text[]))),
    CONSTRAINT ck_payouts_valid_status CHECK (((status)::text = ANY ((ARRAY['pending_approval'::character varying, 'queued'::character varying, 'processing'::character varying, 'processed'::character varying, 'failed'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: rate_limit_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_state (
    bucket character varying(120) NOT NULL,
    tat timestamp with time zone NOT NULL
);


--
-- Name: reconciliation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_items (
    id bigint NOT NULL,
    report_id character varying(40) NOT NULL,
    station_id character varying(40),
    livemode boolean,
    currency character varying(3),
    check_name character varying(40) NOT NULL,
    reference_id character varying(64),
    expected bigint,
    actual bigint,
    detail character varying(500)
);


--
-- Name: reconciliation_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.reconciliation_items ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.reconciliation_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: reconciliation_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reconciliation_reports (
    id character varying(40) NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    status character varying(16) NOT NULL,
    stations_checked integer NOT NULL,
    settlements_checked integer NOT NULL,
    mismatch_count integer NOT NULL,
    totals jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT ck_reconciliation_reports_valid_status CHECK (((status)::text = ANY ((ARRAY['ok'::character varying, 'mismatch'::character varying])::text[])))
);


--
-- Name: refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refunds (
    id character varying(40) NOT NULL,
    payment_id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    amount bigint NOT NULL,
    currency character varying(3) NOT NULL,
    status character varying(16) NOT NULL,
    reason character varying(32) NOT NULL,
    speed character varying(8) NOT NULL,
    fee bigint NOT NULL,
    tax bigint NOT NULL,
    notes jsonb DEFAULT '{}'::jsonb NOT NULL,
    junction_ref character varying(20),
    test_scenario character varying(64),
    error_code character varying(64),
    error_description character varying(300),
    processed_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_refunds_amount_positive CHECK ((amount > 0)),
    CONSTRAINT ck_refunds_fee_non_negative CHECK (((fee >= 0) AND (tax >= 0))),
    CONSTRAINT ck_refunds_valid_currency CHECK (((currency)::text = ANY ((ARRAY['INR'::character varying, 'USD'::character varying])::text[]))),
    CONSTRAINT ck_refunds_valid_speed CHECK (((speed)::text = ANY ((ARRAY['normal'::character varying, 'instant'::character varying])::text[]))),
    CONSTRAINT ck_refunds_valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: settlement_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_entries (
    id bigint NOT NULL,
    settlement_id character varying(40) NOT NULL,
    kind character varying(20) NOT NULL,
    reference_id character varying(64) NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    gross bigint NOT NULL,
    fee bigint NOT NULL,
    tax bigint NOT NULL,
    amount bigint NOT NULL,
    release_on date,
    CONSTRAINT ck_settlement_entries_amount_identity CHECK ((amount = ((gross - fee) - tax))),
    CONSTRAINT ck_settlement_entries_valid_kind CHECK (((kind)::text = ANY ((ARRAY['payment'::character varying, 'refund'::character varying, 'refund_reversal'::character varying, 'payout'::character varying, 'payout_reversal'::character varying, 'dispute_recovery'::character varying, 'dispute_release'::character varying, 'reserve_hold'::character varying, 'reserve_release'::character varying])::text[])))
);


--
-- Name: settlement_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.settlement_entries ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.settlement_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    currency character varying(3) NOT NULL,
    settlement_date date NOT NULL,
    schedule character varying(4) NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    entry_count integer NOT NULL,
    gross bigint NOT NULL,
    fees bigint NOT NULL,
    tax bigint NOT NULL,
    amount bigint NOT NULL,
    payout_currency character varying(3) NOT NULL,
    payout_amount bigint NOT NULL,
    fx_rate_id character varying(40),
    fx_rate numeric(20,10),
    status character varying(16) NOT NULL,
    utr character varying(22),
    ledger_transaction_id character varying(40),
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_settlements_amount_identity CHECK ((amount = ((gross - fees) - tax))),
    CONSTRAINT ck_settlements_amount_positive CHECK (((amount >= 0) AND (payout_amount >= 0))),
    CONSTRAINT ck_settlements_valid_status CHECK (((status)::text = ANY ((ARRAY['processing'::character varying, 'processed'::character varying, 'failed'::character varying])::text[])))
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
-- Name: station_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.station_policies (
    station_id character varying(40) NOT NULL,
    reserve_bps integer NOT NULL,
    reserve_hold_days integer NOT NULL,
    payout_daily_limit bigint NOT NULL,
    payout_approval_threshold bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_station_policies_payout_limits CHECK (((payout_daily_limit > 0) AND (payout_approval_threshold > 0))),
    CONSTRAINT ck_station_policies_reserve CHECK ((((reserve_bps >= 0) AND (reserve_bps <= 5000)) AND ((reserve_hold_days >= 0) AND (reserve_hold_days <= 180))))
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
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id character varying(40) NOT NULL,
    event_id character varying(40) NOT NULL,
    endpoint_id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    event_type character varying(64) NOT NULL,
    status character varying(16) NOT NULL,
    attempts integer NOT NULL,
    max_attempts integer NOT NULL,
    next_attempt_at timestamp with time zone,
    lease_until timestamp with time zone,
    last_status_code integer,
    last_error character varying(500),
    replay_of character varying(40),
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_webhook_deliveries_valid_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sending'::character varying, 'succeeded'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: webhook_delivery_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_delivery_attempts (
    id bigint NOT NULL,
    delivery_id character varying(40) NOT NULL,
    attempt integer NOT NULL,
    status_code integer,
    error character varying(500),
    duration_ms integer NOT NULL,
    response_excerpt character varying(500),
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_delivery_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.webhook_delivery_attempts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.webhook_delivery_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: webhook_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_endpoints (
    id character varying(40) NOT NULL,
    station_id character varying(40) NOT NULL,
    livemode boolean NOT NULL,
    url character varying(500) NOT NULL,
    description character varying(200),
    enabled_events character varying(64)[] NOT NULL,
    status character varying(16) NOT NULL,
    secret_enc bytea NOT NULL,
    secret_hint character varying(16) NOT NULL,
    previous_secret_enc bytea,
    previous_secret_expires_at timestamp with time zone,
    secret_rotated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_webhook_endpoints_valid_status CHECK (((status)::text = ANY ((ARRAY['enabled'::character varying, 'disabled'::character varying, 'deleted'::character varying])::text[])))
);


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
-- Name: dashboard_sessions pk_dashboard_sessions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_sessions
    ADD CONSTRAINT pk_dashboard_sessions PRIMARY KEY (id);


--
-- Name: dashboard_users pk_dashboard_users; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_users
    ADD CONSTRAINT pk_dashboard_users PRIMARY KEY (id);


--
-- Name: derailment_notes pk_derailment_notes; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derailment_notes
    ADD CONSTRAINT pk_derailment_notes PRIMARY KEY (id);


--
-- Name: derailments pk_derailments; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derailments
    ADD CONSTRAINT pk_derailments PRIMARY KEY (id);


--
-- Name: dispute_evidence pk_dispute_evidence; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_evidence
    ADD CONSTRAINT pk_dispute_evidence PRIMARY KEY (id);


--
-- Name: disputes pk_disputes; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT pk_disputes PRIMARY KEY (id);


--
-- Name: fx_rates pk_fx_rates; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fx_rates
    ADD CONSTRAINT pk_fx_rates PRIMARY KEY (id);


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
-- Name: junction_disputes pk_junction_disputes; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_disputes
    ADD CONSTRAINT pk_junction_disputes PRIMARY KEY (ref);


--
-- Name: junction_inbox pk_junction_inbox; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_inbox
    ADD CONSTRAINT pk_junction_inbox PRIMARY KEY (event_id);


--
-- Name: junction_payouts pk_junction_payouts; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_payouts
    ADD CONSTRAINT pk_junction_payouts PRIMARY KEY (ref);


--
-- Name: junction_refunds pk_junction_refunds; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_refunds
    ADD CONSTRAINT pk_junction_refunds PRIMARY KEY (ref);


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
-- Name: outbox_events pk_outbox_events; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT pk_outbox_events PRIMARY KEY (id);


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
-- Name: payout_batches pk_payout_batches; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT pk_payout_batches PRIMARY KEY (id);


--
-- Name: payouts pk_payouts; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT pk_payouts PRIMARY KEY (id);


--
-- Name: rate_limit_state pk_rate_limit_state; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_state
    ADD CONSTRAINT pk_rate_limit_state PRIMARY KEY (bucket);


--
-- Name: reconciliation_items pk_reconciliation_items; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_items
    ADD CONSTRAINT pk_reconciliation_items PRIMARY KEY (id);


--
-- Name: reconciliation_reports pk_reconciliation_reports; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_reports
    ADD CONSTRAINT pk_reconciliation_reports PRIMARY KEY (id);


--
-- Name: refunds pk_refunds; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT pk_refunds PRIMARY KEY (id);


--
-- Name: settlement_entries pk_settlement_entries; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT pk_settlement_entries PRIMARY KEY (id);


--
-- Name: settlements pk_settlements; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT pk_settlements PRIMARY KEY (id);


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
-- Name: station_policies pk_station_policies; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station_policies
    ADD CONSTRAINT pk_station_policies PRIMARY KEY (station_id);


--
-- Name: stations pk_stations; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stations
    ADD CONSTRAINT pk_stations PRIMARY KEY (id);


--
-- Name: webhook_deliveries pk_webhook_deliveries; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT pk_webhook_deliveries PRIMARY KEY (id);


--
-- Name: webhook_delivery_attempts pk_webhook_delivery_attempts; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_delivery_attempts
    ADD CONSTRAINT pk_webhook_delivery_attempts PRIMARY KEY (id);


--
-- Name: webhook_endpoints pk_webhook_endpoints; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT pk_webhook_endpoints PRIMARY KEY (id);


--
-- Name: api_keys uq_api_keys_secret_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT uq_api_keys_secret_hash UNIQUE (secret_hash);


--
-- Name: dashboard_sessions uq_dashboard_sessions_token_hash; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_sessions
    ADD CONSTRAINT uq_dashboard_sessions_token_hash UNIQUE (token_hash);


--
-- Name: disputes uq_disputes_junction_ref; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT uq_disputes_junction_ref UNIQUE (junction_ref);


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
-- Name: junction_payouts uq_junction_payouts_payout_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_payouts
    ADD CONSTRAINT uq_junction_payouts_payout_id UNIQUE (payout_id);


--
-- Name: junction_refunds uq_junction_refunds_refund_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.junction_refunds
    ADD CONSTRAINT uq_junction_refunds_refund_id UNIQUE (refund_id);


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
-- Name: settlement_entries uq_settlement_entries_item; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT uq_settlement_entries_item UNIQUE (kind, reference_id);


--
-- Name: settlements uq_settlements_batch; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT uq_settlements_batch UNIQUE (station_id, livemode, currency, settlement_date);


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
-- Name: ix_dashboard_sessions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_dashboard_sessions_user_id ON public.dashboard_sessions USING btree (user_id);


--
-- Name: ix_dashboard_users_station_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_dashboard_users_station_id ON public.dashboard_users USING btree (station_id);


--
-- Name: ix_derailment_notes_derailment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_derailment_notes_derailment_id ON public.derailment_notes USING btree (derailment_id);


--
-- Name: ix_dispute_evidence_dispute_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_dispute_evidence_dispute_id ON public.dispute_evidence USING btree (dispute_id);


--
-- Name: ix_disputes_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_disputes_payment_id ON public.disputes USING btree (payment_id);


--
-- Name: ix_disputes_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_disputes_station_mode_id ON public.disputes USING btree (station_id, livemode, id);


--
-- Name: ix_disputes_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_disputes_status_due ON public.disputes USING btree (status, evidence_due_by);


--
-- Name: ix_fx_rates_pair_as_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_fx_rates_pair_as_of ON public.fx_rates USING btree (base, quote, as_of);


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
-- Name: ix_outbox_events_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_outbox_events_station_mode_id ON public.outbox_events USING btree (station_id, livemode, id);


--
-- Name: ix_outbox_events_undispatched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_outbox_events_undispatched ON public.outbox_events USING btree (seq) WHERE (dispatched_at IS NULL);


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
-- Name: ix_payments_station_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_station_captured ON public.payments USING btree (station_id, livemode, captured_at) WHERE ((status)::text = 'captured'::text);


--
-- Name: ix_payments_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payments_station_mode_id ON public.payments USING btree (station_id, livemode, id);


--
-- Name: ix_payout_batches_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payout_batches_station_mode_id ON public.payout_batches USING btree (station_id, livemode, id);


--
-- Name: ix_payouts_station_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payouts_station_created ON public.payouts USING btree (station_id, livemode, created_at);


--
-- Name: ix_payouts_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payouts_station_mode_id ON public.payouts USING btree (station_id, livemode, id);


--
-- Name: ix_payouts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_payouts_status ON public.payouts USING btree (status);


--
-- Name: ix_reconciliation_items_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_reconciliation_items_report_id ON public.reconciliation_items USING btree (report_id);


--
-- Name: ix_refunds_payment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refunds_payment_id ON public.refunds USING btree (payment_id);


--
-- Name: ix_refunds_station_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refunds_station_created ON public.refunds USING btree (station_id, livemode, created_at);


--
-- Name: ix_refunds_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refunds_station_mode_id ON public.refunds USING btree (station_id, livemode, id);


--
-- Name: ix_settlement_entries_settlement_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_settlement_entries_settlement_id ON public.settlement_entries USING btree (settlement_id);


--
-- Name: ix_settlements_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_settlements_date ON public.settlements USING btree (settlement_date);


--
-- Name: ix_settlements_station_mode_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_settlements_station_mode_id ON public.settlements USING btree (station_id, livemode, id);


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
-- Name: ix_webhook_deliveries_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_deliveries_due ON public.webhook_deliveries USING btree (next_attempt_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: ix_webhook_deliveries_endpoint_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_deliveries_endpoint_id ON public.webhook_deliveries USING btree (endpoint_id, id);


--
-- Name: ix_webhook_deliveries_event_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_deliveries_event_id ON public.webhook_deliveries USING btree (event_id);


--
-- Name: ix_webhook_deliveries_station; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_deliveries_station ON public.webhook_deliveries USING btree (station_id, livemode, id);


--
-- Name: ix_webhook_delivery_attempts_delivery_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_delivery_attempts_delivery_id ON public.webhook_delivery_attempts USING btree (delivery_id);


--
-- Name: ix_webhook_endpoints_station_mode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_webhook_endpoints_station_mode ON public.webhook_endpoints USING btree (station_id, livemode);


--
-- Name: uq_conductor_blocklist_active_value; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_conductor_blocklist_active_value ON public.conductor_blocklist USING btree (kind, value) WHERE active;


--
-- Name: uq_dashboard_users_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_dashboard_users_email_lower ON public.dashboard_users USING btree (lower((email)::text));


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
-- Name: derailment_notes derailment_notes_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER derailment_notes_immutable BEFORE DELETE OR UPDATE ON public.derailment_notes FOR EACH ROW EXECUTE FUNCTION public.m2_forbid_mutation_trg();


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
-- Name: outbox_events outbox_events_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER outbox_events_notify AFTER INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.outbox_events_notify_trg();


--
-- Name: settlement_entries settlement_entries_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER settlement_entries_immutable BEFORE DELETE OR UPDATE ON public.settlement_entries FOR EACH ROW EXECUTE FUNCTION public.m2_forbid_mutation_trg();


--
-- Name: staff_audit_log staff_audit_log_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER staff_audit_log_immutable BEFORE DELETE OR UPDATE ON public.staff_audit_log FOR EACH ROW EXECUTE FUNCTION public.staff_audit_log_forbid_mutation_trg();


--
-- Name: webhook_delivery_attempts webhook_delivery_attempts_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER webhook_delivery_attempts_immutable BEFORE DELETE OR UPDATE ON public.webhook_delivery_attempts FOR EACH ROW EXECUTE FUNCTION public.m2_forbid_mutation_trg();


--
-- Name: api_keys fk_api_keys_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT fk_api_keys_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: dashboard_sessions fk_dashboard_sessions_user_id_dashboard_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_sessions
    ADD CONSTRAINT fk_dashboard_sessions_user_id_dashboard_users FOREIGN KEY (user_id) REFERENCES public.dashboard_users(id) ON DELETE RESTRICT;


--
-- Name: dashboard_users fk_dashboard_users_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_users
    ADD CONSTRAINT fk_dashboard_users_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: derailment_notes fk_derailment_notes_derailment_id_derailments; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derailment_notes
    ADD CONSTRAINT fk_derailment_notes_derailment_id_derailments FOREIGN KEY (derailment_id) REFERENCES public.derailments(id) ON DELETE RESTRICT;


--
-- Name: derailment_notes fk_derailment_notes_staff_id_staff_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derailment_notes
    ADD CONSTRAINT fk_derailment_notes_staff_id_staff_users FOREIGN KEY (staff_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;


--
-- Name: derailments fk_derailments_commander_id_staff_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derailments
    ADD CONSTRAINT fk_derailments_commander_id_staff_users FOREIGN KEY (commander_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;


--
-- Name: dispute_evidence fk_dispute_evidence_dispute_id_disputes; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_evidence
    ADD CONSTRAINT fk_dispute_evidence_dispute_id_disputes FOREIGN KEY (dispute_id) REFERENCES public.disputes(id) ON DELETE RESTRICT;


--
-- Name: disputes fk_disputes_payment_id_payments; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT fk_disputes_payment_id_payments FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;


--
-- Name: disputes fk_disputes_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT fk_disputes_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


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
-- Name: payout_batches fk_payout_batches_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_batches
    ADD CONSTRAINT fk_payout_batches_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: payouts fk_payouts_batch_id_payout_batches; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT fk_payouts_batch_id_payout_batches FOREIGN KEY (batch_id) REFERENCES public.payout_batches(id) ON DELETE RESTRICT;


--
-- Name: payouts fk_payouts_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT fk_payouts_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: reconciliation_items fk_reconciliation_items_report_id_reconciliation_reports; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reconciliation_items
    ADD CONSTRAINT fk_reconciliation_items_report_id_reconciliation_reports FOREIGN KEY (report_id) REFERENCES public.reconciliation_reports(id) ON DELETE CASCADE;


--
-- Name: refunds fk_refunds_payment_id_payments; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT fk_refunds_payment_id_payments FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;


--
-- Name: refunds fk_refunds_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT fk_refunds_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: settlement_entries fk_settlement_entries_settlement_id_settlements; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_entries
    ADD CONSTRAINT fk_settlement_entries_settlement_id_settlements FOREIGN KEY (settlement_id) REFERENCES public.settlements(id) ON DELETE RESTRICT;


--
-- Name: settlements fk_settlements_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT fk_settlements_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE RESTRICT;


--
-- Name: staff_sessions fk_staff_sessions_staff_id_staff_users; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_sessions
    ADD CONSTRAINT fk_staff_sessions_staff_id_staff_users FOREIGN KEY (staff_id) REFERENCES public.staff_users(id) ON DELETE RESTRICT;


--
-- Name: station_policies fk_station_policies_station_id_stations; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.station_policies
    ADD CONSTRAINT fk_station_policies_station_id_stations FOREIGN KEY (station_id) REFERENCES public.stations(id) ON DELETE CASCADE;


--
-- Name: webhook_deliveries fk_webhook_deliveries_endpoint_id_webhook_endpoints; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT fk_webhook_deliveries_endpoint_id_webhook_endpoints FOREIGN KEY (endpoint_id) REFERENCES public.webhook_endpoints(id) ON DELETE RESTRICT;


--
-- Name: webhook_deliveries fk_webhook_deliveries_event_id_outbox_events; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT fk_webhook_deliveries_event_id_outbox_events FOREIGN KEY (event_id) REFERENCES public.outbox_events(id) ON DELETE RESTRICT;


--
-- Name: webhook_delivery_attempts fk_webhook_delivery_attempts_delivery_id_webhook_deliveries; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_delivery_attempts
    ADD CONSTRAINT fk_webhook_delivery_attempts_delivery_id_webhook_deliveries FOREIGN KEY (delivery_id) REFERENCES public.webhook_deliveries(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict b5YTwxYgacKv3L83JXoCkbL9B7gfDr2pbTgPi4sKrjNyYbwgTtcza5KKiLPDWLp

