import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId } from './ids';
import { agentId, conversationId, playerId } from './ids';
import { serializedPlayer } from './player';
import { Game } from './game';
import {
  ACTION_TIMEOUT,
  AWKWARD_CONVERSATION_TIMEOUT,
  CONVERSATION_COOLDOWN,
  CONVERSATION_DISTANCE,
  INVITE_ACCEPT_PROBABILITY,
  INVITE_TIMEOUT,
  MAX_CONVERSATION_DURATION,
  MAX_CONVERSATION_MESSAGES,
  MESSAGE_COOLDOWN,
  MIDPOINT_THRESHOLD,
  PLAYER_CONVERSATION_COOLDOWN,
} from '../constants';
import { FunctionArgs } from 'convex/server';
import { MutationCtx, internalMutation, internalQuery } from '../_generated/server';
import { distance } from '../util/geometry';
import { internal } from '../_generated/api';
import { movePlayer } from './movement';
import { insertInput } from './insertInput';
import { ContactRecord, contactRecordFields, VISION_DISTANCE, patienceMsFor } from './npcKernel';
import { Conversation } from './conversation';

export class Agent {
  id: GameId<'agents'>;
  playerId: GameId<'players'>;
  needs: Needs;
  contacts: ContactRecord[];
  dailyEvents: string[];
  toRemember?: GameId<'conversations'>;
  lastConversation?: number;
  lastInviteAttempt?: number;
  inProgressOperation?: {
    name: string;
    operationId: string;
    started: number;
  };

  constructor(serialized: SerializedAgent) {
    const { id, lastConversation, lastInviteAttempt, inProgressOperation, needs, contacts, dailyEvents } =
      serialized;
    const playerId = parseGameId('players', serialized.playerId);
    this.id = parseGameId('agents', id);
    this.playerId = playerId;
    this.needs = needs;
    this.contacts = contacts;
    this.dailyEvents = dailyEvents;
    this.toRemember =
      serialized.toRemember !== undefined
        ? parseGameId('conversations', serialized.toRemember)
        : undefined;
    this.lastConversation = lastConversation;
    this.lastInviteAttempt = lastInviteAttempt;
    this.inProgressOperation = inProgressOperation;
  }

  // Doomsday-style proximity update: any other player within VISION_DISTANCE
  // tiles updates that contact's lastSeenAt; new sightings create a record.
  // Pure rules — no LLM, no decision-side effects.
  updateContacts(game: Game, now: number) {
    const me = game.world.players.get(this.playerId);
    if (!me) return;
    for (const other of game.world.players.values()) {
      if (other.id === me.id) continue;
      if (distance(me.position, other.position) > VISION_DISTANCE) continue;
      const existing = this.contacts.find((c) => c.playerId === other.id);
      if (existing) {
        existing.lastSeenAt = now;
      } else {
        this.contacts.push({
          playerId: other.id,
          interactionCount: 0,
          trust: 0,
          lastSeenAt: now,
          absenceSalience: 0,
          lastAction: 'sighted',
        });
      }
    }
  }

  // Per-tick needs decay/recovery. Energy recovers while resting; social
  // recovers while anyone else is within sight. Others slow-decay only (Day 4 v0).
  decayNeeds(game: Game, now: number) {
    const me = game.world.players.get(this.playerId);
    if (!me) return;

    const isResting =
      me.activity?.description === 'resting' && me.activity.until > now;
    const nearAnyone = [...game.world.players.values()].some(
      (p) => p.id !== me.id && distance(me.position, p.position) <= VISION_DISTANCE,
    );

    this.needs.energy = isResting
      ? Math.min(1, this.needs.energy + 0.002)
      : Math.max(0, this.needs.energy - 0.0001);
    this.needs.social = nearAnyone
      ? Math.min(1, this.needs.social + 0.0003)
      : Math.max(0, this.needs.social - 0.0003);
    this.needs.safety = Math.max(0, this.needs.safety - 0.00005);
    this.needs.purpose = Math.max(0, this.needs.purpose - 0.00005);
    this.needs.comfort = Math.max(0, this.needs.comfort - 0.0001);
  }

  // Rule-based action selection driven by needs. Replaces AI Town's LLM-driven
  // `agentDoSomething` for idle agents. Three minimal actions:
  //   energy < 0.3                     → rest (raises energy over 8s)
  //   social < 0.5 and contacts exist  → walk toward most recently seen contact
  //   otherwise                        → wander to a random tile
  pickAndApplyAction(game: Game, now: number) {
    const me = game.world.players.get(this.playerId);
    if (!me) return;

    if (this.needs.energy < 0.3) {
      // rest: clear any in-flight pathfinding so doingActivity doesn't get
      // cut short by the (doingActivity && pathfinding) rule above.
      if (me.pathfinding) delete me.pathfinding;
      me.activity = { description: 'resting', emoji: '😴', until: now + 8000 };
      return;
    }

    // Needs-driven conversation initiation (System 1, no LLM).
    // If lonely AND a familiar contact is within talking range AND not already
    // in conversation, fire startConversation. The LLM-as-Interpreter only
    // renders the resulting dialogue (in convex/agent/conversation.ts).
    const recentlyTriedInvite =
      this.lastInviteAttempt && now < this.lastInviteAttempt + CONVERSATION_COOLDOWN;
    if (this.needs.social < 0.5 && this.contacts.length > 0 && !recentlyTriedInvite) {
      const sorted = [...this.contacts].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      for (const contact of sorted) {
        const other = game.world.players.get(contact.playerId as GameId<'players'>);
        if (!other) continue;
        const dist = distance(me.position, other.position);
        if (dist <= CONVERSATION_DISTANCE) {
          // Skip if either is already in a conversation.
          const alreadyTalking = [...game.world.conversations.values()].some(
            (c) => c.participants.has(me.id) || c.participants.has(other.id),
          );
          if (alreadyTalking) continue;
          if (me.activity) me.activity = { ...me.activity, until: now };
          this.lastInviteAttempt = now;
          Conversation.start(game, now, me, other);
          return;
        }
      }
    }

    if (this.needs.social < 0.5 && this.contacts.length > 0) {
      // Not within talking range yet — walk toward most recently seen contact.
      const sorted = [...this.contacts].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      for (const contact of sorted) {
        const other = game.world.players.get(contact.playerId as GameId<'players'>);
        if (other) {
          if (me.activity) me.activity = { ...me.activity, until: now };
          movePlayer(game, now, me, {
            x: Math.floor(other.position.x),
            y: Math.floor(other.position.y),
          });
          return;
        }
      }
    }

    if (me.activity) me.activity = { ...me.activity, until: now };
    movePlayer(game, now, me, {
      x: Math.floor(Math.random() * game.worldMap.width),
      y: Math.floor(Math.random() * game.worldMap.height),
    });
  }

  tick(game: Game, now: number) {
    const player = game.world.players.get(this.playerId);
    if (!player) {
      throw new Error(`Invalid player ID ${this.playerId}`);
    }
    // DF-style proximity-driven contact update runs every tick (cheap; bounded by VISION_DISTANCE).
    this.updateContacts(game, now);
    this.decayNeeds(game, now);
    if (this.inProgressOperation) {
      if (now < this.inProgressOperation.started + ACTION_TIMEOUT) {
        // Wait on the operation to finish.
        return;
      }
      console.log(`Timing out ${JSON.stringify(this.inProgressOperation)}`);
      delete this.inProgressOperation;
    }
    const conversation = game.world.playerConversation(player);
    const member = conversation?.participants.get(player.id);

    const recentlyAttemptedInvite =
      this.lastInviteAttempt && now < this.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const doingActivity = player.activity && player.activity.until > now;
    if (doingActivity && (conversation || player.pathfinding)) {
      player.activity!.until = now;
    }
    // Day 4: rule-based, needs-driven action selection replaces the LLM-driven
    // `agentDoSomething` operation. recentlyAttemptedInvite is unused now (no invites yet).
    void recentlyAttemptedInvite;
    if (!conversation && !doingActivity && !player.pathfinding) {
      this.pickAndApplyAction(game, now);
      return;
    }
    // Day 5: skip agentRememberConversation entirely — it relies on embedding-based
    // memory which DeepSeek doesn't provide. Day 6 will write structured npcMemory
    // entries instead. For now just clear the flag without firing the LLM operation.
    if (this.toRemember) {
      delete this.toRemember;
    }
    if (conversation && member) {
      const [otherPlayerId, otherMember] = [...conversation.participants.entries()].find(
        ([id]) => id !== player.id,
      )!;
      const otherPlayer = game.world.players.get(otherPlayerId)!;
      if (member.status.kind === 'invited') {
        // Accept a conversation with another agent with some probability and with
        // a human unconditionally.
        if (otherPlayer.human || Math.random() < INVITE_ACCEPT_PROBABILITY) {
          console.log(`Agent ${player.id} accepting invite from ${otherPlayer.id}`);
          conversation.acceptInvite(game, player);
          // Stop moving so we can start walking towards the other player.
          if (player.pathfinding) {
            delete player.pathfinding;
          }
        } else {
          console.log(`Agent ${player.id} rejecting invite from ${otherPlayer.id}`);
          conversation.rejectInvite(game, now, player);
        }
        return;
      }
      if (member.status.kind === 'walkingOver') {
        // Leave a conversation if we've been waiting for too long.
        if (member.invited + INVITE_TIMEOUT < now) {
          console.log(`Giving up on invite to ${otherPlayer.id}`);
          conversation.leave(game, now, player);
          return;
        }

        // Don't keep moving around if we're near enough.
        const playerDistance = distance(player.position, otherPlayer.position);
        if (playerDistance < CONVERSATION_DISTANCE) {
          return;
        }

        // Keep moving towards the other player.
        // If we're close enough to the player, just walk to them directly.
        if (!player.pathfinding) {
          let destination;
          if (playerDistance < MIDPOINT_THRESHOLD) {
            destination = {
              x: Math.floor(otherPlayer.position.x),
              y: Math.floor(otherPlayer.position.y),
            };
          } else {
            destination = {
              x: Math.floor((player.position.x + otherPlayer.position.x) / 2),
              y: Math.floor((player.position.y + otherPlayer.position.y) / 2),
            };
          }
          console.log(`Agent ${player.id} walking towards ${otherPlayer.id}...`, destination);
          movePlayer(game, now, player, destination);
        }
        return;
      }
      if (member.status.kind === 'participating') {
        const started = member.status.started;
        if (conversation.isTyping && conversation.isTyping.playerId !== player.id) {
          // Wait for the other player to finish typing.
          return;
        }
        if (!conversation.lastMessage) {
          const isInitiator = conversation.creator === player.id;
          // Per-NPC patience replaces flat AWKWARD_CONVERSATION_TIMEOUT.
          const myPersonalityForPatience = game.agentDescriptions.get(this.id)?.personality;
          const myPatience = myPersonalityForPatience
            ? patienceMsFor(myPersonalityForPatience)
            : AWKWARD_CONVERSATION_TIMEOUT;
          const awkwardDeadline = started + myPatience;
          // Send the first message if we're the initiator or if we've been waiting for too long.
          if (isInitiator || awkwardDeadline < now) {
            // Grab the lock on the conversation and send a "start" message.
            console.log(`${player.id} initiating conversation with ${otherPlayer.id}.`);
            const messageUuid = crypto.randomUUID();
            conversation.setIsTyping(now, player, messageUuid);
            this.startOperation(game, now, 'agentGenerateMessage', {
              worldId: game.worldId,
              playerId: player.id,
              agentId: this.id,
              conversationId: conversation.id,
              otherPlayerId: otherPlayer.id,
              messageUuid,
              type: 'start',
            });
            return;
          } else {
            // Wait on the other player to say something up to the awkward deadline.
            return;
          }
        }
        // See if the conversation has been going on too long and decide to leave.
        // Day 5++: System 1 needs-driven leave — but ONLY for NPC↔NPC conversations.
        // For human↔NPC chats, let the human decide when it's over (close pane /
        // walk away). NPCs auto-leaving while a human is mid-thought feels jarring.
        const tooLongDeadline = started + MAX_CONVERSATION_DURATION;
        const otherIsHuman = !!otherPlayer.human;
        const myDescription = game.agentDescriptions.get(this.id);
        const myExtraversion = myDescription?.personality.extraversion ?? 0;
        const numMessages = conversation.numMessages;
        const socialMet = this.needs.social >= 0.7;
        const introvert = myExtraversion < -0.2;
        const earlyLeave =
          !otherIsHuman &&
          ((numMessages >= 4 && socialMet) || (numMessages >= 6 && introvert));
        if (
          tooLongDeadline < now ||
          conversation.numMessages > MAX_CONVERSATION_MESSAGES ||
          earlyLeave
        ) {
          console.log(`${player.id} leaving conversation with ${otherPlayer.id}.`);
          const messageUuid = crypto.randomUUID();
          conversation.setIsTyping(now, player, messageUuid);
          this.startOperation(game, now, 'agentGenerateMessage', {
            worldId: game.worldId,
            playerId: player.id,
            agentId: this.id,
            conversationId: conversation.id,
            otherPlayerId: otherPlayer.id,
            messageUuid,
            type: 'leave',
          });
          return;
        }
        // Wait for the awkward deadline if we sent the last message.
        if (conversation.lastMessage.author === player.id) {
          const myPersonalityForPatience2 = game.agentDescriptions.get(this.id)?.personality;
          const myPatience2 = myPersonalityForPatience2
            ? patienceMsFor(myPersonalityForPatience2)
            : AWKWARD_CONVERSATION_TIMEOUT;
          const awkwardDeadline = conversation.lastMessage.timestamp + myPatience2;
          if (now < awkwardDeadline) {
            return;
          }
        }
        // Wait for a cooldown after the last message to simulate "reading" the message.
        const messageCooldown = conversation.lastMessage.timestamp + MESSAGE_COOLDOWN;
        if (now < messageCooldown) {
          return;
        }
        // Grab the lock and send a message!
        console.log(`${player.id} continuing conversation with ${otherPlayer.id}.`);
        const messageUuid = crypto.randomUUID();
        conversation.setIsTyping(now, player, messageUuid);
        this.startOperation(game, now, 'agentGenerateMessage', {
          worldId: game.worldId,
          playerId: player.id,
          agentId: this.id,
          conversationId: conversation.id,
          otherPlayerId: otherPlayer.id,
          messageUuid,
          type: 'continue',
        });
        return;
      }
    }
  }

  startOperation<Name extends keyof AgentOperations>(
    game: Game,
    now: number,
    name: Name,
    args: Omit<FunctionArgs<AgentOperations[Name]>, 'operationId'>,
  ) {
    if (this.inProgressOperation) {
      throw new Error(
        `Agent ${this.id} already has an operation: ${JSON.stringify(this.inProgressOperation)}`,
      );
    }
    const operationId = game.allocId('operations');
    console.log(`Agent ${this.id} starting operation ${name} (${operationId})`);
    game.scheduleOperation(name, { operationId, ...args } as any);
    this.inProgressOperation = {
      name,
      operationId,
      started: now,
    };
  }

  serialize(): SerializedAgent {
    return {
      id: this.id,
      playerId: this.playerId,
      needs: this.needs,
      contacts: this.contacts,
      dailyEvents: this.dailyEvents,
      toRemember: this.toRemember,
      lastConversation: this.lastConversation,
      lastInviteAttempt: this.lastInviteAttempt,
      inProgressOperation: this.inProgressOperation,
    };
  }
}

export const needsFields = {
  energy: v.number(),
  social: v.number(),
  safety: v.number(),
  purpose: v.number(),
  comfort: v.number(),
};
export type Needs = ObjectType<typeof needsFields>;

export const serializedAgent = {
  id: agentId,
  playerId: playerId,
  needs: v.object(needsFields),
  contacts: v.array(v.object(contactRecordFields)),
  dailyEvents: v.array(v.string()),
  toRemember: v.optional(conversationId),
  lastConversation: v.optional(v.number()),
  lastInviteAttempt: v.optional(v.number()),
  inProgressOperation: v.optional(
    v.object({
      name: v.string(),
      operationId: v.string(),
      started: v.number(),
    }),
  ),
};
export type SerializedAgent = ObjectType<typeof serializedAgent>;

type AgentOperations = typeof internal.aiTown.agentOperations;

export async function runAgentOperation(ctx: MutationCtx, operation: string, args: any) {
  let reference;
  switch (operation) {
    case 'agentRememberConversation':
      reference = internal.aiTown.agentOperations.agentRememberConversation;
      break;
    case 'agentGenerateMessage':
      reference = internal.aiTown.agentOperations.agentGenerateMessage;
      break;
    case 'agentDoSomething':
      reference = internal.aiTown.agentOperations.agentDoSomething;
      break;
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
  await ctx.scheduler.runAfter(0, reference, args);
}

export const agentSendMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    agentId,
    playerId,
    text: v.string(),
    messageUuid: v.string(),
    leaveConversation: v.boolean(),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      text: args.text,
      messageUuid: args.messageUuid,
      worldId: args.worldId,
    });
    await insertInput(ctx, args.worldId, 'agentFinishSendingMessage', {
      conversationId: args.conversationId,
      agentId: args.agentId,
      timestamp: Date.now(),
      leaveConversation: args.leaveConversation,
      operationId: args.operationId,
    });
  },
});

export const findConversationCandidate = internalQuery({
  args: {
    now: v.number(),
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
  },
  handler: async (ctx, { now, worldId, player, otherFreePlayers }) => {
    const { position } = player;
    const candidates = [];

    for (const otherPlayer of otherFreePlayers) {
      // Find the latest conversation we're both members of.
      const lastMember = await ctx.db
        .query('participatedTogether')
        .withIndex('edge', (q) =>
          q.eq('worldId', worldId).eq('player1', player.id).eq('player2', otherPlayer.id),
        )
        .order('desc')
        .first();
      if (lastMember) {
        if (now < lastMember.ended + PLAYER_CONVERSATION_COOLDOWN) {
          continue;
        }
      }
      candidates.push({ id: otherPlayer.id, position });
    }

    // Sort by distance and take the nearest candidate.
    candidates.sort((a, b) => distance(a.position, position) - distance(b.position, position));
    return candidates[0]?.id;
  },
});
