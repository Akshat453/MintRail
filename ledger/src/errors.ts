import { ErrorCode, MintRailError } from "@mintrail/shared";

export class LedgerError extends MintRailError {}
export class UnbalancedTransactionError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.UNBALANCED_TRANSACTION;
}
export class InsufficientBalanceError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.INSUFFICIENT_BALANCE;
}
export class AccountNotFoundError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.LEDGER_ACCOUNT_NOT_FOUND;
}
export class AccountExistsError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.LEDGER_ACCOUNT_EXISTS;
}
export class TransactionNotFoundError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.LEDGER_TRANSACTION_NOT_FOUND;
}
export class AlreadyReversedError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.ALREADY_REVERSED;
}
export class IdempotencyConflictError extends LedgerError {
  static override defaultCode: ErrorCode = ErrorCode.IDEMPOTENCY_KEY_REUSED;
}
