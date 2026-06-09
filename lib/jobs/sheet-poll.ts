import { buildDriveClient } from "@/lib/sources/sheets";

// Near-real-time sheet sync (Todo #36). Every few minutes the poller reads
// each sheet-fed source's Drive `modifiedTime` and compares it to the value
// recorded on the last pull. When a sheet has actually changed it fires a
// targeted re-ingest, so edits land in the tool within minutes instead of
// waiting for the next scheduled cron — without blindly re-running the full
// pipeline on a fixed schedule all day.
//
// Hybrid trigger policy:
//   - "full"  sheets (inventory / incoming / velocity / cost) drive phase2,
//     auto-receipt, launches and unit-cost / product-name syncs, so a change
//     fires the full ingest.
//   - "light" sheets (ad-spend / fb-ads) only feed the spend rollups + bonus
//     crossings, already covered by the existing refresh-ad-spend path, so a
//     change to ONLY those fires the light refresh. A full change anywhere
//     wins (the full ingest re-pulls ad-spend too).

export type TriggerKind = "light" | "full";

export type PolledSheet = {
  /** State key + dataPulls source label. */
  source: string;
  /** Env var holding the spreadsheet / Drive file id. */
  sheetIdEnv: string;
  triggerClass: TriggerKind;
};

// The six sheet-fed sources. Drive file ids come from the same env vars the
// ingest runners already read, so there is no second source of truth.
export const POLLED_SHEETS: PolledSheet[] = [
  { source: "sheets_inventory", sheetIdEnv: "INVENTORY_SHEET_ID", triggerClass: "full" },
  { source: "sheets_incoming", sheetIdEnv: "INCOMING_PO_SHEET_ID", triggerClass: "full" },
  { source: "sheets_velocity", sheetIdEnv: "EVERDRIES_VELOCITY_SHEET_ID", triggerClass: "full" },
  { source: "sheets_cost", sheetIdEnv: "EVERDRIES_COST_SHEET_ID", triggerClass: "full" },
  { source: "sheets_ad_spend", sheetIdEnv: "AD_SPEND_SHEET_ID", triggerClass: "light" },
  { source: "sheets_fb_ads", sheetIdEnv: "FB_ADS_SHEET_ID", triggerClass: "light" },
];

export type PollState = {
  lastModifiedTime: string | null;
  lastTriggeredAt: Date | null;
};

export type PollStateUpdate = {
  source: string;
  sheetId: string;
  lastModifiedTime: string | null;
  lastCheckedAt: Date;
  lastTriggeredAt: Date | null;
};

export type SheetPollDeps = {
  /** Returns the Drive `modifiedTime` (RFC3339) for a file id, or null. */
  getModifiedTime: (fileId: string) => Promise<string | null>;
  readState: () => Promise<Map<string, PollState>>;
  writeState: (updates: PollStateUpdate[]) => Promise<void>;
  trigger: (kind: TriggerKind) => Promise<void>;
  now: () => Date;
  /** Don't fire if a trigger fired within this many minutes. Default 6. */
  lockMinutes?: number;
  /** Override the polled-sheet list (tests). */
  sheets?: PolledSheet[];
  /** Override env lookup (tests). */
  env?: Record<string, string | undefined>;
};

export type SheetPollResult = {
  checked: string[];
  changed: string[];
  decision: "none" | TriggerKind;
  fired: boolean;
  lockedOut: boolean;
  errors: Array<{ source: string; error: string }>;
};

export async function runSheetPoll(deps: SheetPollDeps): Promise<SheetPollResult> {
  const sheets = deps.sheets ?? POLLED_SHEETS;
  const env = deps.env ?? process.env;
  const lockMinutes = deps.lockMinutes ?? 6;
  const now = deps.now();
  const state = await deps.readState();

  const checked: string[] = [];
  const changed: string[] = [];
  const errors: SheetPollResult["errors"] = [];
  const changedClasses = new Set<TriggerKind>();

  // First pass: observe each sheet's modifiedTime and detect changes.
  const observed: Array<{
    sheet: PolledSheet;
    sheetId: string;
    modifiedTime: string | null;
    prev: PollState | undefined;
    isChange: boolean;
  }> = [];

  for (const sheet of sheets) {
    const sheetId = env[sheet.sheetIdEnv]?.trim();
    if (!sheetId) continue; // not configured for this deploy — skip silently

    let modifiedTime: string | null;
    try {
      modifiedTime = await deps.getModifiedTime(sheetId);
    } catch (e) {
      errors.push({ source: sheet.source, error: e instanceof Error ? e.message : String(e) });
      continue; // leave this source's state untouched so it retries next cycle
    }

    checked.push(sheet.source);
    const prev = state.get(sheet.source);
    const prevMod = prev?.lastModifiedTime ?? null;
    // A change requires a known baseline AND a readable new value. First-ever
    // observation (prevMod null) just records the baseline without firing.
    const isChange = prevMod !== null && modifiedTime !== null && modifiedTime !== prevMod;
    if (isChange) {
      changed.push(sheet.source);
      changedClasses.add(sheet.triggerClass);
    }
    observed.push({ sheet, sheetId, modifiedTime, prev, isChange });
  }

  // Decide what (if anything) to fire. Full wins over light.
  let decision: "none" | TriggerKind = "none";
  if (changedClasses.has("full")) decision = "full";
  else if (changedClasses.has("light")) decision = "light";

  // Lock: skip firing if any trigger fired within lockMinutes (avoids stacking
  // a re-ingest on an in-flight one). The full ingest is idempotent, so this
  // is a load guard, not a correctness one.
  let lockedOut = false;
  let fired = false;
  if (decision !== "none") {
    const lastTrigMs = Math.max(
      0,
      ...[...state.values()].map((v) => (v.lastTriggeredAt ? v.lastTriggeredAt.getTime() : 0)),
    );
    const sinceMin = (now.getTime() - lastTrigMs) / 60_000;
    if (lastTrigMs > 0 && sinceMin < lockMinutes) {
      lockedOut = true;
    } else {
      await deps.trigger(decision);
      fired = true;
    }
  }

  // Persist. When we fired, advance modifiedTime + stamp lastTriggeredAt on the
  // changed sheets. When locked out, deliberately DO NOT advance a changed
  // sheet's modifiedTime so the next poll re-detects it once the lock clears.
  const updates: PollStateUpdate[] = observed.map((o) => {
    const keepStale = lockedOut && o.isChange;
    const storeMod = keepStale ? (o.prev?.lastModifiedTime ?? null) : (o.modifiedTime ?? o.prev?.lastModifiedTime ?? null);
    const triggeredAt = fired && o.isChange ? now : (o.prev?.lastTriggeredAt ?? null);
    return {
      source: o.sheet.source,
      sheetId: o.sheetId,
      lastModifiedTime: storeMod,
      lastCheckedAt: now,
      lastTriggeredAt: triggeredAt,
    };
  });
  await deps.writeState(updates);

  return { checked, changed, decision, fired, lockedOut, errors };
}

/**
 * Real Drive-backed `getModifiedTime` for production use. Reads only the
 * `modifiedTime` metadata field via the existing `drive.metadata.readonly`
 * service account. `supportsAllDrives` so shared-drive sheets resolve.
 */
export function makeDriveGetModifiedTime(): (fileId: string) => Promise<string | null> {
  const drive = buildDriveClient();
  return async (fileId: string) => {
    const res = await drive.files.get({
      fileId,
      fields: "modifiedTime",
      supportsAllDrives: true,
    });
    return res.data.modifiedTime ?? null;
  };
}
