import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { looxProducts, looxReviews } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

// On-demand Claude chat over a product's reviews (Scott 2026-07-13 v2 scope:
// no scheduled analysis — Claude runs only when someone asks a question, so
// the only recurring cost is the free DB storage). Every matching review
// goes into the context in full; two system-prompt modes cover the two
// audiences Scott named:
//   marketing — positives, features, benefits, angles, copy
//   product   — balanced read for product development; careful about false
//               info and thin data
// "Show me all matching reviews in full" works without burning output
// tokens on re-typing them: Claude cites review numbers in a
// <review-ids>1,2,3</review-ids> tag and the server renders those reviews
// verbatim from the DB alongside the answer.

export const LOOX_CHAT_MODEL = "claude-opus-4-8";
const MAX_CONTEXT_REVIEWS = 12_000; // ~500k tokens worst case, inside 1M

// Injectable for tests: (system, messages) -> raw model text.
export type ChatTransport = (
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
) => Promise<string>;

function defaultTransport(): ChatTransport | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  return async (system, messages) => {
    // Streaming keeps long generations from tripping request timeouts; the
    // caller still gets one final message.
    const stream = client.messages.stream({
      model: LOOX_CHAT_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text" as const,
          text: system,
          // The system prompt embeds every review — cache it so follow-up
          // questions in the same conversation reprice at ~1/10th.
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages,
    });
    const msg = await stream.finalMessage();
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}

const MODE_PROMPTS = {
  marketing: `You are a marketing analyst for Everdries, a leakproof underwear
brand. You have every customer review for one product below. Marketers use
you to find positives, favorite features, benefits customers actually felt,
audience personas, marketing angles, and ad copy grounded in real customer
language. Prefer quoting or closely paraphrasing what reviewers actually
wrote. Never invent claims that no reviewer made.`,
  product: `You are a product analyst for Everdries, a leakproof underwear
brand. You have every customer review for one product below. Product
developers use you for a balanced read: recurring complaints, sizing and fit
issues, quality problems, and improvement ideas. Be careful and literal —
never state something as customer feedback unless reviewers actually said
it, call out when a pattern rests on only a handful of reviews, and say so
plainly when the data is too thin to support a conclusion.`,
} as const;

const SHARED_RULES = `
Each review below is numbered. When you reference specific reviews, cite
their numbers. If the user asks to see matching reviews in full (a document
of them, the complete list, etc.), do NOT retype review text — instead end
your reply with a single tag listing the numbers, like
<review-ids>12,45,101</review-ids>, and the system will attach those reviews
verbatim. Keep the tag on its own line. Otherwise, answer normally.`;

export type LooxChatMode = keyof typeof MODE_PROMPTS;

export type LooxChatResult = {
  configured: boolean;
  answer: string;
  reviewCount: number;
  verbatim: {
    reviewedAt: Date | null;
    rating: number | null;
    reviewerName: string | null;
    reviewText: string | null;
  }[];
};

export async function runLooxChat(input: {
  displayName: string;
  line?: "std" | "heavy";
  mode: LooxChatMode;
  status?: "published" | "pending" | "all";
  buyers?: "all" | "verified";
  messages: { role: "user" | "assistant"; content: string }[];
  from?: Date;
  to?: Date;
  transport?: ChatTransport;
}): Promise<LooxChatResult> {
  const transport = input.transport ?? defaultTransport();
  if (!transport) {
    return { configured: false, answer: "", reviewCount: 0, verbatim: [] };
  }

  const status = input.status ?? "published";
  const conds = [
    sql`coalesce(${looxProducts.displayName}, ${looxReviews.productTitle}) = ${input.displayName}`,
    sql`coalesce(${looxProducts.line}, 'std') = ${input.line ?? "std"}`,
    eq(looxReviews.parsed, true),
  ];
  if (status === "published")
    conds.push(or(eq(looxReviews.status, "published"), sql`${looxReviews.status} is null`)!);
  else if (status === "pending") conds.push(eq(looxReviews.status, "pending"));
  if (input.buyers === "verified") conds.push(eq(looxReviews.purchaseVerified, "verified"));
  // ISO strings, not Date objects: inside a raw sql`` fragment the driver
  // can't infer the param type and refuses to serialize a Date.
  if (input.from)
    conds.push(gte(sql`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`, input.from.toISOString()));
  if (input.to)
    conds.push(lte(sql`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`, input.to.toISOString()));

  const reviews = await db
    .select({
      id: looxReviews.id,
      reviewedAt: sql<Date>`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`,
      rating: looxReviews.rating,
      reviewerName: looxReviews.reviewerName,
      reviewText: looxReviews.reviewText,
      verified: looxReviews.verified,
    })
    .from(looxReviews)
    .leftJoin(looxProducts, eq(looxProducts.handle, looxReviews.productHandle))
    .where(and(...conds))
    .orderBy(asc(sql`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`))
    .limit(MAX_CONTEXT_REVIEWS);

  const doc = reviews
    .map((r, i) => {
      const date = r.reviewedAt ? new Date(r.reviewedAt).toISOString().slice(0, 10) : "?";
      const ver = r.verified ? " (verified)" : "";
      return `#${i + 1} [${r.rating ?? "?"}/5] ${r.reviewerName ?? "anonymous"} ${date}${ver}: ${(r.reviewText ?? "(no text)").replace(/\s+/g, " ")}`;
    })
    .join("\n");

  const system = `${MODE_PROMPTS[input.mode]}\n${SHARED_RULES}\n\nProduct: ${input.displayName}\nReviews (${reviews.length} total, oldest first):\n\n${doc}`;

  const raw = await transport(system, input.messages);

  // Resolve a <review-ids> tag into verbatim reviews from the DB.
  const verbatim: LooxChatResult["verbatim"] = [];
  const tag = raw.match(/<review-ids>([\d,\s]+)<\/review-ids>/i);
  let answer = raw;
  if (tag) {
    answer = raw.replace(tag[0], "").trim();
    const nums = [
      ...new Set(
        tag[1]
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= reviews.length),
      ),
    ];
    const byId = new Map(reviews.map((r, i) => [i + 1, r]));
    const ids = nums.map((n) => byId.get(n)!.id);
    // Re-select so the attachment is exactly what the DB holds, not the
    // whitespace-collapsed context copy.
    if (ids.length > 0) {
      const rows = await db
        .select({
          id: looxReviews.id,
          reviewedAt: sql<Date>`coalesce(${looxReviews.reviewedAt}, ${looxReviews.receivedAt})`,
          rating: looxReviews.rating,
          reviewerName: looxReviews.reviewerName,
          reviewText: looxReviews.reviewText,
        })
        .from(looxReviews)
        .where(inArray(looxReviews.id, ids));
      const order = new Map(ids.map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      verbatim.push(...rows.map(({ id: _id, ...rest }) => rest));
    }
  }

  logger.info("loox.chat.answered", {
    displayName: input.displayName,
    mode: input.mode,
    reviewCount: reviews.length,
    verbatim: verbatim.length,
  });
  return { configured: true, answer, reviewCount: reviews.length, verbatim };
}

// Used by the readiness surfaces: which parts of the pipeline have creds?
export function looxConfigured(): { api: boolean; imap: boolean; anthropic: boolean } {
  return {
    api: !!(process.env.LOOX_MAIN_STORE_ID?.trim() && process.env.LOOX_MAIN_SECRET?.trim()),
    imap: !!(process.env.LOOX_IMAP_USER?.trim() && process.env.LOOX_IMAP_PASSWORD?.trim()),
    anthropic: !!process.env.ANTHROPIC_API_KEY?.trim(),
  };
}
