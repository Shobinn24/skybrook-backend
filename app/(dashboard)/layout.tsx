import { cookies } from "next/headers";
import { LeftNav } from "@/components/shell/LeftNav";
import { TopBarStatus } from "@/components/shell/TopBarStatus";
import { SESSION_COOKIE, getUserRole, verifySessionToken } from "@/lib/auth";

// Determine the signed-in user's role server-side so the rendered nav
// reflects exactly what the middleware will allow. Edge middleware also
// gates page paths; this layer keeps the chrome itself coherent (no
// "click → instant redirect" UX for marketing users).
async function resolveRoleFromCookies() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return "ops" as const;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return "ops" as const;
  const session = await verifySessionToken(secret, token);
  return getUserRole(session?.email ?? null);
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const role = await resolveRoleFromCookies();
  return (
    <div className="flex min-h-screen">
      <LeftNav role={role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBarStatus />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
