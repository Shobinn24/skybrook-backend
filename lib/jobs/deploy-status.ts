// Railway deploy-status webhook parsing.
//
// Why this exists (2026-08-04): commit 448017b built SUCCESS on
// skybrook-backend and FAILED on skybrook-cron-poll at the same minute (a
// transient GHCR auth failure). Railway keeps the PREVIOUS deployment
// running when a build fails, so the service silently stayed on stale code:
// no Slack alert, no /api/health failure, nothing said so. It was caught by
// eye in the dashboard.
//
// Fix: Railway project webhooks POST on every deployment status change.
// This module turns a webhook body into an action for the receiving route:
// FAILED/CRASHED fires a p1 (the silent-stale-code case), SUCCESS resolves
// it, everything else is ignored. Self-monitoring works precisely BECAUSE of
// the failure mode being detected: on a failed build the old deployment
// stays alive to receive the failure webhook. (A hard outage of the whole
// service is a different failure, covered by the healthchecks.io dead-man.)
//
// Railway has shipped two payload shapes; both are tolerated:
//   legacy: { type: "DEPLOY", status, project: {name}, environment: {name},
//            service: {name}, deployment: {meta} }
//   current: { type: "Deployment.failed"|..., details: {status, commitHash,
//             commitMessage, ...}, resource: {project, environment, service} }
// Payloads are unsigned, so the receiving route gates on a shared secret in
// the webhook URL instead.

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

type AnyObj = Record<string, unknown>;

function asObj(v: unknown): AnyObj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AnyObj) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Pull a name out of either payload generation. */
function nameOf(body: AnyObj, key: "project" | "environment" | "service"): string | null {
  const direct = asObj(body[key]);
  const resource = asObj(asObj(body.resource)[key]);
  return str(direct.name) ?? str(resource.name) ?? str(direct.id) ?? str(resource.id) ?? null;
}

export type DeployEvent =
  | {
      kind: "failure" | "success";
      status: string;
      project: string;
      environment: string;
      service: string;
      dedupKey: string;
      title: string;
      fields: Record<string, string>;
    }
  | { kind: "ignored"; status: string | null; reason: string };

/** Statuses that mean "the running code is now stale and nothing else will
 * say so". CRASHED is included: a crash-looping deploy also leaves the
 * service effectively on its previous behavior, and an OOM kill does the
 * same (Railway's picker exposes it as its own "Oom Killed" event). */
const FAILURE_STATUSES = new Set(["FAILED", "CRASHED", "OOM_KILLED", "OOMKILLED"]);
/** Railway's event vocabulary says "Deployed"/"Redeployed" where the old
 * payload said SUCCESS; REDEPLOYED matters because a manual
 * `railway redeploy` fix must clear the alert too. */
const SUCCESS_STATUSES = new Set(["SUCCESS", "DEPLOYED", "REDEPLOYED"]);

export function parseDeployEvent(body: unknown): DeployEvent {
  const b = asObj(body);
  const details = asObj(b.details);

  // Status: legacy top-level, current details.status, or encoded in the
  // event type ("Deployment.failed" -> FAILED).
  let status =
    str(b.status)?.toUpperCase() ?? str(details.status)?.toUpperCase() ?? null;
  const type = str(b.type);
  if (!status && type && type.toLowerCase().startsWith("deployment.")) {
    // "Deployment.failed" -> FAILED, "Deployment.oomKilled" -> OOM_KILLED
    const suffix = type.split(".")[1]?.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    if (suffix) status = suffix;
  }
  if (!status) return { kind: "ignored", status: null, reason: "no status in payload" };

  const isFailure = FAILURE_STATUSES.has(status);
  const isSuccess = SUCCESS_STATUSES.has(status);
  if (!isFailure && !isSuccess) {
    // BUILDING / DEPLOYING / QUEUED / REMOVED / SKIPPED etc — transitions,
    // not outcomes.
    return { kind: "ignored", status, reason: "non-terminal status" };
  }

  const project = nameOf(b, "project") ?? "unknown-project";
  const environment = nameOf(b, "environment") ?? "unknown";
  const service = nameOf(b, "service") ?? "unknown-service";

  // PR/preview environments would be noise; only production (or payloads
  // that don't say) alert.
  if (environment.toLowerCase() !== "production" && environment !== "unknown") {
    return { kind: "ignored", status, reason: `non-production environment ${environment}` };
  }

  const commit =
    str(details.commitHash) ?? str(asObj(asObj(b.deployment)?.meta).commitHash) ?? null;
  const commitMessage = str(details.commitMessage);

  const fields: Record<string, string> = {
    project,
    service,
    environment,
    status,
  };
  if (commit) fields.commit = commit.slice(0, 12);
  if (commitMessage) fields.commitMessage = commitMessage.slice(0, 120);

  const dedupKey = `deploy_status:${slugify(project)}:${slugify(service)}`;
  return {
    kind: isFailure ? "failure" : "success",
    status,
    project,
    environment,
    service,
    dedupKey,
    title:
      isFailure
        ? `Deploy ${status} for ${service} (${project}) — service is still running the previous build`
        : `Deploy recovered for ${service} (${project})`,
    fields,
  };
}
