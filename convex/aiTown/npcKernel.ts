// DF-style NPC kernel types ported from Doomsday/npc.py.
// MemoryEntry — a typed event/interpretation/narrative trace.
// ContactRecord — per-other-player relationship state.
//
// Decision-layer note: nothing here imports from any LLM client.
// Reads/writes happen from rules-only code (Agent.tick).

import { v, ObjectType } from 'convex/values';
import { agentId, playerId } from './ids';

// ─── Memory ──────────────────────────────────────────────────────────────────

export const memoryKind = v.union(
  v.literal('event'),
  v.literal('interpretation'),
  v.literal('narrative'),
);

export const memorySource = v.union(
  v.literal('observed'),
  v.literal('heard'),
  v.literal('inferred'),
);

export const emotionTag = v.union(
  v.literal('fear'),
  v.literal('gratitude'),
  v.literal('suspicion'),
  v.literal('shame'),
  v.literal('anger'),
  v.literal('attachment'),
  v.literal('numbness'),
  v.literal('awe'),
);

// MemoryEntry lives in its own table (`npcMemories`) — append-mostly,
// not part of game-engine state, so it doesn't bloat the per-step diff.
export const npcMemoryFields = {
  agentId,                          // owner
  kind: memoryKind,
  subject: v.string(),              // playerId, place tag, or topic
  contentToken: v.string(),         // structured short label
  confidence: v.number(),           // 0–1
  emotionalWeight: v.number(),      // -1..1
  emotion: v.optional(emotionTag),
  source: memorySource,
  distorted: v.boolean(),
  createdAt: v.number(),            // sim ms
};

// ─── ContactRecord ───────────────────────────────────────────────────────────

// Per-pair record. Lives inside agent's engine state (small bounded set),
// not in a separate table — tracked across ticks like any other engine state.
export const contactRecordFields = {
  playerId: playerId,
  interactionCount: v.number(),
  trust: v.number(),               // -1..1
  lastSeenAt: v.number(),          // sim ms; updated whenever within VISION_DISTANCE
  absenceSalience: v.number(),     // 0..1, rises with days absent for high-interaction pairs
  lastAction: v.string(),          // tag of most recent interaction (e.g. "talked", "ignored")
};
export type ContactRecord = ObjectType<typeof contactRecordFields>;

// Distance (tiles) within which a sighting registers. Bigger than
// CONVERSATION_DISTANCE — you see people further than you talk to them.
export const VISION_DISTANCE = 8;

// Per-NPC conversational patience in ms — how long this character will wait
// in awkward silence before either speaking first (as non-initiator) or
// breaking off (after the other party stopped responding).
//
// Replaces AI Town's flat AWKWARD_CONVERSATION_TIMEOUT global. Driven by
// personality so Bob the grumpy gardener gives up in 10s, while Pete the
// dutiful believer waits 80s. Per-NPC config is the right shape for
// individuation — different NPCs literally inhabit time differently.
type PatienceInput = {
  conscientiousness: number; agreeableness: number; loyalty: number;
  extraversion: number; neuroticism: number;
};
export function patienceMsFor(p: PatienceInput): number {
  let ms = 30_000;
  if (p.conscientiousness > 0.5) ms += 20_000;   // polite, won't bail early
  if (p.agreeableness > 0.5) ms += 20_000;       // accommodating
  if (p.loyalty > 0.5) ms += 30_000;             // sticks with people
  if (p.extraversion < -0.3) ms -= 20_000;       // introvert disengages
  if (p.neuroticism > 0.5) ms -= 20_000;         // anxious, impatient
  if (p.agreeableness < -0.3) ms -= 10_000;      // brusque, less tolerant
  return Math.max(10_000, Math.min(120_000, ms));
}
