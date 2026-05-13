import "dotenv/config";

// Safety: never let a test run reach real Slack or healthchecks.io. The
// .env load above pulls in the real webhook URLs for local dev — without
// this clobber, any integration test that exercises an alert-firing path
// (e.g. an ingest failing-runner test) would post to the real channel.
// Caught 2026-05-13 after two test runs leaked P1 alerts into
// #skybrook-alerts. Individual tests that need to exercise postAlert
// can re-set these to test-only URLs in beforeEach.
process.env.SLACK_WEBHOOK_ALERTS_URL = "";
process.env.SLACK_WEBHOOK_DIGEST_URL = "";
process.env.SLACK_WEBHOOK_DEBUG_URL = "";
process.env.SLACK_MENTION_USER_IDS = "";
process.env.HEALTHCHECK_PING_URL = "";
