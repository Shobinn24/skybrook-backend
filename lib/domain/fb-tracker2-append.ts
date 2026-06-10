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

/** Map ad name (trimmed) → ALL 0-based row indices carrying that name,
 * in sheet order. Skips empty-name rows.
 *
 * Duplicate names are real on both tabs (relaunched twins of the same
 * creative arrive from Supermetrics as separate rows; measured
 * 2026-06-10: 160 dup names / 323 rows on 30D Check, 250 / 510 on the
 * 2026 tab). The previous single-index map silently dropped every twin
 * but the last — ~$2.5-3k/day of spend never reached the 2026 tab. */
function adNameRowsMap(grid: Grid): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let r = 1; r < grid.length; r++) {
    const name = String(grid[r]?.[0] ?? "").trim();
    if (!name) continue;
    const arr = m.get(name) ?? [];
    arr.push(r);
    m.set(name, arr);
  }
  return m;
}

/** Numeric spend at (row, col), or null when the cell is empty /
 * non-numeric. UNFORMATTED_VALUE reads give plain numbers. */
function spendAt(grid: Grid, row: number, col: number): number | null {
  const v = grid[row]?.[col];
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Per-name spend assignment for one date column: pairs duplicate-name
 * rows positionally (source row i → target row i); when the source has
 * MORE rows than the target, the surplus rows' spend is added onto the
 * last target row so the column TOTAL is preserved; when the target has
 * more rows, the unpaired target rows are left untouched. Returns the
 * per-target-row values to write (null = leave as-is). */
function assignSpendForName(
  sourceRows: number[],
  targetCount: number,
  grid: Grid,
  col: number,
): Array<number | null> {
  const out: Array<number | null> = new Array(targetCount).fill(null);
  for (let i = 0; i < sourceRows.length; i++) {
    const spend = spendAt(grid, sourceRows[i], col);
    if (spend === null) continue;
    const target = Math.min(i, targetCount - 1);
    out[target] = (out[target] ?? 0) + spend;
  }
  return out;
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
  /** Date columns to write: one per missing date (appended at the right
   * edge) plus any restamped existing columns whose values changed. */
  columns: ColumnUpdate[];
  /** Brand-new ad rows to append. */
  newRows: NewRow[];
  /** Summary stats for logging/alerts. */
  summary: {
    missingDates: string[];
    restampedDates: string[];
    newAdsCount: number;
    updatedCellsCount: number;
  };
};

/** Build the operation set. Pure — no I/O.
 *
 * `restampDays` additionally refreshes the N most recent dates that
 * exist on BOTH tabs from the 30D Check values. Why: the append stamps
 * each day once, T+1, but FB keeps restating numbers for ~72h — the
 * frozen day-one values left the 2026 tab ~9% ($2.5-3k/day) below the
 * 30D Check for the same dates (measured 2026-06-10). Restamping the
 * trailing days on every run lets the restatements flow through.
 *
 * Deleted-ad protection: a restamp only overwrites cells for ads still
 * PRESENT on 30D Check. Ads that have been deleted in FB drop off the
 * 30D Check pull entirely — blanking their archived cells would erase
 * real historical spend, so existing values are preserved when the ad
 * is missing from the source. */
export function computeAppendOperations(
  check30Grid: Grid,
  tab2026Grid: Grid,
  opts: { restampDays?: number } = {},
): AppendOperations {
  const restampDays = opts.restampDays ?? 0;
  const check30Header = check30Grid[0] ?? [];
  const tab2026Header = tab2026Grid[0] ?? [];

  const check30Dates = dateColumnMap(check30Header);
  const tab2026Dates = dateColumnMap(tab2026Header);

  // Missing dates = on 30D Check but not on 2026. Chronological so
  // the new columns land in order on the sheet.
  const missingDates = [...check30Dates.keys()]
    .filter((d) => !tab2026Dates.has(d))
    .sort();

  // Restamp candidates = the N most recent dates present on BOTH tabs.
  const restampCandidates =
    restampDays > 0
      ? [...check30Dates.keys()]
          .filter((d) => tab2026Dates.has(d))
          .sort()
          .slice(-restampDays)
      : [];

  if (missingDates.length === 0 && restampCandidates.length === 0) {
    return {
      columns: [],
      newRows: [],
      summary: {
        missingDates: [],
        restampedDates: [],
        newAdsCount: 0,
        updatedCellsCount: 0,
      },
    };
  }

  const tab2026Names = adNameRowsMap(tab2026Grid);
  const check30Names = adNameRowsMap(check30Grid);

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

    // Existing 2026 ads: positional twin pairing against 30D Check.
    for (const [name, rows2026] of tab2026Names) {
      const srcRows = check30Names.get(name);
      if (srcRows === undefined) continue;
      const assigned = assignSpendForName(srcRows, rows2026.length, check30Grid, check30Col);
      for (let i = 0; i < rows2026.length; i++) {
        const v = assigned[i];
        if (v === null) continue;
        values[rows2026[i]] = v;
        updatedCellsCount++;
      }
    }

    // New ads (not yet on 2026): one appended row per name, carrying the
    // SUM of that name's twin rows. The row index for ad j (0-indexed in
    // newAdNames) is baseRowCount + j.
    for (let j = 0; j < newAdNames.length; j++) {
      const srcRows = check30Names.get(newAdNames[j])!;
      const [v] = assignSpendForName(srcRows, 1, check30Grid, check30Col);
      if (v === null) continue;
      values[baseRowCount + j] = v;
      updatedCellsCount++;
    }

    columns.push({ date, columnIndex, isNew: true, values });
  }

  // Restamp pass: refresh existing columns from 30D Check. Cells are
  // seeded from the CURRENT 2026 values so anything we don't explicitly
  // overwrite (deleted ads, rows below the data block) survives
  // byte-for-byte; a column is emitted only when at least one cell
  // actually changes.
  const restampedDates: string[] = [];
  for (const date of restampCandidates) {
    const columnIndex = tab2026Dates.get(date)!;
    const check30Col = check30Dates.get(date)!;

    const values: Array<string | number> = new Array(finalRowCount).fill("");
    // Preserve the existing header cell verbatim (it may be an Excel
    // date serial; rewriting it as a string would change the cell type
    // and the sheet's display format).
    values[0] = (tab2026Header[columnIndex] as string | number) ?? date;
    for (let r = 1; r < baseRowCount; r++) {
      values[r] = (tab2026Grid[r]?.[columnIndex] as string | number) ?? "";
    }

    let changed = 0;
    for (const [name, rows2026] of tab2026Names) {
      const srcRows = check30Names.get(name);
      // Name entirely absent from 30D Check = the ad was deleted in FB;
      // keep its archived values. But when the name IS present, the
      // source is authoritative for ALL of that name's rows — unpaired
      // twin cells get cleared rather than preserved, because stale
      // leftovers from the old single-row matcher otherwise double-count
      // (measured +$1.1k/day over Ads Manager on 2026-06-10).
      if (srcRows === undefined) continue;
      const assigned = assignSpendForName(srcRows, rows2026.length, check30Grid, check30Col);
      for (let i = 0; i < rows2026.length; i++) {
        const v = assigned[i];
        const next: string | number = v === null ? "" : v;
        if (String(values[rows2026[i]]) !== String(next)) {
          values[rows2026[i]] = next;
          changed++;
        }
      }
    }
    for (let j = 0; j < newAdNames.length; j++) {
      const srcRows = check30Names.get(newAdNames[j])!;
      const [v] = assignSpendForName(srcRows, 1, check30Grid, check30Col);
      if (v === null) continue;
      values[baseRowCount + j] = v;
      changed++;
    }

    if (changed > 0) {
      updatedCellsCount += changed;
      restampedDates.push(date);
      columns.push({ date, columnIndex, isNew: false, values });
    }
  }

  // Build the new rows. Each row has the ad name + link + empty cells
  // up to baseColCount, then spend values in the new columns (filled
  // via the column loop above — we don't need to duplicate here; the
  // glue layer will assemble the row from the column writes OR write
  // rows + columns separately. We expose the row shape for the glue
  // to use however it likes.)
  const newRows: NewRow[] = newAdNames.map((name, j) => {
    const srcRows = check30Names.get(name)!;
    const link = String(check30Grid[srcRows[0]]?.[1] ?? "");
    const row: Array<string | number> = new Array(
      baseColCount + missingDates.length,
    ).fill("");
    row[0] = name;
    row[1] = link;
    // Fill in the new-column spend values inline so each new row is
    // self-contained when the glue layer appends it. The columns
    // array above already covers updates to the row indices, so this
    // duplicates intentionally for the row-append path. Twin rows of
    // the same new name sum into the single appended row.
    for (let i = 0; i < missingDates.length; i++) {
      const check30Col = check30Dates.get(missingDates[i])!;
      const [v] = assignSpendForName(srcRows, 1, check30Grid, check30Col);
      if (v === null) continue;
      row[baseColCount + i] = v;
    }
    // Same for restamped existing columns — their indices sit inside
    // baseColCount, so the new row carries those values too.
    for (const date of restampedDates) {
      const columnIndex = tab2026Dates.get(date)!;
      const check30Col = check30Dates.get(date)!;
      const [v] = assignSpendForName(srcRows, 1, check30Grid, check30Col);
      if (v === null) continue;
      row[columnIndex] = v;
    }
    return { rowIndex: baseRowCount + j, values: row };
  });

  return {
    columns,
    newRows,
    summary: {
      missingDates,
      restampedDates,
      newAdsCount: newAdNames.length,
      updatedCellsCount,
    },
  };
}
