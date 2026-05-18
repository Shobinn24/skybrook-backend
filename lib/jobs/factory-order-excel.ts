/**
 * Excel-file builder for the approved factory order.
 *
 * Spec: docs/factory-order-spec/factory-order-automation.md §8
 *
 * Per side (US → "SB" / Skybrook with DDP prices, INTL → "MV" /
 * Manora with Cost prices) we render one worksheet with:
 *   - Row 1 header
 *   - Per product (in the explicit §8.4 order, zero-qty products
 *     omitted): merged product cell + 1 SKU row each + subtotal
 *   - Footer with Total / Deposit (20%) / Balance
 *
 * Returns the .xlsx bytes ready for HTTP download.
 */

import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { factoryOrders, factoryOrderLines } from "@/lib/db/schema";

// Spec §8.4 — order in which product blocks appear in the file.
// Names here must match the `product_group` snapshot column values
// written by `approveFactoryOrder` (= names from
// config/factory-order-groups.ts).
const PRODUCT_ORDER: ReadonlyArray<string> = [
  "OG Main",
  "HW Main",
  "9055 Main",
  // Color variants of 9055 — these are calculated groups in our config.
  "9055 Pastel",
  "9055 Blush",
  "9055 Beige",
  "9055 Black",
  "French Cut",
  "French Cut HF",
  "Boyshort HF (4-layer)",
  "Boyshort Beige HF",
  "Boyshort FC HF (4-layer)",
  "Boyshort FC (3-layer)",
  // Custom-input products
  "Super HW (custom batch)",
  "FC Super HW",
  "Cotton Hipster",
  "Shapewear Beige",
  "Shapewear Black",
  "Men's Improved",
  "Men's Brief w Fly",
  "Men's Boxer Brief w Fly",
  "High Rise Short",
  // Calculated equivalents (fallback if user used the calculated path
  // for a product that also has a custom mode — won't double-render
  // because each row only appears once based on its product_group).
  "Super HW",
  "Shapewear",
  "Boyshort",
  "Boyshort Beige",
  // Anything else gets appended in name order at the bottom.
];

export type SheetSide = "US" | "INTL";

export type SheetMeta = {
  side: SheetSide;
  /** "SB" → Skybrook (US); "MV" → Manora (INTL). */
  entity: "Skybrook" | "Manora";
  /** File prefix: "SB" for US, "MV" for INTL. */
  filePrefix: "SB" | "MV";
};

const SIDE_META: Record<SheetSide, SheetMeta> = {
  US: { side: "US", entity: "Skybrook", filePrefix: "SB" },
  INTL: { side: "INTL", entity: "Manora", filePrefix: "MV" },
};

export function fileNameForSheet(opts: {
  side: SheetSide;
  orderMonth: string; // YYYY-MM-DD
}): string {
  const meta = SIDE_META[opts.side];
  const dt = new Date(`${opts.orderMonth}T00:00:00Z`);
  const monthYear = dt.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${meta.filePrefix} - KAI ${monthYear}.xlsx`;
}

type Line = {
  sku: string;
  qty: number;
  unitCost: number;
  amount: number;
  productGroup: string;
};

function priceColumnLabel(side: SheetSide): string {
  return side === "US" ? "DDP Price" : "Cost Price";
}

function qtyColumnLabel(side: SheetSide): string {
  return side === "US" ? "US" : "CN";
}

function amountColumnLabel(side: SheetSide): string {
  return side === "US" ? "US Amount" : "CN Amount";
}

/**
 * Order the per-product groups exactly per spec §8.4, then append any
 * groups that produced lines but aren't in the explicit list (defensive
 * — e.g., if a one-off color variant gets approved).
 */
function orderProductGroups(groups: Set<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of PRODUCT_ORDER) {
    if (groups.has(name) && !seen.has(name)) {
      ordered.push(name);
      seen.add(name);
    }
  }
  const tail = [...groups].filter((n) => !seen.has(n)).sort();
  return [...ordered, ...tail];
}

export async function buildSheetBuffer(opts: {
  orderId: string;
  side: SheetSide;
}): Promise<{ buffer: Buffer; filename: string }> {
  const orderRows = await db
    .select()
    .from(factoryOrders)
    .where(eq(factoryOrders.id, opts.orderId))
    .limit(1);
  if (orderRows.length === 0) {
    throw new Error(`factory_order ${opts.orderId} not found`);
  }
  const order = orderRows[0];
  if (order.status !== "approved") {
    throw new Error(
      `Cannot generate factory sheet for un-approved order ${opts.orderId}`,
    );
  }

  const lineRows = await db
    .select({
      sku: factoryOrderLines.sku,
      destination: factoryOrderLines.destination,
      qty: factoryOrderLines.qty,
      unitCost: factoryOrderLines.unitCost,
      amount: factoryOrderLines.amount,
      productGroup: factoryOrderLines.productGroup,
    })
    .from(factoryOrderLines)
    .where(eq(factoryOrderLines.orderId, opts.orderId));

  // Filter to this side. US side uses destination='US', INTL='CN'.
  const sideDest = opts.side === "US" ? "US" : "CN";
  const lines: Line[] = lineRows
    .filter((r) => r.destination === sideDest && r.qty > 0)
    .map((r) => ({
      sku: r.sku,
      qty: r.qty,
      unitCost: Number(r.unitCost),
      amount: Number(r.amount),
      productGroup: r.productGroup,
    }));

  // Bucket lines by productGroup.
  const linesByGroup = new Map<string, Line[]>();
  for (const l of lines) {
    const arr = linesByGroup.get(l.productGroup) ?? [];
    arr.push(l);
    linesByGroup.set(l.productGroup, arr);
  }
  // Within each group, sort SKUs alphabetically for a stable file.
  for (const arr of linesByGroup.values()) arr.sort((a, b) => a.sku.localeCompare(b.sku));

  const groupNames = orderProductGroups(new Set(linesByGroup.keys()));

  const meta = SIDE_META[opts.side];
  const wb = new ExcelJS.Workbook();
  wb.creator = "Skybrook Factory Orders";
  wb.created = new Date();

  const ws = wb.addWorksheet(`${meta.filePrefix} - KAI`);
  ws.columns = [
    { header: "Product", key: "product", width: 32 },
    { header: "SKU Breakdown", key: "sku", width: 28 },
    { header: priceColumnLabel(opts.side), key: "price", width: 12 },
    { header: qtyColumnLabel(opts.side), key: "qty", width: 10 },
    { header: amountColumnLabel(opts.side), key: "amount", width: 14 },
  ];

  // Style the header row.
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: "center" };

  // Track the subtotal-row addresses so the footer can SUM them.
  const subtotalAmountAddrs: string[] = [];

  let cursorRow = 2;
  for (const groupName of groupNames) {
    const groupLines = linesByGroup.get(groupName) ?? [];
    if (groupLines.length === 0) continue;

    const productCellRow = cursorRow;
    // Write per-SKU rows.
    for (let i = 0; i < groupLines.length; i++) {
      const ln = groupLines[i];
      const r = ws.getRow(cursorRow);
      // Column A = product name on the first SKU row; blank thereafter
      // (we merge below).
      r.getCell(1).value = i === 0 ? groupName : null;
      r.getCell(2).value = ln.sku;
      r.getCell(3).value = ln.unitCost;
      r.getCell(3).numFmt = '"$"#,##0.0000';
      r.getCell(4).value = ln.qty;
      r.getCell(4).numFmt = "#,##0";
      // Amount column is a live formula so editors who tweak qty in
      // the file see the recompute.
      r.getCell(5).value = { formula: `C${cursorRow}*D${cursorRow}` } as ExcelJS.CellFormulaValue;
      r.getCell(5).numFmt = '"$"#,##0.00';
      cursorRow += 1;
    }

    // Merge column A across this product's rows (only if there are >1
    // rows; ExcelJS rejects single-cell merges).
    if (groupLines.length > 1) {
      ws.mergeCells(productCellRow, 1, cursorRow - 1, 1);
      const merged = ws.getCell(productCellRow, 1);
      merged.alignment = { vertical: "middle", wrapText: true };
      merged.font = { bold: true };
    } else {
      ws.getCell(productCellRow, 1).font = { bold: true };
    }

    // Subtotal row.
    const subRowIdx = cursorRow;
    const subRow = ws.getRow(subRowIdx);
    subRow.getCell(4).value = {
      formula: `SUM(D${productCellRow}:D${subRowIdx - 1})`,
    } as ExcelJS.CellFormulaValue;
    subRow.getCell(4).numFmt = "#,##0";
    subRow.getCell(4).font = { bold: true };
    subRow.getCell(5).value = {
      formula: `SUM(E${productCellRow}:E${subRowIdx - 1})`,
    } as ExcelJS.CellFormulaValue;
    subRow.getCell(5).numFmt = '"$"#,##0.00';
    subRow.getCell(5).font = { bold: true };
    subRow.eachCell((cell) => {
      cell.border = { top: { style: "thin" } };
    });
    subtotalAmountAddrs.push(`E${subRowIdx}`);
    cursorRow += 1;

    // Blank separator row.
    cursorRow += 1;
  }

  // Footer
  if (subtotalAmountAddrs.length > 0) {
    cursorRow += 1;
    const totalFormula = subtotalAmountAddrs.join("+");

    const totalRow = ws.getRow(cursorRow);
    totalRow.getCell(4).value = `${meta.entity} Total`;
    totalRow.getCell(4).font = { bold: true };
    totalRow.getCell(5).value = { formula: totalFormula } as ExcelJS.CellFormulaValue;
    totalRow.getCell(5).numFmt = '"$"#,##0.00';
    totalRow.getCell(5).font = { bold: true };
    cursorRow += 1;

    const depositRow = ws.getRow(cursorRow);
    depositRow.getCell(4).value = `${meta.entity} Deposit`;
    depositRow.getCell(5).value = {
      formula: `E${cursorRow - 1}*0.2`,
    } as ExcelJS.CellFormulaValue;
    depositRow.getCell(5).numFmt = '"$"#,##0.00';
    cursorRow += 1;

    const balanceRow = ws.getRow(cursorRow);
    balanceRow.getCell(4).value = `${meta.entity} Balance`;
    balanceRow.getCell(5).value = {
      formula: `E${cursorRow - 2}-E${cursorRow - 1}`,
    } as ExcelJS.CellFormulaValue;
    balanceRow.getCell(5).numFmt = '"$"#,##0.00';
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);

  return {
    buffer,
    filename: fileNameForSheet({
      side: opts.side,
      orderMonth: order.orderMonth,
    }),
  };
}
