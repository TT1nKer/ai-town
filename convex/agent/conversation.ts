import { v } from 'convex/values';
import { Id } from '../_generated/dataModel';
import { ActionCtx, internalQuery } from '../_generated/server';
import { LLMMessage, chatCompletion, getLLMConfig } from '../util/llm';
import * as memory from './memory';
import { api, internal } from '../_generated/api';
import * as embeddingsCache from './embeddingsCache';
import { GameId, conversationId, playerId } from '../aiTown/ids';
import { NUM_MEMORIES_TO_SEARCH } from '../constants';

const selfInternal = internal.agent.conversation;

// Day 5++: Native tool use via DeepSeek's OpenAI-compatible function calling.
// Replaces fragile prompt-based JSON output with strict-schema tool call.
//
// Architecture mapping:
//   "interpreter renders state"   → tool_call (fills slots)
//   "speech as a slot"            → speech: string (15-40 chars)
//   "tone as enum"                → tone: enum (drives UI emoji later)
//   "Sys 1 leave decision"        → should_leave: bool (sanity-check, doesn't override engine rule)
//   "no free-form text allowed"   → tool_choice: 'required'
//   "no extra fields allowed"     → strict: true + additionalProperties: false
//
// Why model='deepseek-chat' (not LLM_MODEL): the v4-flash model name triggers
// thinking mode by default, eating 70% of max_tokens on chain-of-thought before
// the actual tool call. 'deepseek-chat' is the alias for v4-flash non-thinking.
export type InterpreterResult = {
  speech: string;
  tone: string;
  shouldLeave: boolean;
};

export async function runInterpreterFull(
  promptHeader: string[],
  priorMessages: LLMMessage[] = [],
): Promise<InterpreterResult> {
  const config = getLLMConfig();
  const systemPrompt = promptHeader.filter(Boolean).join('\n');

  // F 配方: thinking enabled + tool_choice=auto + 强 prompt 强制调工具.
  // 实测 8/8 可靠,质量明显优于 deepseek-chat (non-thinking).
  // 关键: tool_choice="required" 在 thinking mode 下被 API 拒绝;但是
  // 在 system prompt 里强制要求调工具,LLM 自己会乖乖调.
  const enforceToolPrompt =
    systemPrompt + '\n\n你必须通过调用 speak_in_character 工具来输出回复。不要返回纯文本。';
  const body: any = {
    model: 'deepseek-v4-flash',
    thinking: { type: 'enabled' },
    messages: [{ role: 'system', content: enforceToolPrompt }, ...priorMessages],
    tools: [
      {
        type: 'function',
        function: {
          name: 'speak_in_character',
          strict: true,
          description: '以你扮演的角色身份说出一句话。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['speech', 'tone', 'should_leave'],
            properties: {
              speech: {
                type: 'string',
                description:
                  '一句中文台词,15-40字。只是说出口的话本身,不要任何动作描述、心理活动、括号内容、姓名前缀。不要英文。',
              },
              tone: {
                type: 'string',
                enum: ['疲惫', '敷衍', '热情', '警惕', '愠怒', '真诚', '客气', '犹豫'],
                description: '说这句话时的语气',
              },
              should_leave: {
                type: 'boolean',
                description: '说完这句话后是否应该结束对话离开(自然告别场景为 true)',
              },
            },
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 800,
    // temperature/top_p/penalty 在 thinking mode 下被静默忽略,不传
  };

  // Direct fetch with one retry on validation/parse error. No `chatCompletion`
  // helper here — we need the raw tool_calls field which that helper drops.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(config.url + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        lastErr = new Error(`Tool call HTTP ${response.status}: ${await response.text()}`);
        continue;
      }
      const json: any = await response.json();
      const toolCall = json.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall?.function?.arguments) {
        lastErr = new Error(`No tool call in response: ${JSON.stringify(json).slice(0, 300)}`);
        continue;
      }
      const args = JSON.parse(toolCall.function.arguments);
      if (typeof args.speech !== 'string' || args.speech.trim().length === 0) {
        lastErr = new Error(`Empty speech in tool call: ${toolCall.function.arguments}`);
        continue;
      }
      return {
        speech: args.speech.trim(),
        tone: typeof args.tone === 'string' ? args.tone : '客气',
        shouldLeave: args.should_leave === true,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn(`runInterpreterFull failed after retry: ${lastErr}`);
  return { speech: '...', tone: '犹豫', shouldLeave: false };
}

// Backward-compat shim: existing 3 message functions take a single string return.
// They use runInterpreterFull internally and discard tone/shouldLeave for now.
// (TODO: agent.ts could read shouldLeave to early-leave; for now System 1 rule handles it.)
async function runInterpreter(
  promptHeader: string[],
  priorMessages: LLMMessage[] = [],
): Promise<string> {
  const result = await runInterpreterFull(promptHeader, priorMessages);
  return result.speech;
}

export async function startConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<InterpreterResult> {
  const { player, otherPlayer, agent, otherAgent, myDailyEvents } = await ctx.runQuery(
    selfInternal.queryPromptData,
    { worldId, playerId, otherPlayerId, conversationId },
  );
  return runInterpreterFull([
    `你扮演角色"${player.name}"。`,
    agent ? `角色设定: ${agent.identity}` : '',
    agent ? `性格: ${describePersonality(agent.personality)}` : '',
    agent ? `当前内部状态: ${describeNeeds(agent.needs)}` : '',
    myDailyEvents.length > 0 ? `今日发生:\n- ${myDailyEvents.join('\n- ')}` : '',
    otherAgent
      ? `你跟"${otherPlayer.name}"开始一段对话。对方设定: ${otherAgent.identity}`
      : `你跟"${otherPlayer.name}"开始一段对话。`,
    `按你的人格和当前状态说出第一句话。如果"今日发生"里有适合提的事,可以提一句。`,
  ].filter(Boolean));
}

function trimContentPrefx(content: string, prompt: string) {
  if (content.startsWith(prompt)) {
    return content.slice(prompt.length).trim();
  }
  return content;
}

export async function continueConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<InterpreterResult> {
  const { player, otherPlayer, agent, otherAgent, myDailyEvents } = await ctx.runQuery(
    selfInternal.queryPromptData,
    { worldId, playerId, otherPlayerId, conversationId },
  );
  const prior = await previousMessages(ctx, worldId, player, otherPlayer, conversationId);
  return runInterpreterFull(
    [
      `你扮演角色"${player.name}"。`,
      agent ? `角色设定: ${agent.identity}` : '',
      agent ? `性格: ${describePersonality(agent.personality)}` : '',
      agent ? `当前内部状态: ${describeNeeds(agent.needs)}` : '',
      myDailyEvents.length > 0 ? `今日发生:\n- ${myDailyEvents.join('\n- ')}` : '',
      otherAgent ? `对方"${otherPlayer.name}"设定: ${otherAgent.identity}` : '',
      `你正在跟"${otherPlayer.name}"对话。下面是已经说过的话。`,
      `按你的人格和状态接着说一句话。可以提到"今日发生"里的事。不要重复打招呼。如果话题已尽或自然到了告别时刻,把 should_leave 设为 true。`,
    ].filter(Boolean),
    prior,
  );
}

export async function leaveConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<InterpreterResult> {
  const { player, otherPlayer, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    { worldId, playerId, otherPlayerId, conversationId },
  );
  void otherAgent;
  const prior = await previousMessages(ctx, worldId, player, otherPlayer, conversationId);
  return runInterpreterFull(
    [
      `你扮演角色"${player.name}"。`,
      agent ? `角色设定: ${agent.identity}` : '',
      agent ? `性格: ${describePersonality(agent.personality)}` : '',
      agent ? `当前内部状态: ${describeNeeds(agent.needs)}` : '',
      `你决定要离开跟"${otherPlayer.name}"的这场对话。`,
      `按你的人格,告别(礼貌或敷衍由人格决定)。should_leave 设为 true。`,
    ].filter(Boolean),
    prior,
  );
}

function agentPrompts(
  otherPlayer: { name: string },
  agent: { identity: string; plan: string } | null,
  otherAgent: { identity: string; plan: string } | null,
): string[] {
  const prompt = [];
  if (agent) {
    prompt.push(`About you: ${agent.identity}`);
    prompt.push(`Your goals for the conversation: ${agent.plan}`);
  }
  if (otherAgent) {
    prompt.push(`About ${otherPlayer.name}: ${otherAgent.identity}`);
  }
  return prompt;
}

function previousConversationPrompt(
  otherPlayer: { name: string },
  conversation: { created: number } | null,
): string[] {
  const prompt = [];
  if (conversation) {
    const prev = new Date(conversation.created);
    const now = new Date();
    prompt.push(
      `Last time you chatted with ${
        otherPlayer.name
      } it was ${prev.toLocaleString()}. It's now ${now.toLocaleString()}.`,
    );
  }
  return prompt;
}

function relatedMemoriesPrompt(memories: memory.Memory[]): string[] {
  const prompt = [];
  if (memories.length > 0) {
    prompt.push(`Here are some related memories in decreasing relevance order:`);
    for (const memory of memories) {
      prompt.push(' - ' + memory.description);
    }
  }
  return prompt;
}

async function previousMessages(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  conversationId: GameId<'conversations'>,
) {
  const llmMessages: LLMMessage[] = [];
  const prevMessages = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });
  for (const message of prevMessages) {
    const author = message.author === player.id ? player : otherPlayer;
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  return llmMessages;
}

export const queryPromptData = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    otherPlayerId: playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const otherPlayer = world.players.find((p) => p.id === args.otherPlayerId);
    if (!otherPlayer) {
      throw new Error(`Player ${args.otherPlayerId} not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${args.otherPlayerId} not found`);
    }
    const conversation = world.conversations.find((c) => c.id === args.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    if (!agentDescription) {
      throw new Error(`Agent description for ${agent.id} not found`);
    }
    const otherAgent = world.agents.find((a) => a.playerId === args.otherPlayerId);
    let otherAgentDescription;
    if (otherAgent) {
      otherAgentDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', otherAgent.id))
        .first();
      if (!otherAgentDescription) {
        throw new Error(`Agent description for ${otherAgent.id} not found`);
      }
    }
    const lastTogether = await ctx.db
      .query('participatedTogether')
      .withIndex('edge', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('player2', args.otherPlayerId),
      )
      // Order by conversation end time descending.
      .order('desc')
      .first();

    let lastConversation = null;
    if (lastTogether) {
      lastConversation = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) =>
          q.eq('worldId', args.worldId).eq('id', lastTogether.conversationId),
        )
        .first();
      if (!lastConversation) {
        throw new Error(`Conversation ${lastTogether.conversationId} not found`);
      }
    }
    return {
      player: { name: playerDescription.name, ...player },
      otherPlayer: { name: otherPlayerDescription.name, ...otherPlayer },
      conversation,
      agent: {
        identity: agentDescription.identity,
        plan: agentDescription.plan,
        personality: agentDescription.personality,
        ...agent,
      },
      otherAgent: otherAgent && {
        identity: otherAgentDescription!.identity,
        plan: otherAgentDescription!.plan,
        personality: otherAgentDescription!.personality,
        ...otherAgent,
      },
      lastConversation,
      myDailyEvents: agent.dailyEvents as string[],
      otherDailyEvents: (otherAgent?.dailyEvents ?? []) as string[],
    };
  },
});

// Helpers translating structured DF-style state → short Chinese phrase fragments
// for the LLM-as-Interpreter prompt. NOT for decision-making — these are
// rendering inputs only.
export function describePersonality(p: {
  openness: number; conscientiousness: number; extraversion: number;
  agreeableness: number; neuroticism: number; curiosity: number;
  courage: number; honesty: number; ambition: number; loyalty: number;
}): string {
  const tags: string[] = [];
  if (p.openness > 0.5) tags.push('开放好奇');
  else if (p.openness < -0.3) tags.push('保守抗拒新事物');
  if (p.extraversion > 0.5) tags.push('外向');
  else if (p.extraversion < -0.3) tags.push('内向');
  if (p.agreeableness > 0.5) tags.push('随和');
  else if (p.agreeableness < -0.3) tags.push('对抗');
  if (p.honesty < -0.3) tags.push('善于伪装');
  if (p.curiosity > 0.5) tags.push('好奇心强');
  if (p.courage < -0.2) tags.push('胆怯');
  if (p.loyalty > 0.5) tags.push('忠诚');
  else if (p.loyalty < -0.3) tags.push('不忠诚');
  if (p.neuroticism > 0.5) tags.push('情绪不稳');
  if (p.ambition > 0.5) tags.push('有野心');
  return tags.length ? tags.join('、') : '性格平和';
}

export function describeNeeds(n: {
  energy: number; social: number; safety: number; purpose: number; comfort: number;
}): string {
  const phrases: string[] = [];
  if (n.energy < 0.3) phrases.push('体力很低,有点累');
  else if (n.energy > 0.85) phrases.push('精神饱满');
  if (n.social < 0.3) phrases.push('感到孤独想聊天');
  else if (n.social > 0.85) phrases.push('心情愉悦');
  if (n.purpose < 0.4) phrases.push('觉得没什么意思');
  if (n.comfort < 0.3) phrases.push('心里有点不踏实');
  return phrases.length ? phrases.join(',') : '状态平稳';
}

function stopWords(otherPlayer: string, player: string) {
  // These are the words we ask the LLM to stop on. OpenAI only supports 4.
  const variants = [`${otherPlayer} to ${player}`];
  return variants.flatMap((stop) => [stop + ':', stop.toLowerCase() + ':']);
}
