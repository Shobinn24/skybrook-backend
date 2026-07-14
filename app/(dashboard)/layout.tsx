import { cookies } from "next/headers";
import { LeftNav } from "@/components/shell/LeftNav";
import { TopBarStatus } from "@/components/shell/TopBarStatus";
import { SESSION_COOKIE, getUserRole, isCashflowAllowed, isFbAdsOnly, verifySessionToken } from "@/lib/auth";

// Determine the signed-in user's role server-side so the rendered nav
// reflects exactly what the middleware will allow. Edge middleware also
// gates page paths; this layer keeps the chrome itself coherent (no
// "click → instant redirect" UX for marketing users). fb-ads-only
// membership is resolved the same way (it wins over role in the
// middleware, so the nav mirrors that precedence).
async function resolveAccessFromCookies(): Promise<{
  role: ReturnType<typeof getUserRole>;
  showCashflow: boolean;
  fbAdsOnly: boolean;
}> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { role: "ops", showCashflow: false, fbAdsOnly: false };
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return { role: "ops", showCashflow: false, fbAdsOnly: false };
  const session = await verifySessionToken(secret, token);
  const email = session?.email ?? null;
  return {
    role: getUserRole(email),
    showCashflow: isCashflowAllowed(email),
    fbAdsOnly: isFbAdsOnly(email),
  };
}

// Unmissable stripe when a dev server is pointed at a non-local database.
// Local dev deliberately runs against prod data for realistic pages, which
// is exactly why it must never be mistaken for a scratch copy — writes and
// mutations here hit the real thing.
function devDataBanner(): React.ReactNode {
  const isDev =
    process.env.NODE_ENV === "development" || process.env.SKYBROOK_DEV_BYPASS === "1";
  if (!isDev) return null;
  const dbUrl = process.env.DATABASE_URL ?? "";
  const remote = dbUrl.length > 0 && !/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
  if (!remote) return null;
  return (
    <div className="bg-red-600 px-4 py-1 text-center text-xs font-semibold text-white">
      DEV SERVER ON PRODUCTION DATA — edits and mutations hit the live database
    </div>
  );
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { role, showCashflow, fbAdsOnly } = await resolveAccessFromCookies();
  return (
    <div className="flex min-h-screen flex-col">
      {devDataBanner()}
      <div className="flex flex-1">
        <LeftNav role={role} showCashflow={showCashflow} fbAdsOnly={fbAdsOnly} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBarStatus />
          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
