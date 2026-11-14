import { comparisonKey } from "./text";
import type { TriggerKind } from "./limits";
import type { Trigger } from "./types";

// Run-time trigger matching (Phase 08E-1; owner decisions O-1, O-1b, C-1 to C-3; plan section D.4). PURE: no database, no
// clock, no randomness. It lives next to `comparisonKey` so the validator (which rejects duplicate keywords with that key)
// and the runtime can never disagree about what "the same word" means. It decides ONLY whether a message satisfies a
// published trigger; whether a session may start at all (staff, cooldown, caps, deployment) is the runtime's.
//
// The two facts that need the database (first eligible message, recorded attribution) are computed by the runtime under
// the conversation lock and passed in; this function never infers them.

/** Message types that can create a trigger at all (V3.2 H.1) and that may match `first_message` and `referral_source`. */
export const TRIGGER_ELIGIBLE_TYPES = ["TEXT", "INTERACTIVE", "BUTTON"] as const;
export type TriggerEligibleType = (typeof TRIGGER_ELIGIBLE_TYPES)[number];

export function isTriggerEligibleType(type: string): type is TriggerEligibleType {
  return (TRIGGER_ELIGIBLE_TYPES as readonly string[]).includes(type);
}

/**
 * The comparison key of a keyword or a message body: NFC, trimmed, lower-cased with the locale-independent Unicode mapping of
 * String.prototype.toLowerCase (NOT ASCII-only, NOT full case folding: no accent stripping, no compatibility folding, joiners
 * kept). It is the validator's `comparisonKey`, re-exported under the name the matching rule uses.
 */
export const triggerKey = comparisonKey;

export type TriggerMessage = {
  /** The persisted message type (messages.type). */
  readonly type: string;
  /** The persisted body: the text of a TEXT message. */
  readonly body: string | null;
};

export type TriggerFacts = {
  /** D.4a: the candidate is the first eligible inbound message of its conversation, record history and session history. */
  readonly firstEligible: boolean;
  /** C-3: a lead_attributions row exists for this exact message, organization and contact. */
  readonly hasAttribution: boolean;
};

export type TriggerMatch = { readonly index: number; readonly kind: TriggerKind };

/**
 * The first trigger, in array order, that this message satisfies; null when none does.
 *  - keyword: a TEXT message whose whole trimmed body equals a configured word (never a substring, never BUTTON/INTERACTIVE);
 *  - first_message: an eligible message type (TEXT, INTERACTIVE or BUTTON) while `facts.firstEligible` holds;
 *  - referral_source: an eligible message type while `facts.hasAttribution` holds.
 */
export function matchTrigger(
  triggers: readonly Trigger[],
  message: TriggerMessage,
  facts: TriggerFacts,
): TriggerMatch | null {
  const eligible = isTriggerEligibleType(message.type);
  const key = message.type === "TEXT" && message.body !== null ? triggerKey(message.body) : null;
  for (let index = 0; index < triggers.length; index++) {
    const trigger = triggers[index]!;
    switch (trigger.kind) {
      case "keyword":
        if (key !== null && trigger.words.some((word) => triggerKey(word) === key))
          return { index, kind: "keyword" };
        break;
      case "first_message":
        if (eligible && facts.firstEligible) return { index, kind: "first_message" };
        break;
      case "referral_source":
        if (eligible && facts.hasAttribution) return { index, kind: "referral_source" };
        break;
    }
  }
  return null;
}

/** One deployment as start matching sees it: its bot key (for reporting), its priority and its pinned version's triggers. */
export type RoutedDeployment = {
  readonly key: string;
  readonly priority: number;
  readonly triggers: readonly Trigger[];
};

/**
 * A pair of deployments whose order makes start matching route a message to the wrong bot (owner decision OD-1, 08G-7A):
 *  - catch_all_first: `first` has a first_message or referral_source trigger and precedes `then`, which has keywords, so a
 *    keyword sent as a first (or attributed) message starts `first`;
 *  - shared_keyword: both have a keyword with the same comparison key, so `then` never starts by it.
 */
export type RoutingConflict = {
  readonly kind: "catch_all_first" | "shared_keyword";
  readonly first: string;
  readonly then: string;
};

/**
 * Every routing conflict among deployments that are matched together (the ACTIVE deployments of one account), in matching
 * order: ascending priority, as the runtime tries them. Priorities are unique per account, so the key tie-break only keeps
 * the result deterministic. An empty result means no message can reach a bot other than the one its keyword names.
 */
export function routingConflicts(deployments: readonly RoutedDeployment[]): RoutingConflict[] {
  const ordered = [...deployments].sort(
    (a, b) => a.priority - b.priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const keywords = ordered.map(
    (d) =>
      new Set(d.triggers.flatMap((t) => (t.kind === "keyword" ? t.words.map(triggerKey) : []))),
  );
  const conflicts: RoutingConflict[] = [];
  for (let i = 0; i < ordered.length; i++)
    for (let j = i + 1; j < ordered.length; j++) {
      const pair = { first: ordered[i]!.key, then: ordered[j]!.key };
      if (ordered[i]!.triggers.some((t) => t.kind !== "keyword") && keywords[j]!.size > 0)
        conflicts.push({ kind: "catch_all_first", ...pair });
      if ([...keywords[j]!].some((k) => keywords[i]!.has(k)))
        conflicts.push({ kind: "shared_keyword", ...pair });
    }
  return conflicts;
}
