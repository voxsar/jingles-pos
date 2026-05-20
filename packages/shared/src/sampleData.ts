import { PaymentMethod, UserRole } from './enums';
import { Branch, Category, Customer, POSUser, Product, Terminal } from './types';

export const SAMPLE_BRANCHES: Branch[] = [
  { id: 'branch-jingles-01', code: '01', name: 'Jingles Main' },
];

export const SAMPLE_TERMINALS: Terminal[] = [
  { id: 'terminal-01', code: 'TERM-01', name: 'Front Counter 01', branchId: 'branch-jingles-01', branchCode: '01' },
  { id: 'terminal-02', code: 'TERM-02', name: 'Front Counter 02', branchId: 'branch-jingles-01', branchCode: '01' },
  { id: 'terminal-03', code: 'TERM-03', name: 'Wholesale Desk', branchId: 'branch-jingles-01', branchCode: '01' },
];

export const SAMPLE_USERS: POSUser[] = [
  { id: 'user-e1042', code: 'E1042', name: 'Muslim Abdullah', initials: 'MA', role: UserRole.CASHIER, pin: '1042' },
  { id: 'user-e1098', code: 'E1098', name: 'Fathima Rizwan', initials: 'FR', role: UserRole.CASHIER, pin: '1098' },
  { id: 'user-s001', code: 'S001', name: 'Pradeep Silva', initials: 'PS', role: UserRole.SALESPERSON },
  { id: 'user-s002', code: 'S002', name: 'Nimasha Perera', initials: 'NP', role: UserRole.SALESPERSON },
  { id: 'user-s003', code: 'S003', name: 'Ahmed Hassan', initials: 'AH', role: UserRole.SALESPERSON },
  { id: 'user-m001', code: 'M001', name: 'Manager One', initials: 'MO', role: UserRole.MANAGER, pin: '4321' },
];

export const SAMPLE_CUSTOMERS: Customer[] = [
  { id: 'cust-walk-in', code: 'C0001', name: 'Walk-in', tier: 'Retail' },
  { id: 'cust-c0102', code: 'C0102', name: 'Saman Kumara', tier: 'Retail', phone: '0771234567' },
  { id: 'cust-c0234', code: 'C0234', name: 'Rashmi Trading', tier: 'Wholesale', phone: '0719988776' },
  { id: 'cust-c0298', code: 'C0298', name: 'Jaya Stores', tier: 'Wholesale', phone: '0775544332' },
  { id: 'cust-c0411', code: 'C0411', name: 'Amila Fashions', tier: 'Wholesale', phone: '0726655443' },
];

export const SAMPLE_CATEGORIES: Category[] = [
  { id: 'cat-lace', name: 'Lace & Trims', icon: '◇', sortOrder: 1 },
  { id: 'cat-cosmetics', name: 'Cosmetics', icon: '◉', sortOrder: 2 },
  { id: 'cat-haircare', name: 'Hair Care', icon: '◊', sortOrder: 3 },
  { id: 'cat-accessories', name: 'Accessories', icon: '◈', sortOrder: 4 },
  { id: 'cat-fabric', name: 'Fabric', icon: '▦', sortOrder: 5 },
  { id: 'cat-baby', name: 'Baby & Kids', icon: '○', sortOrder: 6 },
  { id: 'cat-household', name: 'Household', icon: '□', sortOrder: 7 },
  { id: 'cat-stationery', name: 'Stationery', icon: '✎', sortOrder: 8 },
];

export const SAMPLE_PRODUCTS: Product[] = [
  {
    id: 'prod-1010005',
    sku: '1010005',
    name: 'GPO Lace Small',
    categoryId: 'cat-lace',
    subcategory: 'GPO Lace',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 240,
    priceTiers: [
      { id: 'tier-1010005-r30', label: 'Retail 30', price: 30, priority: 1, isDefault: true },
      { id: 'tier-1010005-r40', label: 'Retail 40', price: 40, priority: 2 },
      { id: 'tier-1010005-prem', label: 'Premium', price: 550, priority: 3 },
    ],
  },
  {
    id: 'prod-1010006',
    sku: '1010006',
    name: 'GPO Lace Medium',
    categoryId: 'cat-lace',
    subcategory: 'GPO Lace',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 135,
    priceTiers: [
      { id: 'tier-1010006-retail', label: 'Retail', price: 55, priority: 1, isDefault: true },
      { id: 'tier-1010006-wholesale', label: 'Wholesale', price: 48, priority: 2 },
    ],
  },
  {
    id: 'prod-2010001',
    sku: '2010001',
    name: 'Velvet Lipstick Rose',
    categoryId: 'cat-cosmetics',
    subcategory: 'Lipstick',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 142,
    priceTiers: [
      { id: 'tier-2010001-retail', label: 'Retail', price: 1850, priority: 1, isDefault: true },
      { id: 'tier-2010001-wholesale', label: 'Wholesale', price: 1450, priority: 2 },
    ],
  },
  {
    id: 'prod-2010002',
    sku: '2010002',
    name: 'Matte Lipstick Berry',
    categoryId: 'cat-cosmetics',
    subcategory: 'Lipstick',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 98,
    priceTiers: [
      { id: 'tier-2010002-retail', label: 'Retail', price: 1650, priority: 1, isDefault: true },
      { id: 'tier-2010002-wholesale', label: 'Wholesale', price: 1300, priority: 2 },
    ],
  },
  {
    id: 'prod-2010023',
    sku: '2010023',
    name: 'Liquid Foundation 30ml',
    categoryId: 'cat-cosmetics',
    subcategory: 'Foundation',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 64,
    priceTiers: [
      { id: 'tier-2010023-retail', label: 'Retail', price: 3450, priority: 1, isDefault: true },
      { id: 'tier-2010023-wholesale', label: 'Wholesale', price: 2900, priority: 2 },
    ],
  },
  {
    id: 'prod-2010044',
    sku: '2010044',
    name: 'Kohl Eyeliner Black',
    categoryId: 'cat-cosmetics',
    subcategory: 'Eyeliner',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 217,
    priceTiers: [
      { id: 'tier-2010044-retail', label: 'Retail', price: 750, priority: 1, isDefault: true },
      { id: 'tier-2010044-wholesale', label: 'Wholesale', price: 580, priority: 2 },
    ],
  },
  {
    id: 'prod-3010014',
    sku: '3010014',
    name: 'Argan Hair Oil 100ml',
    categoryId: 'cat-haircare',
    subcategory: 'Hair Oil',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 154,
    priceTiers: [
      { id: 'tier-3010014-retail', label: 'Retail', price: 1950, priority: 1, isDefault: true },
      { id: 'tier-3010014-wholesale', label: 'Wholesale', price: 1550, priority: 2 },
    ],
  },
  {
    id: 'prod-3010032',
    sku: '3010032',
    name: 'Keratin Shampoo 400ml',
    categoryId: 'cat-haircare',
    subcategory: 'Shampoo',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 88,
    priceTiers: [
      { id: 'tier-3010032-retail', label: 'Retail', price: 2850, priority: 1, isDefault: true },
      { id: 'tier-3010032-wholesale', label: 'Wholesale', price: 2350, priority: 2 },
    ],
  },
  {
    id: 'prod-3010057',
    sku: '3010057',
    name: 'Conditioner Smooth 400ml',
    categoryId: 'cat-haircare',
    subcategory: 'Conditioner',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 92,
    priceTiers: [
      { id: 'tier-3010057-retail', label: 'Retail', price: 2750, priority: 1, isDefault: true },
      { id: 'tier-3010057-wholesale', label: 'Wholesale', price: 2250, priority: 2 },
    ],
  },
  {
    id: 'prod-4010005',
    sku: '4010005',
    name: 'Pearl Hair Clip Set',
    categoryId: 'cat-accessories',
    subcategory: 'Hair Clips',
    packSize: 6,
    unitLabel: 'set',
    stockOnHand: 234,
    priceTiers: [
      { id: 'tier-4010005-retail', label: 'Retail', price: 650, priority: 1, isDefault: true },
      { id: 'tier-4010005-wholesale', label: 'Wholesale', price: 480, priority: 2 },
    ],
  },
  {
    id: 'prod-4010019',
    sku: '4010019',
    name: 'Silk Hair Band',
    categoryId: 'cat-accessories',
    subcategory: 'Bands',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 312,
    priceTiers: [
      { id: 'tier-4010019-retail', label: 'Retail', price: 350, priority: 1, isDefault: true },
      { id: 'tier-4010019-wholesale', label: 'Wholesale', price: 250, priority: 2 },
    ],
  },
  {
    id: 'prod-4010033',
    sku: '4010033',
    name: 'Drop Earrings Gold',
    categoryId: 'cat-accessories',
    subcategory: 'Earrings',
    packSize: 1,
    unitLabel: 'pair',
    stockOnHand: 67,
    priceTiers: [
      { id: 'tier-4010033-retail', label: 'Retail', price: 1450, priority: 1, isDefault: true },
      { id: 'tier-4010033-wholesale', label: 'Wholesale', price: 1100, priority: 2 },
    ],
  },
  {
    id: 'prod-5010008',
    sku: '5010008',
    name: 'Cotton Fabric Floral',
    categoryId: 'cat-fabric',
    subcategory: 'Cotton',
    packSize: 1,
    unitLabel: 'm',
    stockOnHand: 423,
    priceTiers: [
      { id: 'tier-5010008-retail', label: 'Retail', price: 480, priority: 1, isDefault: true },
      { id: 'tier-5010008-wholesale', label: 'Wholesale', price: 380, priority: 2 },
      { id: 'tier-5010008-bulk', label: 'Bulk 50m+', price: 320, priority: 3, minQty: 50 },
    ],
  },
  {
    id: 'prod-5010024',
    sku: '5010024',
    name: 'Silk Blend Fabric',
    categoryId: 'cat-fabric',
    subcategory: 'Silk',
    packSize: 1,
    unitLabel: 'm',
    stockOnHand: 187,
    priceTiers: [
      { id: 'tier-5010024-retail', label: 'Retail', price: 1850, priority: 1, isDefault: true },
      { id: 'tier-5010024-wholesale', label: 'Wholesale', price: 1450, priority: 2 },
    ],
  },
  {
    id: 'prod-6010003',
    sku: '6010003',
    name: 'Baby Powder 400g',
    categoryId: 'cat-baby',
    subcategory: 'Powder',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 104,
    priceTiers: [
      { id: 'tier-6010003-retail', label: 'Retail', price: 850, priority: 1, isDefault: true },
      { id: 'tier-6010003-wholesale', label: 'Wholesale', price: 680, priority: 2 },
    ],
  },
  {
    id: 'prod-6010018',
    sku: '6010018',
    name: 'Diapers Medium 30s',
    categoryId: 'cat-baby',
    subcategory: 'Diapers',
    packSize: 30,
    unitLabel: 'pack',
    stockOnHand: 56,
    priceTiers: [
      { id: 'tier-6010018-retail', label: 'Retail', price: 2450, priority: 1, isDefault: true },
      { id: 'tier-6010018-wholesale', label: 'Wholesale', price: 2100, priority: 2 },
    ],
  },
  {
    id: 'prod-7010012',
    sku: '7010012',
    name: 'Floor Cleaner 1L',
    categoryId: 'cat-household',
    subcategory: 'Cleaning',
    packSize: 1,
    unitLabel: 'bottle',
    stockOnHand: 78,
    priceTiers: [
      { id: 'tier-7010012-retail', label: 'Retail', price: 680, priority: 1, isDefault: true },
      { id: 'tier-7010012-wholesale', label: 'Wholesale', price: 540, priority: 2 },
    ],
  },
  {
    id: 'prod-8010004',
    sku: '8010004',
    name: 'Notebook A4 Ruled',
    categoryId: 'cat-stationery',
    subcategory: 'Notebooks',
    packSize: 1,
    unitLabel: 'pcs',
    stockOnHand: 256,
    priceTiers: [
      { id: 'tier-8010004-retail', label: 'Retail', price: 320, priority: 1, isDefault: true },
      { id: 'tier-8010004-wholesale', label: 'Wholesale', price: 250, priority: 2 },
    ],
  },
];

export const DEFAULT_DEVICE_ID = 'device-term-03';
export const DEFAULT_TERMINAL_ID = 'terminal-03';
export const DEFAULT_CASHIER_ID = 'user-e1042';
export const DEFAULT_CUSTOMER_ID = 'cust-walk-in';
export const DEFAULT_PAYMENT_METHOD = PaymentMethod.CASH;
