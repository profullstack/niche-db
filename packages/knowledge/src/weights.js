/**
 * What each kind of contribution is worth, and what it takes to be believed.
 *
 * Impact over volume, everywhere. The reason someone cannot reach 80% by
 * submitting ten thousand tidy little corrections is in this table: the
 * things worth many points are the things somebody outside the submitter can
 * check — a conversion, a payment reference, a shipped change — and the
 * things easy to manufacture are worth two points and stop paying after the
 * first handful.
 *
 * Every number here is a default. Nothing in a route handler knows a weight.
 */

/**
 * `points`  what one accepted event is worth.
 * `max`     when set, the type takes a caller-supplied size and this clamps it.
 * `evidence` the event is worthless without something checkable attached.
 * `attribution` it claims money or a customer, so it needs an external
 *           reference (a payment, a lead, a commit) and never scores itself.
 * `diminishAfter` how many verified events of this type in the window count
 *           at full value before the type starts paying less.
 */
export const CONTRIBUTION_WEIGHTS = {
  // Knowledge
  knowledge_created: { points: 2, evidence: true, diminishAfter: 20 },
  knowledge_corrected: { points: 4, max: 50, evidence: true, diminishAfter: 20 },
  knowledge_verified: { points: 2, evidence: true, diminishAfter: 20 },
  workflow_documented: { points: 5, evidence: true, diminishAfter: 12 },
  competitor_insight: { points: 3, evidence: true, diminishAfter: 12 },

  // Sources and data
  source_added: { points: 2, evidence: true, diminishAfter: 15 },
  source_rejected: { points: 2, evidence: true, diminishAfter: 15 },
  dataset_improved: { points: 4, evidence: true, diminishAfter: 15 },
  record_corrected: { points: 4, evidence: true, diminishAfter: 25 },

  // Product
  product_idea: { points: 5, evidence: true, diminishAfter: 10 },
  feature_spec: { points: 5, evidence: true, diminishAfter: 10 },
  feature_review: { points: 3, evidence: true, diminishAfter: 12 },
  integration_proposed: { points: 3, evidence: true, diminishAfter: 10 },
  integration_validated: { points: 5, evidence: true, diminishAfter: 10 },
  // A change that shipped and moved a number. The number is the evidence.
  software_shipped: { points: 10, max: 30, evidence: true, attribution: true },

  // The agent asked, a human answered, the answer went into the niche.
  agent_answer: { points: 3, evidence: true, diminishAfter: 30 },

  // Promotion. Posting is not the contribution; what the post did is.
  promotion_idea: { points: 2, evidence: true, diminishAfter: 10 },
  promotion_approved: { points: 1, evidence: true, diminishAfter: 10 },
  promotion_result: { points: 5, max: 25, evidence: true, attribution: true },

  // Business
  lead_generated: { points: 8, evidence: true, attribution: true },
  customer_referred: { points: 8, evidence: true, attribution: true },
  customer_converted: { points: 20, evidence: true, attribution: true },
  revenue_influenced: { points: 20, max: 100, evidence: true, attribution: true },
  specialist_recruited: { points: 8, evidence: true, attribution: true },

  // An admin's thumb on the scale, always with a reason, always audited.
  manual_adjustment: { points: 0, max: 500, evidence: true, attribution: true },
};

/** The event types this program knows. Anything else is refused on the way in. */
export const CONTRIBUTION_EVENT_TYPES = Object.keys(CONTRIBUTION_WEIGHTS);

export const isKnownEventType = (type) => Object.hasOwn(CONTRIBUTION_WEIGHTS, String(type ?? ''));

/**
 * How long the diminishing-returns window looks back. Thirty days, so a type
 * that stopped paying recovers for someone who keeps contributing across
 * months rather than in one afternoon.
 */
export const DIMINISH_WINDOW_DAYS = 30;

/**
 * How many verified events someone needs in a niche before the low-risk types
 * score without an admin reading them first. Below it everything waits; above
 * it, only the things that claim money still do.
 */
export const TRUST_THRESHOLD = 25;

/** A type nobody can self-award: it claims money, a customer or a shipped change. */
export const needsAttribution = (type) => Boolean(CONTRIBUTION_WEIGHTS[type]?.attribution);
