import { cookies } from "next/headers";
import { LeftNav } from "@/components/shell/LeftNav";
import { TopBarStatus } from "@/components/shell/TopBarStatus";
import { SESSION_COOKIE, getUserRole, isCashflowAllowed, verifySessionToken } from "@/lib/auth";

// Determine the signed-in user's role server-side so the rendered nav
// reflects exactly what the middleware will allow. Edge middleware also
// gates page paths; this layer keeps the chrome itself coherent (no
// "click → instant redirect" UX for marketing users).
async function resolveAccessFromCookies(): Promise<{
  role: ReturnType<typeof getUserRole>;
  showCashflow: boolean;
}> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return { role: "ops", showCashflow: false };
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return { role: "ops", showCashflow: false };
  const session = await verifySessionToken(secret, token);
  const email = session?.email ?? null;
  return { role: getUserRole(email), showCashflow: isCashflowAllowed(email) };
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { role, showCashflow } = await resolveAccessFromCookies();
  return (
    <div className="flex min-h-screen">
      <LeftNav role={role} showCashflow={showCashflow} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBarStatus />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
