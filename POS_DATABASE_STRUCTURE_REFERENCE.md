# POS Database Structure Reference (Legacy + Current)

This document combines:

1. **Legacy Inventory + POS MySQL structure** (embedded as a complete table index in this document)
2. **Current Jingles schema mapping** (embedded in this document)

Use this as a **single schema index** for AI-assisted POS implementation planning.

---

## Standalone Reference Note

This is a **self-contained structure index** (all tables/models needed for architectural reference).

---

## Current Jingles Schema (Prisma) — 42 Models

Model → physical table mapping:

- `User` → `users`
- `Vendor` → `vendors`
- `Category` → `categories`
- `Tag` → `tags`
- `UnitOfMeasure` → `units_of_measure`
- `Branch` → `branches`
- `SKU` → `skus`
- `SKUVendor` → `sku_vendors`
- `SKUTag` → `sku_tags`
- `Attribute` → `attributes`
- `AttributeValue` → `attribute_values`
- `SKUAttribute` → `sku_attributes`
- `SKUAttributeValue` → `sku_attribute_values`
- `SKUVariant` → `sku_variants`
- `SKUVariantValue` → `sku_variant_values`
- `ProductImage` → `product_images`
- `ProductBarcode` → `product_barcodes`
- `Floor` → `floors`
- `Rack` → `racks`
- `Shelf` → `shelves`
- `StorageBox` → `storage_boxes`
- `BoxBarcode` → `box_barcodes`
- `StockTransfer` → `stock_transfers`
- `StockTransferLine` → `stock_transfer_lines`
- `InventoryRecord` → `inventory_records`
- `InventoryEvent` → `inventory_events`
- `GRN` → `grns`
- `Batch` → `batches`
- `PricingOverlay` → `pricing_overlays`
- `GRNLine` → `grn_lines`
- `InspectionRecord` → `inspection_records`
- `PRN` → `prns`
- `PRNLine` → `prn_lines`
- `ImportJob` → `import_jobs`
- `ImportRecord` → `import_records`
- `AuditLog` → `audit_logs`
- `SyncOperationLog` → `sync_operation_log`
- `SyncConflict` → `sync_conflicts`
- `SyncServerSequence` → `sync_server_sequence`
- `SyncServerChange` → `sync_server_changes`
- `StatusOption` → `status_options`
- `DashboardStats` → `dashboard_stats`

---

## Legacy MySQL Schema (Inventory + POS) — 174 Tables

All tables are included below as the legacy structure reference:

- `__migrationhistory`
- `adjustmentdetail`
- `adjustmentheader`
- `adjustmenttype`
- `advancepayment`
- `advancetransaction`
- `apacksize`
- `bank`
- `bankbin`
- `basketanalysisvaluerange`
- `billentrydetail`
- `billentryheader`
- `bincard`
- `cashier`
- `cashierfunction`
- `cashiergroup`
- `cashierpermission`
- `cashierpermissionsync`
- `cashierprivilegeslocation`
- `cashierprivilegeslocationsync`
- `cashiersync`
- `category`
- `categorysync`
- `chequebookentry`
- `chequedetail`
- `chequeprintdetail`
- `colour`
- `company`
- `configurations`
- `costcode`
- `creditnote`
- `creditnotesettlement`
- `customer`
- `customergroup`
- `customerintake`
- `customersync`
- `customertransaction`
- `department`
- `departmentsync`
- `designation`
- `discounttype`
- `documentnumber`
- `employee`
- `employeesync`
- `employeetransaction`
- `formdetails`
- `giftvoucher`
- `giftvoucherbook`
- `giftvouchergroup`
- `hourlysales`
- `images`
- `installmentdetail`
- `installmentheader`
- `invoicedetail`
- `invoiceheader`
- `jobcard`
- `jobcardreport`
- `jobcategory`
- `jobtype`
- `location`
- `locationtemp`
- `loyaltycardmaster`
- `loyaltycustomer`
- `loyaltymessage`
- `loyaltytransaction`
- `loyaltytype`
- `mailconfigure`
- `movement`
- `openingbalancedetail`
- `openingbalanceheader`
- `ordernote`
- `packetproductdetail`
- `packetproductheader`
- `packetproductmaster`
- `paidintype`
- `paidouttype`
- `payment`
- `paymentmode`
- `posconfig`
- `posdetail`
- `pospayment`
- `pospaymenttype`
- `pospaymentxsale`
- `postransaction`
- `postransactionxsale`
- `pricechangedetail`
- `pricechangegrnwise`
- `pricechangeheader`
- `pricelevel`
- `pricelevelsync`
- `pricelink`
- `pricelinksync`
- `product`
- `productcolorsize`
- `productcolorsizedetail`
- `productdetail`
- `productdetailsync`
- `productdiscount`
- `productlink`
- `productlinksync`
- `productserial`
- `productsync`
- `producttype`
- `promotion`
- `promotionbankbin`
- `promotionbuyx`
- `promotionbuyxsync`
- `promotiongety`
- `promotiongetysync`
- `promotionlocation`
- `promotionlocationsync`
- `promotionproduct`
- `promotionproductsync`
- `promotionsubtotal`
- `promotionsubtotalproductissue`
- `promotionsubtotalsync`
- `promotionsync`
- `promotiontype`
- `purchasedetail`
- `purchaseheader`
- `purchaseqty`
- `purchasetype`
- `reference`
- `reportsummary`
- `returnchequedetail`
- `returntype`
- `route`
- `salesperson`
- `salespersonsync`
- `salessummary`
- `salesviewer`
- `scaleproduct`
- `size`
- `statements`
- `stock`
- `stockverificationdetail`
- `stockverificationheader`
- `stockverificationpd`
- `stockverificationpos`
- `subcategory1`
- `subcategory2`
- `subcategory3`
- `supplier`
- `supplierdiscount`
- `suppliergroup`
- `supplierlink`
- `suppliersync`
- `synclog`
- `tax`
- `tempadjustment`
- `tempinvoice`
- `temppayment`
- `temppricechange`
- `tempproduct`
- `temppurchase`
- `tempstockverification`
- `temptransaction`
- `temptransfernote`
- `tempverificationproductserial`
- `thirdpartycheques`
- `transactionlog`
- `transferacceptednotedetail`
- `transferacceptednoteheader`
- `transfernotedetail`
- `transfernoteheader`
- `unitconvertor`
- `unitofmeasure`
- `usergroup`
- `usergroupprivilege`
- `userprivilege`
- `userprivilegeslocation`
- `userrights`
- `users`
- `warranty`

---

## Legacy POS-Critical Table Cluster (Recommended Initial Focus)

For POS development, prioritize these legacy tables first:

### Sales transaction core
- `postransaction`
- `postransactionxsale`
- `posdetail`
- `invoiceheader`
- `invoicedetail`
- `ordernote`

### Payments / settlement
- `pospayment`
- `pospaymenttype`
- `pospaymentxsale`
- `paymentmode`
- `advancepayment`
- `creditnote`
- `creditnotesettlement`

### Product / price / stock
- `product`
- `productdetail`
- `productserial`
- `pricelevel`
- `pricelink`
- `promotion*` tables
- `stock`
- `movement`
- `bincard`

### Customer / loyalty
- `customer`
- `customergroup`
- `customertransaction`
- `loyaltycustomer`
- `loyaltytransaction`
- `loyaltycardmaster`

### Cashier / auth / permissions
- `cashier`
- `cashierpermission`
- `cashiergroup`
- `usergroup`
- `userprivilege`

### Device / config / operations
- `posconfig`
- `configurations`
- `documentnumber`
- `hourlysales`
- `salessummary`
- `reportsummary`
- `transactionlog`

---

## High-Level Mapping Guidance (Legacy → Current)

This is the most practical starting map for a new POS implementation in this repo:

- Legacy `product*`, `price*`, `promotion*` → current `skus`, `batches`, `pricing_overlays`, `product_barcodes`
- Legacy `stock`, `movement`, `bincard` → current `inventory_records`, `inventory_events`
- Legacy `location` → current `branches` + `floors` + `shelves` + `storage_boxes`
- Legacy supplier/customer ecosystems → current `vendors` plus new POS customer models (to be added)
- Legacy cashier/user rights tables → current `users` + role model (expand with POS permission granularity if needed)

---

## AI Build Notes

When using this reference to build POS modules:

1. Treat the **Current Jingles Schema (Prisma) section in this document** as the canonical baseline.
2. Treat the **Legacy MySQL table index in this document** as the compatibility baseline.
3. Build POS features by:
   - preserving legacy business behavior,
   - mapping to current event-sourced inventory concepts,
   - adding missing POS domain models in Prisma where required.

---

## Optional Next Step

If needed, generate a second file with **full column-level details for all 174 legacy tables** plus inferred FK candidates and modern Prisma mapping suggestions for each table.
