export type HelpImage = {
  src: string;
  caption: string;
};

export type HelpStep = {
  title: string;
  body: string;
  shortcut?: string;
  image?: HelpImage;
};

export type HelpShortcut = {
  keys: string;
  action: string;
};

export type HelpTopic = {
  id: string;
  kicker: string;
  title: string;
  summary: string;
  keywords: string[];
  intro: string;
  heroImage?: HelpImage;
  steps?: HelpStep[];
  tips?: string[];
  shortcuts?: HelpShortcut[];
};

function image(file: string, caption: string): HelpImage {
  return { src: `help/${file}`, caption };
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: 'getting-started',
    kicker: 'Basics',
    title: 'Sign in & enter the workstation',
    summary: 'Authenticate, pick a branch and terminal, and reach the billing screen.',
    keywords: ['login', 'sign in', 'password', 'email', 'employee code', 'terminal', 'branch', 'start'],
    intro:
      'Jingles POS uses the same accounts as the inventory system. Each workstation signs in once, then keeps the account cached locally so it can also be used offline.',
    steps: [
      {
        title: 'Sign in',
        body:
          'Enter your inventory email address (or your employee code, once the account has been cached on this workstation) together with your password, then press Sign in. On a brand-new workstation the very first sign-in must use the inventory email so the account can be downloaded.',
        image: image('login.png', 'The sign-in screen. First sign-in on a new workstation must use the inventory email.'),
      },
      {
        title: 'Choose branch and terminal',
        body:
          'After signing in you land on the workstation access screen. Pick the branch and the terminal this till is physically running on, then press Enter workstation. If another cashier already has a shift open on the terminal, a notice shows who opened it and when.',
        image: image('access.png', 'The workstation access screen with branch and terminal selectors.'),
      },
      {
        title: 'You are in',
        body:
          'The main billing screen opens with the product catalog on the left and the cart on the right. If no shift is open yet, the header shows a "No active shift" pill — open one before selling (see "Open & close a shift").',
        image: image('workstation.png', 'The main billing screen: catalog on the left, cart on the right, action bar along the bottom.'),
      },
    ],
    tips: [
      'Only cashier and manager accounts can enter the POS. Salesperson accounts exist for commission tracking only.',
      'Your session stays valid for seven days; signing out from the account menu ends it immediately.',
    ],
  },
  {
    id: 'shifts',
    kicker: 'Basics',
    title: 'Open & close a shift',
    summary: 'Declare the opening float, trade, then count the drawer and close.',
    keywords: ['shift', 'float', 'drawer', 'cash count', 'open', 'close', 'declaration', 'denominations', 'variance'],
    intro:
      'Every sale belongs to a shift. A shift records who was on the till, the opening float, every payment taken, and the closing cash count — which is what the Z-Report is built from.',
    steps: [
      {
        title: 'Open the shift',
        body:
          'Press the Cash button in the header (or the Open shift prompt if you try to sell without one). Count the cash in the drawer by entering how many of each note and coin you have — the modal adds up the declared total for you — then confirm. The shift is now open and the header shows its number and start time.',
        image: image('open-shift.png', 'The opening cash declaration: enter a count per denomination and confirm.'),
      },
      {
        title: 'Trade as normal',
        body:
          'All sales, holds, returns and payments you take are attached to your shift automatically. The header keeps a running "Today" revenue and bill count.',
      },
      {
        title: 'Move cash in or out mid-shift',
        body:
          'Press In / Out in the header when you reload change from the safe, top the float up, or drop takings out of the drawer. Count the notes and coins the same way and give a reason. The movement is added to the expected drawer, so reloading change no longer looks like a discrepancy at closing.',
      },
      {
        title: 'Close the shift',
        body:
          'Press Cash again at the end of the day. Count the drawer the same way; the closing screen shows the expected drawer built from the transaction log, every mid-shift movement, and the variance between them. If the terminal is set to collect non-cash tender you also enter the card and voucher totals, either as one figure or per payment type, and each is checked against the sales log. A large discrepancy is flagged before you can confirm.',
        image: image('close-shift.png', 'The closing count. The expected drawer amount is shown so variances are visible immediately.'),
      },
    ],
    tips: [
      'Open Reports from the account menu to browse open and closed sales slots by week, month, or year. Each slot runs from its actual opening to its close, including days that closed early.',
      'If the app is restarted mid-shift the open shift is detected and resumed automatically.',
      'A shift can still be closed when it is flagged — you acknowledge the discrepancy and it is recorded against the shift. Managers set the alert thresholds in Settings > Close-out reconciliation.',
    ],
  },
  {
    id: 'selling',
    kicker: 'Selling',
    title: 'Ring up a sale',
    summary: 'Find products in the catalog or search, build the cart, and adjust lines.',
    keywords: ['sale', 'sell', 'cart', 'product', 'catalog', 'category', 'quantity', 'line', 'add'],
    intro:
      'The left panel is the product catalog, organised by category and subcategory. The right panel is the live cart. Tap or click a product to add one unit; tap again to add more.',
    steps: [
      {
        title: 'Browse the catalog',
        body:
          'Pick a category tile to see its products, and use the subcategory chips to narrow the list. The divider between catalog and cart can be dragged if you want a wider catalog.',
        image: image('workstation.png', 'Category tiles and subcategory chips filter the product grid.'),
      },
      {
        title: 'Search when it is faster',
        body:
          'Press F3 or use the Search action to open full-catalog search. Type any part of the product name, SKU or barcode and pick a result to drop it straight into the cart.',
        shortcut: 'F3',
        image: image('search.png', 'The search overlay finds products by name, SKU or barcode.'),
      },
      {
        title: 'Fine-tune cart lines',
        body:
          'Each cart line lets you change the quantity, the price tier, the assigned salesperson, and a per-line discount. Remove a line with the x button — the void confirmation protects against accidental taps.',
        image: image('cart.png', 'A cart line expanded: quantity, tier, salesperson and line discount are all editable in place.'),
      },
    ],
    tips: [
      'Selling without an open shift is blocked — open the shift first.',
      'The cart survives accidental navigation, but use Hold (F4) if you need to park it deliberately.',
    ],
  },
  {
    id: 'variants',
    kicker: 'Selling',
    title: 'Products with variants',
    summary: 'Pick a colour, size or other option before the item lands in the cart.',
    keywords: ['variant', 'size', 'colour', 'color', 'option', 'attribute'],
    intro:
      'Some products come in several variants — for example a lace in different colours or widths. Variant products are marked in the catalog, and the variant picker opens automatically when you add one.',
    steps: [
      {
        title: 'Choose the variant',
        body:
          'When you tap a variant product, the selection modal lists every option with its own stock level. Pick the one the customer wants and confirm; the cart line records the exact variant.',
        image: image('variants.png', 'The variant picker: each option carries its own code and stock count.'),
      },
      {
        title: 'Change it later',
        body:
          'Made the wrong pick? Use the variant control on the cart line to reopen the picker — no need to remove and re-add the product.',
      },
    ],
  },
  {
    id: 'shortcuts',
    kicker: 'Selling',
    title: 'Keyboard shortcuts & quick keys',
    summary: 'Rebind the action bar and bind your fastest-selling products to a key.',
    keywords: [
      'shortcut', 'shortcuts', 'keyboard', 'key', 'rebind', 'remap', 'hotkey',
      'quick key', 'quick keys', 'function key', 'F-key',
    ],
    intro:
      'Every action on the bottom bar has a key binding, and each one can be changed per workstation in Settings > Shortcuts and product quick keys. The key cap printed on each button always shows the binding actually in force, so the bar never disagrees with the keyboard.',
    steps: [
      {
        title: 'Rebind an action',
        body:
          'Open Settings, find the action, click its key cap and press the combination you want. Press Backspace while recording to put the default back. If two things end up sharing a key the form says so.',
      },
      {
        title: 'Bind a product to a key',
        body:
          'In the same settings card, choose a product and record a key for it. Pressing that key on the workstation drops the product straight into the cart without searching. Turn the whole feature off with the Enable product quick keys switch.',
      },
    ],
    tips: [
      'Quick keys must use Ctrl or Alt, or a function key. Plain letters and digits stay reserved: a barcode scan delivers its first character before the app can tell it is a scan, so an unmodified quick key could ring up the wrong product.',
      'Escape always closes whatever window is open first. It only reaches the action bound to it — Void by default — when nothing is layered over the workstation.',
    ],
  },
  {
    id: 'customers-tiers',
    kicker: 'Selling',
    title: 'Customers & price tiers',
    summary: 'Attach a customer to the bill and control which price tier applies.',
    keywords: ['customer', 'walk-in', 'wholesale', 'retail', 'tier', 'price', 'batch price', 'F7'],
    intro:
      'Bills default to the Walk-in customer. Selecting a registered customer records the sale against their account and switches the default price tier to match their tier — wholesale customers get wholesale prices automatically.',
    steps: [
      {
        title: 'Pick the customer',
        body:
          'Press F7 or use the customer selector at the top of the cart — either one opens the list with the search box focused, so you can type a name straight away. The default tier dropdown next to it shows which price tier new lines will use. Once a bill is completed, held or voided the selector returns to Walk-in, so the next customer is never billed to the last one.',
        shortcut: 'F7',
        image: image('customer.png', 'The customer selector and the default tier control at the top of the cart.'),
      },
      {
        title: 'Override per line',
        body:
          'Each line can still use a different tier — change it on the line itself. Tier prices and minimum quantities come from the product’s batch price list in inventory.',
      },
    ],
  },
  {
    id: 'discounts',
    kicker: 'Selling',
    title: 'Discounts',
    summary: 'Per-line percentage discounts and a whole-bill discount.',
    keywords: ['discount', 'percent', 'reduction', 'F6', 'bill discount', 'line discount'],
    intro:
      'There are two levels of discount: a percentage on an individual cart line, and a bill-level discount applied to the subtotal.',
    steps: [
      {
        title: 'Bill discount',
        body:
          'Press F6 (or click the discount field in the cart footer) and type the percentage. The totals update immediately.',
        shortcut: 'F6',
        image: image('discount.png', 'The bill discount field in the cart footer, focused via F6.'),
      },
      {
        title: 'Line discount',
        body:
          'Open the line’s discount control and enter the percentage for just that item. Line discounts and the bill discount stack: line discounts apply first, then the bill discount on the remaining subtotal.',
      },
    ],
  },
  {
    id: 'hold-recall',
    kicker: 'Selling',
    title: 'Hold & recall bills',
    summary: 'Park a cart for later and bring it back on any terminal.',
    keywords: ['hold', 'recall', 'park', 'suspend', 'resume', 'F4', 'F5', 'held', 'quote', 'quotation', 'F9', 'estimate'],
    intro:
      'When a customer steps away — or you need the till for the next person in line — park the whole cart as a held bill instead of voiding it.',
    steps: [
      {
        title: 'Hold the current cart',
        body:
          'Press F4 (or the Hold action). The cart is saved with a hold number and the till is cleared for the next sale.',
        shortcut: 'F4',
        image: image('hold.png', 'Holding the current cart assigns it a hold number.'),
      },
      {
        title: 'Recall it',
        body:
          'Press F5 (or the Recall action) to list all held bills with their hold number, customer and total. Pick one to load it back into the cart, finish it and take payment as usual.',
        shortcut: 'F5',
        image: image('recall.png', 'The recall list shows every parked bill ready to resume.'),
      },
      {
        title: 'Print a quotation instead',
        body:
          'When the customer only wants a price, press F9 (or the Quote action) to print the cart as a quotation. Nothing is saved, no stock moves and no payment is recorded — the slip is clearly marked as a quotation and carries no receipt barcode.',
        shortcut: 'F9',
      },
    ],
    tips: ['A recalled bill keeps its customer, discounts and salesperson assignments exactly as they were held.'],
  },
  {
    id: 'payments',
    kicker: 'Checkout',
    title: 'Take payment & print the receipt',
    summary: 'Cash with change calculation, cards, credit, gift cards and split payments.',
    keywords: ['payment', 'pay', 'cash', 'card', 'visa', 'mastercard', 'amex', 'credit', 'gift card', 'split', 'change', 'tender', 'receipt', 'print', 'F8'],
    intro:
      'Press F8 (or the Pay button showing the running total) to open the payment modal. A sale can be settled with one method or split across several.',
    steps: [
      {
        title: 'Choose the method',
        body:
          'Pick Cash, Visa, Mastercard, Amex, Credit or Gift Card. For cash, enter the amount tendered and the change due is calculated for you, along with a few ways to hand it back by note and coin — and, when it helps, a suggestion to ask the customer for a little more so the change comes back as one note. Tapping a suggestion applies it. For split payments, add one method, then another, until the outstanding amount reaches zero.',
        shortcut: 'F8',
        image: image('payment.png', 'The payment modal: methods on the left, tendered amount and change for cash.'),
      },
      {
        title: 'Complete the sale',
        body:
          'Confirming the payment finalises the sale, deducts stock, and assigns a receipt number. The receipt preview opens automatically.',
        image: image('receipt.png', 'The receipt preview after a completed sale, ready to print.'),
      },
      {
        title: 'Print',
        body:
          'Use the Print button on the receipt preview to send it to the system printer. Closing the preview returns you to an empty cart, ready for the next customer.',
      },
    ],
  },
  {
    id: 'returns-voids',
    kicker: 'Checkout',
    title: 'Returns, refunds & voids',
    summary: 'Refund items from a past sale, or clear lines from the current cart.',
    keywords: ['return', 'refund', 'void', 'cancel', 'clear', 'F10', 'reason'],
    intro:
      'Returns work against completed sales and put stock back; voids only affect the cart in front of you and never touch completed sales.',
    steps: [
      {
        title: 'Process a return',
        body:
          'Press F10 (or the Refund action) to open the returns modal. Find the original sale in the list, choose which lines and quantities are coming back, give a reason, and confirm. The refund is recorded against your shift and the stock is returned.',
        shortcut: 'F10',
        image: image('returns.png', 'The returns modal: pick the sale, the lines and quantities, and a reason.'),
      },
      {
        title: 'Void the cart or one line',
        body:
          'The Void action clears the whole cart after confirmation. Removing a single line with its x button asks for the same confirmation, so nothing disappears by accident.',
        image: image('void.png', 'The void confirmation protects the cart against accidental clears.'),
      },
    ],
  },
  {
    id: 'reports',
    kicker: 'Reports',
    title: 'Z-Report & shift figures',
    summary: 'Gross sales, refunds, payment breakdown and drawer variance for the shift.',
    keywords: ['report', 'z-report', 'z report', 'totals', 'variance', 'breakdown', 'sales summary'],
    intro:
      'The Z-Report summarises the open shift: gross sales, discounts, refunds, net sales, transaction count, a breakdown by payment method, and the expected drawer against the opening float.',
    steps: [
      {
        title: 'Open the report',
        body:
          'Open the account menu in the header and choose Reports. Select a week, month, or year, then choose an open or closed sales slot from the list.',
        image: image('zreport.png', 'The Z-Report: shift totals, payment breakdown and expected drawer.'),
      },
    ],
    tips: [
      'The expected drawer equals the opening float plus cash sales, minus cash refunds, plus any cash paid in and minus any cash paid out during the shift — compare it with the counted drawer at closing.',
      'Cash moved in or out mid-shift is listed with its reason, so a drawer that was reloaded or dropped still reconciles.',
    ],
  },
  {
    id: 'sync',
    kicker: 'System',
    title: 'Sync with the inventory server',
    summary: 'Offline-first: every action is queued locally and replayed to the host.',
    keywords: ['sync', 'offline', 'online', 'pending', 'conflict', 'upstream', 'inventory', 'host', 'outbox'],
    intro:
      'The workstation works fully offline. Everything you do is written to a local playback log and synced to the inventory server in the background every few seconds. The status pill in the header tells you at a glance whether the workstation is online and how many events are still pending.',
    steps: [
      {
        title: 'Check the header pills',
        body:
          'A green dot means the last sync succeeded. "Pending" counts events not yet confirmed by the host; "Reconnect host sync" means the workstation needs you to re-enter inventory credentials before it can push again.',
        image: image('account-menu.png', 'The account menu with Sync now, Sync center, Reports and Sign out.'),
      },
      {
        title: 'Use the Sync center',
        body:
          'Choose Sync center from the account menu for the full picture: device clocks, pending and confirmed events, conflicts, and a Sync now button for an immediate push. The Refresh host auth panel lets you re-enter inventory credentials without signing out of the till.',
        image: image('sync.png', 'The Sync center: status, event history and host authentication.'),
      },
    ],
    tips: [
      'Sales never block on the network — if the host is unreachable they simply stay pending until it returns.',
      'Conflicts are resolved automatically (host wins) and surfaced in the Sync center for review.',
    ],
  },
  {
    id: 'settings',
    kicker: 'System',
    title: 'Settings, theme & backups',
    summary: 'Light/dark theme, database location and backups on the desktop app.',
    keywords: ['settings', 'theme', 'dark', 'light', 'backup', 'database', 'storage', 'sqlite'],
    intro:
      'Open Settings from the account menu. Theme applies everywhere; database location and backups are desktop-only because the browser has no access to local files.',
    steps: [
      {
        title: 'Adjust and save',
        body:
          'Switch between light and dark theme, point the desktop app at a different SQLite database file, choose a backup folder, or take a backup immediately with Backup now. Storage changes restart the embedded backend automatically after saving.',
        image: image('settings.png', 'Workstation settings: sync URL, database location, backups and theme.'),
      },
    ],
    tips: ['When you choose a new, empty database path the current database is copied there first — nothing is lost in the move.'],
  },
  {
    id: 'printers',
    kicker: 'Hardware',
    title: 'Receipt & label printers',
    summary: 'Connect Epson-style receipt printers and Zebra label printers over USB or the network.',
    keywords: [
      'printer', 'print', 'receipt', 'label', 'epson', 'zebra', 'escpos', 'esc/pos', 'zpl',
      'thermal', 'usb', 'network', 'drawer', 'cash drawer', 'cut', '80mm', '58mm',
    ],
    intro:
      'The desktop app talks to printers directly rather than through the print dialog, so a receipt prints instantly, the paper is cut, and the cash drawer pops. Settings > Printers is where terminals are paired with their hardware.',
    steps: [
      {
        title: 'Find the printer',
        body:
          'Find installed printers lists everything already set up in Windows, which covers USB printers with a vendor driver. Scan network too also sweeps the local network for printers listening on port 9100, which is how network Epson and Zebra units are reached. Press Add on a result to configure it.',
      },
      {
        title: 'Confirm the language and paper',
        body:
          'Receipt printers speak ESC/POS (Epson, Star, Bixolon and most 58/80mm clones); label printers speak ZPL (Zebra, and TSC or Godex in ZPL mode). Set the paper width to 42 columns for 80mm rolls or 32 for 58mm, and set the label size in millimetres along with the print head resolution.',
      },
      {
        title: 'Print a test page',
        body:
          'Print test page checks the printer answers and puts a sample on the paper. If the test prints readable text and a scannable barcode the printer is ready; garbled output usually means the wrong language is selected.',
      },
      {
        title: 'Print labels',
        body:
          'Once a label printer is configured, each row in the F3 search overlay gains a Label button that prints a shelf label with the product name, barcode and price.',
      },
    ],
    tips: [
      'Every completed sale prints automatically once a receipt printer is set as the default. The Print button on the receipt window is for reprints.',
      'Tick "Cash drawer attached to this printer" to pulse the drawer on cash sales.',
      'Without a configured printer, Print falls back to the system print dialog, so a terminal is never blocked while its hardware is being set up.',
    ],
  },
  {
    id: 'scanner',
    kicker: 'Hardware',
    title: 'Barcode scanners',
    summary: 'Scans go to the cart no matter where the cursor is.',
    keywords: ['scanner', 'scan', 'barcode', 'usb', 'bluetooth', 'wedge', 'ean', 'code128'],
    intro:
      'USB and Bluetooth scanners present themselves as keyboards, so they need no driver or pairing step inside the POS — plug the scanner in, or pair it with the operating system, and it works. The workstation watches the whole screen for scans instead of only the field that has focus.',
    steps: [
      {
        title: 'Scan anywhere',
        body:
          'A scanned code is recognised by how fast the characters arrive and is sent straight to the cart, even when the cursor is sitting in the discount box or the customer picker. Those fields keep whatever was typed in them — the scan never lands in the wrong place.',
      },
      {
        title: 'Scan into search',
        body:
          'The F3 search box is the one exception: scanning while it is open fills the search box so you can see the match before adding it.',
      },
      {
        title: 'Tune it if needed',
        body:
          'Settings > Barcode scanner controls the shortest code accepted and the maximum gap between keystrokes. Raise the gap if a slow scanner is being missed; lower it if very fast typing is being mistaken for a scan. If the scanner is programmed with a prefix character, enter it so it is stripped from the code.',
      },
    ],
    tips: [
      'Variant codes are matched as well as product barcodes, so scanning a variant label adds that exact variant without opening the picker.',
      'A code that matches nothing shows a message naming the code that was scanned, which makes mis-programmed scanners easy to spot.',
    ],
  },
  {
    id: 'shortcuts',
    kicker: 'Reference',
    title: 'Keyboard shortcuts',
    summary: 'Every F-key the workstation responds to.',
    keywords: ['keyboard', 'shortcut', 'hotkey', 'f-key', 'keys'],
    intro: 'All of the high-frequency actions sit on function keys so the till can be driven without the mouse.',
    shortcuts: [
      { keys: 'F1', action: 'Open this help guide' },
      { keys: 'F3', action: 'Search the product catalog' },
      { keys: 'F4', action: 'Hold the current bill' },
      { keys: 'F5', action: 'Recall a held bill' },
      { keys: 'F6', action: 'Focus the bill discount field' },
      { keys: 'F7', action: 'Focus the customer selector' },
      { keys: 'F8', action: 'Take payment for the current cart' },
      { keys: 'F10', action: 'Open returns / refunds' },
      { keys: 'Esc', action: 'Close the topmost overlay' },
    ],
  },
];
