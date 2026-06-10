export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  google_denied: "Sign-in was cancelled or denied by Google.",
  missing_params: "Google did not return the expected parameters. Try again.",
  bad_state: "Sign-in link expired. Please try again.",
  token_exchange_failed: "Could not complete Google sign-in. Try again.",
  bad_id_token: "Could not read Google sign-in response. Try again.",
  no_email: "Your Google account did not return an email address.",
  email_unverified: "Your Google account email is not verified.",
  bad_domain:
    "This Google account isn't on the dashboard access list. Sign in with your workspace account, or ask the team admin to add this email.",
  not_allowed:
    "Your account is not on the Skybrook access list. Ask the team admin to add this email.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const errorCode = params.error;
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] ?? "Sign-in failed." : null;
  const nextQs = params.next ? `?next=${encodeURIComponent(params.next)}` : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-md border border-neutral-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Skybrook</h1>
          <p className="text-sm text-neutral-500">Everdries internal operations dashboard</p>
        </div>
        {errorMessage && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {errorMessage}
          </div>
        )}
        <a
          href={`/api/auth/google/start${nextQs}`}
          className="flex w-full items-center justify-center gap-2 rounded border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          <svg aria-hidden className="h-4 w-4" viewBox="0 0 48 48">
            <path
              fill="#EA4335"
              d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
            />
            <path
              fill="#4285F4"
              d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
            />
            <path
              fill="#FBBC05"
              d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
            />
            <path
              fill="#34A853"
              d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
            />
          </svg>
          Sign in with Google
        </a>
        <p className="text-xs text-neutral-400">
          Access is restricted to the Everdries Google Workspace. Ask Scott if you need
          to be added.
        </p>
      </div>
    </div>
  );
}
