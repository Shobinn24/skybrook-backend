import { google } from "googleapis";

export function buildSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (jsonContent) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(jsonContent), scopes }),
    });
  }
  if (keyFile) {
    return google.sheets({
      version: "v4",
      auth: new google.auth.GoogleAuth({ keyFile, scopes }),
    });
  }
  throw new Error(
    "sheets: set GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_SERVICE_ACCOUNT_JSON (content)"
  );
}

// Drive client (metadata scope only) for reading a file's modifiedTime.
// Used to record when Supermetrics last refreshed the FB Ads sheet relative
// to each pull, so we can tune the cron to run after the daily refresh.
export function buildDriveClient() {
  const scopes = ["https://www.googleapis.com/auth/drive.metadata.readonly"];
  const jsonContent = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (jsonContent) {
    return google.drive({
      version: "v3",
      auth: new google.auth.GoogleAuth({ credentials: JSON.parse(jsonContent), scopes }),
    });
  }
  if (keyFile) {
    return google.drive({
      version: "v3",
      auth: new google.auth.GoogleAuth({ keyFile, scopes }),
    });
  }
  throw new Error(
    "drive: set GOOGLE_APPLICATION_CREDENTIALS (file path) or GOOGLE_SERVICE_ACCOUNT_JSON (content)"
  );
}
