import {
  CompleteSaleInput,
  HeldSaleSummary,
  HoldSaleInput,
  POSBootstrap,
  Product,
  ReturnInput,
  SaleSummary,
  ShiftSummary,
  ShiftCloseInput,
  ShiftOpenInput,
  SyncStatusSummary,
  ZReportSummary,
} from '@jingles/shared';

declare global {
  interface Window {
    posAPI?: {
      bootstrap: (options?: { deviceId?: string; terminalId?: string }) => Promise<POSBootstrap>;
      searchProducts: (query: string) => Promise<Product[]>;
      getShift: (terminalId: string) => Promise<ShiftSummary | null>;
      openShift: (input: ShiftOpenInput) => Promise<ShiftSummary>;
      closeShift: (input: ShiftCloseInput & { terminalId?: string }) => Promise<ShiftSummary>;
      saveHeldSale: (input: Omit<HoldSaleInput, 'holdNumber'> & { holdNumber?: string }) => Promise<HeldSaleSummary>;
      listHeldSales: () => Promise<HeldSaleSummary[]>;
      recallHeldSale: (heldSaleId: string) => Promise<HeldSaleSummary>;
      createSale: (input: CompleteSaleInput) => Promise<SaleSummary>;
      listSales: () => Promise<SaleSummary[]>;
      getSale: (saleId: string) => Promise<SaleSummary>;
      createReturn: (input: ReturnInput) => Promise<{ id: string; saleId: string; totalRefund: number }>;
      getZReport: (shiftId: string) => Promise<ZReportSummary>;
      getSyncStatus: () => Promise<SyncStatusSummary>;
      syncNow: () => Promise<unknown>;
      onSyncStatus: (callback: (status: SyncStatusSummary) => void) => () => void;
    };
  }
}

export {};
