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

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { role, showCashflow, fbAdsOnly } = await resolveAccessFromCookies();
  return (
    <div className="flex min-h-screen">
      <LeftNav role={role} showCashflow={showCashflow} fbAdsOnly={fbAdsOnly} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBarStatus />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
