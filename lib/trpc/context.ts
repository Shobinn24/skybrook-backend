// tRPC context. Auth is enforced at the HTTP layer by middleware.ts using the
// shared-password cookie, so the tRPC context is intentionally minimal for MVP.
export type TrpcContext = {
  // Placeholder — future expansion (per-user session, request id, feature flags, etc.)
  _: true;
};

export async function createContext(): Promise<TrpcContext> {
  return { _: true };
}
