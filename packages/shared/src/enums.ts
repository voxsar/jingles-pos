export enum UserRole {
  CASHIER = 'CASHIER',
  SALESPERSON = 'SALESPERSON',
  MANAGER = 'MANAGER',
}

export enum ShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum SaleStatus {
  HELD = 'HELD',
  COMPLETED = 'COMPLETED',
  VOIDED = 'VOIDED',
  REFUNDED = 'REFUNDED',
  RECALLED = 'RECALLED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  VISA = 'VISA',
  MASTER = 'MASTER',
  AMEX = 'AMEX',
  CREDIT = 'CREDIT',
  GIFT = 'GIFT',
  SPLIT = 'SPLIT',
}

export enum CashCountMode {
  OPENING = 'OPENING',
  CLOSING = 'CLOSING',
}

export enum SyncEventType {
  SHIFT_OPENED = 'SHIFT_OPENED',
  SHIFT_CLOSED = 'SHIFT_CLOSED',
  CASH_DECLARED = 'CASH_DECLARED',
  HELD_SALE_SAVED = 'HELD_SALE_SAVED',
  HELD_SALE_RECALLED = 'HELD_SALE_RECALLED',
  SALE_COMPLETED = 'SALE_COMPLETED',
  SALE_VOIDED = 'SALE_VOIDED',
  RETURN_CREATED = 'RETURN_CREATED',
}

export enum SyncEventState {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export enum SyncConflictPolicy {
  LAST_WRITE_WINS = 'LAST_WRITE_WINS',
  SERVER_WINS = 'SERVER_WINS',
}

export enum SyncConflictStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}
