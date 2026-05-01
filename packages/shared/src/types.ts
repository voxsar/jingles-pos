import {
  InventoryState,
  InventoryEventType,
  PaymentMethod,
  SaleStatus,
  ShiftStatus,
  SyncOperationType,
  SyncStatus,
} from './enums';

export interface Product {
  id: string;
  sku: string;
  name: string;
  barcode?: string;
  price: number;
  batchPrices?: BatchPrice[];
}

export interface BatchPrice {
  minQty: number;
  price: number;
}

export interface CartLine {
  productId: string;
  sku: string;
  name: string;
  barcode?: string;
  unitPrice: number;
  quantity: number;
  discountAmount: number;
  lineTotal: number;
}

export interface SaleLinePayload {
  productId: string;
  sku: string;
  name: string;
  barcode?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  lineTotal: number;
}

export interface PaymentPayload {
  method: PaymentMethod;
  amount: number;
  cashReceived?: number;
  changeDue?: number;
  reference?: string;
}

export interface CreateSalePayload {
  receiptNumber: string;
  terminalId: string;
  branchId?: string;
  userId: string;
  customerId?: string;
  shiftId?: string;
  lines: SaleLinePayload[];
  payment: PaymentPayload;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  offlineId?: string;
}

export interface SaleResponse {
  id: string;
  receiptNumber: string;
  status: SaleStatus;
  createdAt: string;
  lines: SaleLinePayload[];
  payment: PaymentPayload;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  synced: boolean;
}

export interface CreateReturnPayload {
  saleId: string;
  lines: ReturnLinePayload[];
  reason?: string;
  userId: string;
  terminalId: string;
}

export interface ReturnLinePayload {
  saleLineId: string;
  productId: string;
  quantity: number;
  refundAmount: number;
}

export interface ShiftPayload {
  terminalId: string;
  branchId?: string;
  userId: string;
  openingFloat?: number;
  closingFloat?: number;
  notes?: string;
}

export interface POSSyncOperation {
  id: string;
  type: SyncOperationType;
  status: SyncStatus;
  payload: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
}
