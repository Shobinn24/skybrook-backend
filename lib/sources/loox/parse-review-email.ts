// Parse a Loox review-notification email into a structured review.
//
// Loox has no API (Scott 2026-07-13), so the pipeline is: Loox notification
// email -> forwarded to the dedicated reviews inbox -> IMAP poll -> this
// parser. Pure function over (subject, text) so unit tests can pin the
// format; TOLERANT by design — anything it can't extract stays null and the
// caller stores the raw text with parsed=false, because Loox can change its
// template any day and silent loss is worse than an "unparsed" bucket.
//
// Known shapes this handles (from Loox notification emails + forwards):
//   Subject: "New review for <Product>" / "You've got a new review!" /
//            "Fwd: ..." wrappers
//   Body:    star row ("★★★★☆", "4 out of 5", "Rating: 4/5"),
//            "<Name> left a review", product line ("Product: <title>"),
//            quoted or bare review text.

export type ParsedLooxReview = {
  productTitle: string | null;
  rating: number | null;
  reviewerName: string | null;
  reviewText: string | null;
  /** True when the essentials (rating + some text or product) landed. */
  parsed: boolean;
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length ? t : null;
};

export function parseLooxReviewEmail(subject: string, text: string): ParsedLooxReview {
  const subj = (subject ?? "").replace(/^(fwd?|fw|re):\s*/i, "").trim();
  const body = (text ?? "").replace(/\r\n/g, "\n");

  // ── rating ──────────────────────────────────────────────────────────────
  let rating: number | null = null;
  const stars = body.match(/(★+)(☆*)/);
  if (stars) rating = Math.min(5, stars[1].length);
  if (rating === null) {
    const outOf = body.match(/\b([1-5])\s*(?:out of|\/)\s*5\b/i);
    if (outOf) rating = Number(outOf[1]);
  }
  if (rating === null) {
    const labeled = body.match(/rating[:\s]+([1-5])\b/i);
    if (labeled) rating = Number(labeled[1]);
  }

  // ── product ─────────────────────────────────────────────────────────────
  let productTitle: string | null = null;
  const prodLine = body.match(/^\s*product[:\s]+(.{2,120})$/im);
  if (prodLine) productTitle = clean(prodLine[1]);
  if (!productTitle) {
    const subjProd = subj.match(/new review (?:for|of)\s+(.{2,120})$/i);
    if (subjProd) productTitle = clean(subjProd[1]);
  }
  if (!productTitle) {
    // "... left a review for <Product>" body phrasing
    const forProd = body.match(/left a .{0,20}review (?:for|on)\s+(.{2,120}?)[\n.!]/i);
    if (forProd) productTitle = clean(forProd[1]);
  }

  // ── reviewer ────────────────────────────────────────────────────────────
  let reviewerName: string | null = null;
  const left = body.match(/^\s*(.{2,60}?)\s+(?:left|wrote|added)\s+a\b/im);
  if (left) reviewerName = clean(left[1]);
  if (!reviewerName) {
    const by = body.match(/^\s*(?:by|from)[:\s]+(.{2,60})$/im);
    if (by) reviewerName = clean(by[1]);
  }

  // ── review text ─────────────────────────────────────────────────────────
  let reviewText: string | null = null;
  const quoted = body.match(/[“"]([^”"]{3,2000})[”"]/);
  if (quoted) reviewText = clean(quoted[1]);
  if (!reviewText) {
    const labeled = body.match(/^\s*review:\s*\n?\s*(.{3,2000}?)(?:\n\s*\n|$)/im);
    if (labeled) reviewText = clean(labeled[1]);
  }
  if (!reviewText) {
    // Fallback: longest paragraph that isn't boilerplate/links.
    const paras = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(
        (p) =>
          p.length >= 20 &&
          !/https?:\/\//i.test(p) &&
          !/unsubscribe|view in browser|reply to this|loox\.io|powered by/i.test(p) &&
          !/^[-_=*\s]+$/.test(p),
      );
    paras.sort((a, b) => b.length - a.length);
    if (paras[0]) reviewText = clean(paras[0]);
  }

  return {
    productTitle,
    rating,
    reviewerName,
    reviewText,
    parsed: rating !== null && (reviewText !== null || productTitle !== null),
  };
}
