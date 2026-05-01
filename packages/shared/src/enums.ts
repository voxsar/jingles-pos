export enum InventoryState {
  ShelfReady = 'ShelfReady',
  Reserved = 'Reserved',
  Sold = 'Sold',
  Returned = 'Returned',
}

export enum InventoryEventType {
  RECEIVED = 'RECEIVED',
  ADJUSTED = 'ADJUSTED',
  SALE_DEDUCTED = 'SALE_DEDUCTED',
  RETURNED = 'RETURNED',
  RESERVED = 'RESERVED',
  RELEASED = 'RELEASED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  MIXED = 'MIXED',
}

export enum SaleStatus {
  DRAFT = 'DRAFT',
  COMPLETED = 'COMPLETED',
  VOIDED = 'VOIDED',
  RETURNED = 'RETURNED',
  PARTIALLY_RETURNED = 'PARTIALLY_RETURNED',
}

export enum ShiftStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum SyncOperationType {
  CREATE_SALE = 'CREATE_SALE',
  CREATE_RETURN = 'CREATE_RETURN',
  OPEN_SHIFT = 'OPEN_SHIFT',
  CLOSE_SHIFT = 'CLOSE_SHIFT',
}

export enum SyncStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  SYNCED = 'SYNCED',
  FAILED = 'FAILED',
}
