export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const showError = params.error === "1";

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-md border border-neutral-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Skybrook</h1>
          <p className="text-sm text-neutral-500">Everdries internal operations dashboard</p>
        </div>
        {showError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            Incorrect password.
          </div>
        )}
        <form method="POST" action="/api/auth/login" className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-neutral-700">Password</span>
            <input
              type="password"
              name="password"
              required
              autoFocus
              autoComplete="current-password"
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
          >
            Sign in
          </button>
        </form>
        <p className="text-xs text-neutral-400">
          Ask Scott for the current password. One per team, rotated as needed.
        </p>
      </div>
    </div>
  );
}
