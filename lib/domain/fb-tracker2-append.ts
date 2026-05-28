// Pure-algorithm half of the FB Ads Tracker 2 daily append. Takes the
// `30D Check` and `2026` grids and computes the exact write operations
// needed to bring `2026` up to date (one column per missing date, plus
// any brand-new ad rows). The Sheets-API glue (lib/jobs/fb-tracker2-
// append.ts) calls this and executes the returned operations.
//
// Why read from `30D Check` rather than `Daily`: the Daily tab is a
// single-day Supermetrics query that lags FB Ads' 48h finalization
// window — at any morning trigger time it consistently holds T-2, not
// T-1. The 30D Check tab is a 30-day rolling pull that DOES include
// T-1 once FB has finalized, and is what backfillFromCheck30() has
// always used as the recovery source. We make it the primary source
// to eliminate the day-skip pattern that left the 2026 tab missing
// 5/27 + 5/28 by 2026-05-28.
//
// Algorithm:
//   1. Find date column headers on both grids (col index >= 2).
//   2. Dates on 30D Check but not on 2026 → "missing dates" to write.
//   3. For each missing date, build a per-ad spend map from 30D Check.
//   4. For each ad already on 2026, queue an update (write the spend
//      value into the new column at that ad's row).
//   5. For each ad on 30D Check not on 2026, queue a new row append.
//   6. Return all operations; glue layer batches the Sheets writes.

export type GridCell = unknown;
export type Grid = ReadonlyArray<ReadonlyArray<GridCell>>;

/** YYYY-MM-DD format from any cell (number serial, string, Date). Null
 * for cells that aren't recognisable as dates. */
export function parseDateCell(cell: GridCell): string | null {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number") {
    // Excel serial: days since 1899-12-30. Bound to a sane range so
    // we don't try to interpret a spend amount (e.g. 4500) as a date.
    if (cell < 40000 || cell > 60000) return null;
    return new Date(Date.UTC(1899, 11, 30) + cell * 86400000)
      .toISOString()
      .slice(0, 10);
  }
  if (typeof cell === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(cell)) return cell.slice(0, 10);
    const d = new Date(cell);
    if (!isNaN(d.getTime()) && d.getUTCFullYear() >= 2020) {
      return d.toISOString().slice(0, 10);
    }
  }
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return cell.toISOString().slice(0, 10);
  }
  return null;
}

/** Map date string → 0-based column index. Skips col 0 (ad name) +
 * col 1 (link); date columns start at index 2. */
function dateColumnMap(headerRow: ReadonlyArray<GridCell>): Map<string, number> {
  const m = new Map<string, number>();
  for (let c = 2; c < headerRow.length; c++) {
    const d = parseDateCell(headerRow[c]);
    if (d) m.set(d, c);
  }
  return m;
}

/** Map ad name (trimmed) → 0-based row index. Skips empty-name rows. */
function adNameRowMap(grid: Grid): Map<string, number> {
  const m = new Map<string, number>();
  for (let r = 1; r < grid.length; r++) {
    const name = String(grid[r]?.[0] ?? "").trim();
    if (name) m.set(name, r);
  }
  return m;
}

export type ColumnUpdate = {
  /** Date this column holds. */
  date: string;
  /** 0-based column index where this column will be written. If the
   * column already existed on 2026 (which shouldn't happen for missing
   * dates but we expose it defensively), we'd reuse its index;
   * otherwise the column is appended after the last existing column. */
  columnIndex: number;
  /** Whether this column is being newly appended (header cell needs
   * writing) vs. overwriting an existing column. */
  isNew: boolean;
  /** Pre-filled column values, indexed by row (row 0 = header date).
   * Length matches the new total row count after newRows are appended.
   * Cells default to empty string when the ad has no spend on this date. */
  values: Array<string | number>;
};

export type NewRow = {
  /** 0-based row index where this row will be written. */
  rowIndex: number;
  /** Cell values for the entire row. Length matches the new total
   * column count. */
  values: Array<string | number>;
};

export type AppendOperations = {
  /** Date columns to write (one per missing date, in chronological order). */
  columns: ColumnUpdate[];
  /** Brand-new ad rows to append. */
  newRows: NewRow[];
  /** Summary stats for logging/alerts. */
  summary: {
    missingDates: string[];
    newAdsCount: number;
    updatedCellsCount: number;
  };
};

/** Build the operation set. Pure — no I/O. */
export function computeAppendOperations(
  check30Grid: Grid,
  tab2026Grid: Grid,
): AppendOperations {
  const check30Header = check30Grid[0] ?? [];
  const tab2026Header = tab2026Grid[0] ?? [];

  const check30Dates = dateColumnMap(check30Header);
  const tab2026Dates = dateColumnMap(tab2026Header);

  // Missing dates = on 30D Check but not on 2026. Chronological so
  // the new columns land in order on the sheet.
  const missingDates = [...check30Dates.keys()]
    .filter((d) => !tab2026Dates.has(d))
    .sort();

  if (missingDates.length === 0) {
    return {
      columns: [],
      newRows: [],
      summary: { missingDates: [], newAdsCount: 0, updatedCellsCount: 0 },
    };
  }

  const tab2026Names = adNameRowMap(tab2026Grid);
  const check30Names = adNameRowMap(check30Grid);

  // Pre-compute which check30 ads are new to 2026 (need row append).
  const newAdNames: string[] = [];
  for (const name of check30Names.keys()) {
    if (!tab2026Names.has(name)) newAdNames.push(name);
  }

  // The final row count after appending new ads. Used to size column
  // arrays so a single setValues call covers updates + new-row cells.
  const baseRowCount = Math.max(tab2026Grid.length, 1);
  const finalRowCount = baseRowCount + newAdNames.length;

  // The column index for the first appended date column. We append
  // columns sequentially after the last existing column on 2026.
  const baseColCount = tab2026Header.length;

  const columns: ColumnUpdate[] = [];
  let updatedCellsCount = 0;

  for (let i = 0; i < missingDates.length; i++) {
    const date = missingDates[i];
    const columnIndex = baseColCount + i;
    const check30Col = check30Dates.get(date)!;

    const values: Array<string | number> = new Array(finalRowCount).fill("");
    values[0] = date; // header

    // Existing 2026 ads: look up spend on 30D Check.
    for (const [name, row2026] of tab2026Names) {
      const check30Row = check30Names.get(name);
      if (check30Row === undefined) continue;
      const spend = check30Grid[check30Row]?.[check30Col];
      if (spend === "" || spend === null || spend === undefined) continue;
      values[row2026] = spend as string | number;
      updatedCellsCount++;
    }

    // New ads (not yet on 2026): their values land in the appended
    // rows. The row index for ad i (0-indexed in newAdNames) is
    // baseRowCount + i.
    for (let j = 0; j < newAdNames.length; j++) {
      const name = newAdNames[j];
      const check30Row = check30Names.get(name)!;
      const spend = check30Grid[check30Row]?.[check30Col];
      if (spend === "" || spend === null || spend === undefined) continue;
      values[baseRowCount + j] = spend as string | number;
      updatedCellsCount++;
    }

    columns.push({ date, columnIndex, isNew: true, values });
  }

  // Build the new rows. Each row has the ad name + link + empty cells
  // up to baseColCount, then spend values in the new columns (filled
  // via the column loop above — we don't need to duplicate here; the
  // glue layer will assemble the row from the column writes OR write
  // rows + columns separately. We expose the row shape for the glue
  // to use however it likes.)
  const newRows: NewRow[] = newAdNames.map((name, j) => {
    const check30Row = check30Names.get(name)!;
    const link = String(check30Grid[check30Row]?.[1] ?? "");
    const row: Array<string | number> = new Array(
      baseColCount + missingDates.length,
    ).fill("");
    row[0] = name;
    row[1] = link;
    // Fill in the new-column spend values inline so each new row is
    // self-contained when the glue layer appends it. The columns
    // array above already covers updates to the row indices, so this
    // duplicates intentionally for the row-append path.
    for (let i = 0; i < missingDates.length; i++) {
      const date = missingDates[i];
      const check30Col = check30Dates.get(date)!;
      const spend = check30Grid[check30Row]?.[check30Col];
      if (spend === "" || spend === null || spend === undefined) continue;
      row[baseColCount + i] = spend as string | number;
    }
    return { rowIndex: baseRowCount + j, values: row };
  });

  return {
    columns,
    newRows,
    summary: {
      missingDates,
      newAdsCount: newAdNames.length,
      updatedCellsCount,
    },
  };
}
