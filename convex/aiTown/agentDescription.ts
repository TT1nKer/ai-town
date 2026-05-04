import { ObjectType, v } from 'convex/values';
import { GameId, agentId, parseGameId } from './ids';

export const personalityFields = {
  openness: v.number(),
  conscientiousness: v.number(),
  extraversion: v.number(),
  agreeableness: v.number(),
  neuroticism: v.number(),
  curiosity: v.number(),
  courage: v.number(),
  honesty: v.number(),
  ambition: v.number(),
  loyalty: v.number(),
};
export type Personality = ObjectType<typeof personalityFields>;

export class AgentDescription {
  agentId: GameId<'agents'>;
  identity: string;
  plan: string;
  personality: Personality;

  constructor(serialized: SerializedAgentDescription) {
    const { agentId, identity, plan, personality } = serialized;
    this.agentId = parseGameId('agents', agentId);
    this.identity = identity;
    this.plan = plan;
    this.personality = personality;
  }

  serialize(): SerializedAgentDescription {
    const { agentId, identity, plan, personality } = this;
    return { agentId, identity, plan, personality };
  }
}

export const serializedAgentDescription = {
  agentId,
  identity: v.string(),
  plan: v.string(),
  personality: v.object(personalityFields),
};
export type SerializedAgentDescription = ObjectType<typeof serializedAgentDescription>;
