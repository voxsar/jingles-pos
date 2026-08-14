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
  INSTALLMENT = 'INSTALLMENT',
  /** @deprecated Multi-source payments are now the default payment flow. */
  SPLIT = 'SPLIT',
}

export enum CashCountMode {
  OPENING = 'OPENING',
  CLOSING = 'CLOSING',
  /** Cash added to the drawer mid-shift: a change reload or a float top-up. */
  PAID_IN = 'PAID_IN',
  /** Cash removed from the drawer mid-shift: a safe drop, payout or banking. */
  PAID_OUT = 'PAID_OUT',
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
  CUSTOMER_UPSERTED = 'CUSTOMER_UPSERTED',
  CREDIT_PAYMENT_RECORDED = 'CREDIT_PAYMENT_RECORDED',
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
