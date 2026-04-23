import { LeftNav } from "@/components/shell/LeftNav";
import { TopBarStatus } from "@/components/shell/TopBarStatus";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <LeftNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBarStatus />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
