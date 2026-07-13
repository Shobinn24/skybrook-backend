import { describe, expect, it } from "vitest";
import { parseLooxReviewEmail } from "@/lib/sources/loox/parse-review-email";

// Synthetic fixtures shaped like Loox notification emails (and Gmail
// forwards of them). The parser is deliberately tolerant: real-world
// format drift lands as parsed=false with raw text kept, never a throw.

const CLASSIC = `
Jane D. left a review

★★★★☆

“Really soft and actually leakproof. I sleep in these now.”

Product: Cotton Leakproof Underwear

View this review in your Loox dashboard: https://loox.io/app/reviews
Unsubscribe`;

const FORWARDED = `
---------- Forwarded message ---------
From: Loox <notifications@loox.io>
Subject: New review for Men's Leakproof Brief

Mark T. left a review

Rating: 3/5

The fit is good but the waistband rolls when I sit down for long periods.

Powered by Loox`;

describe("parseLooxReviewEmail", () => {
  it("parses the classic notification shape", () => {
    const r = parseLooxReviewEmail("You've got a new review!", CLASSIC);
    expect(r.parsed).toBe(true);
    expect(r.rating).toBe(4);
    expect(r.reviewerName).toBe("Jane D.");
    expect(r.productTitle).toBe("Cotton Leakproof Underwear");
    expect(r.reviewText).toContain("actually leakproof");
  });

  it("parses a forwarded email with numeric rating and subject product", () => {
    const r = parseLooxReviewEmail("Fwd: New review for Men's Leakproof Brief", FORWARDED);
    expect(r.parsed).toBe(true);
    expect(r.rating).toBe(3);
    expect(r.productTitle).toBe("Men's Leakproof Brief");
    expect(r.reviewText).toContain("waistband rolls");
  });

  it("star row caps at 5 and half-empty rows count filled stars", () => {
    expect(parseLooxReviewEmail("s", "★★★★★★ great").rating).toBe(5);
    expect(parseLooxReviewEmail("s", "★★☆☆☆ meh product\n\nProduct: X").rating).toBe(2);
  });

  it("unrecognizable content comes back parsed=false, never throws", () => {
    const r = parseLooxReviewEmail("Weekly digest", "Here is your Loox weekly summary. https://loox.io");
    expect(r.parsed).toBe(false);
    expect(r.rating).toBeNull();
  });

  it("boilerplate and links never become the review text", () => {
    const r = parseLooxReviewEmail(
      "New review for Boyshort",
      "★★★★★\n\nhttps://everdries.com/boyshort?utm=loox\n\nAbsolutely love these, no leaks on heavy days and they wash well.\n\nUnsubscribe from these notifications",
    );
    expect(r.reviewText).toContain("Absolutely love these");
    expect(r.reviewText).not.toContain("Unsubscribe");
  });
});

import { isHousekeepingSender } from "@/lib/jobs/loox-ingest";

describe("isHousekeepingSender", () => {
  it("skips Google account/security mail, keeps everything else", () => {
    expect(isHousekeepingSender("no-reply@accounts.google.com")).toBe(true);
    expect(isHousekeepingSender("mail-noreply@google.com")).toBe(true);
    expect(isHousekeepingSender("notifications@loox.io")).toBe(false);
    expect(isHousekeepingSender("scott@everdries.com")).toBe(false);
    expect(isHousekeepingSender(undefined)).toBe(false);
    // a forwarded review FROM a gmail user must not be skipped
    expect(isHousekeepingSender("somecustomer@gmail.com")).toBe(false);
  });
});
