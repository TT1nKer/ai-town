# AI Town 🏠💻💌 (DF-style fork)

> **Fork 自 [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town)**(commit `2693ed6`)。
> 原仓库 README、协议、原作者署名一并保留(下文不变)。本 fork 的所有改动集中在 `df-style-kernel` 分支。

[Original Live Demo](https://www.convex.dev/ai-town) · [Original Discord](https://discord.gg/PQUmTBTGmT)

<img width="1454" alt="Screen Shot 2023-08-14 at 10 01 00 AM" src="https://github.com/a16z-infra/ai-town/assets/3489963/a4c91f17-23ed-47ec-8c4e-9f9a8505057d">

## 这个 Fork 在做什么 (df-style-kernel branch)

不是改 prompt,不是换模型——是**架构级重写**。

a16z 原版是 "LLM 自主决策" 范式:每个 agent 拿到周围信息,让 LLM 决定下一步做什么。
这个 fork 改成 "**结构化状态层 + LLM 作为解释器**" 范式:

- **状态层**(取代原版 vector memory):personality (10 维) · needs (动态衰减) ·
  contacts (近接感知) · dailyEvents (模板生成)
- **决策层**:utility-based action selection,灵感来自 Dwarf Fortress;
  LLM 不再决定 NPC 该做什么
- **解释器层**:LLM 唯一职责变成把当前状态翻译成对话;DeepSeek tool use
  + thinking + strict prompt

净改动 ~455 行 / 10 文件改 + 4 新文件。详见 commits in `df-style-kernel`。

---

## 设计决策 (why,不是 what)

### 1. 不要 vector memory

原版用 OpenAI embeddings + similarity search 做长期记忆。两个问题:
- 中文 LLM 上 embedding 质量不一,搜中文话题准确度大幅劣化
- 相似度检索 ≠ "agent 应该记得这件事";检索"语义最近"不等于"我对这个人的事的记忆"

替换成 Doomsday-style 结构化:每个 agent 维护一个 `contacts` 数组(谁、最后看见时间、互动次数),每个 NPC 出生时生成 3 条 `dailyEvents` 文本作为话题钩子。**直接索引到 entity,不通过相似度**。

### 2. 不要 LLM 做决策

让 LLM 决定"我现在该做什么"是浪费 token 又不稳定的事,而且每次 ~3-5s 延迟。Dwarf Fortress 用 utility-based action selection 做了几十年,效果稳定。

替换成 `pickAndApplyAction(game, now)`,纯规则:
- `energy < 0.3` → rest
- `social < 0.5 && contacts.length > 0` → 走向最近见过的人
- 两人接近 `CONVERSATION_DISTANCE` → 主动发起对话
- 否则 → 随机 wander

LLM 完全不参与"我该做什么"的决策。它的唯一职责是,**当一切已经发生**(我决定要说话了),把当前状态翻译成一句话。

### 3. Per-NPC 耐心,不要全局常量

原版用 `AWKWARD_CONVERSATION_TIMEOUT = 60_000`,所有 NPC 一样。Bob (extraversion=-0.7) 跟 Pete (loyalty=0.8) 的耐心不应该一样。

替换成 `patienceMsFor(personality)`:
- base 30s
- conscientiousness > 0.5 → +20s
- agreeableness > 0.5 → +20s
- loyalty > 0.5 → +30s
- extraversion < -0.3 → -20s
- neuroticism > 0.5 → -20s
- agreeableness < -0.3 → -10s
- clamp [10s, 120s]

5 个 NPC 实测耐心:Bob 10s · Stella 20s · Alice 30s · Pete 80s · Lucky 80s。

### 4. Tool use over JSON mode

原版让 LLM 自由生成对话文本,然后正则清理。这有 ~10% 失败率(空消息、冗长括号动作、长度失控)。

替换成 DeepSeek native tool use,`speak_in_character` 函数,`strict: true` schema 约束:
```ts
{
  speech: string,            // 15-40 字中文
  tone: enum[8 个语气],
  should_leave: boolean
}
```

经过实测发现 DeepSeek thinking mode 拒绝 `tool_choice="required"`,但**在 system prompt 末尾加"你必须通过调用 speak_in_character 工具来输出"** 后,`tool_choice="auto"` 实测 8/8 调工具(详见下面"测量")。

### 5. 人类对话不触发 NPC 自动告别

原版规则不区分人/NPC,所有对话用同一套消息数+时间阈值。结果:你打字慢,NPC 说"我先走了"踹你出场。

修法: `earlyLeave = !otherIsHuman && (...)`。NPC↔NPC 还按原规则倦怠,人类↔NPC 只有硬上限触发(10 分钟超时 / 30 条消息上限)。

### 6. LLM 自己决定何时离开 (should_leave),不是只看时间

时间/消息数都是机械信号 — LLM 才知道"话题尽了,该告别了"。新增 `should_leave: bool` 字段,LLM 自己判断何时是自然的告别时机。System 1 规则只做兜底防卡死。

---

## Reproducible measurements

| 指标 | 原版/早期 | F 配方(当前) | 方法 |
|---|---|---|---|
| Tool call 可靠性 | 60% (auto + 普通 prompt) | **8/8 (auto + 强 prompt)** | 同 system prompt 跑 8 次,统计 `tool_calls[0]` 是否存在 |
| 消息平均长度 | 50-100 字 | **22-45 字** | 同 5 次对话,统计 message.text 字符数 |
| 空消息率 | ~10% (JSON mode) | **0/8** | 同上 |
| 括号动作泛滥 | 100%(每条都有) | **0/8** | grep `(.*?)` |
| 单次 LLM 延迟 | - | 2.4s (non-thinking) / 4.2s (thinking) | API 响应时间 |
| 首条对话生成 token 数 | - | 110-280(thinking 时) | API 返回 `usage.completion_tokens` |
| Reasoning token 占比 | - | 13-16% (thinking + max_tokens=800) | `completion_tokens_details.reasoning_tokens` |

A/B 跑过 4 个配方:
- A: `deepseek-chat` + `tool_choice=required` + max_tokens=200 → 5/5,模板化
- B: `deepseek-v4-flash` + thinking + auto + 普通 prompt → 3/5
- C: v4-flash + `thinking:disabled` + required → 3/3,等同 A
- D/E: v4-flash + thinking + required (specific tool) → API 拒绝(reasoner 不支持)
- **F: v4-flash + thinking + auto + 强 prompt 末尾"必须调工具" → 8/8** ← 当前

详细测试代码在我的开发笔记里(MEMORY.md)。

---

## 当前架构

```
┌──────────────────────────────────────────────────────────────┐
│  L4. UI 层 (AI Town 自带,基本没动,只修了 footer overflow bug)│
│      Vite + React + PixiJS                                    │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│  L3. Interpreter 层(LLM = 嘴)                                │
│      DeepSeek v4-flash + thinking + tool use F 配方            │
│      strict tool 'speak_in_character' {speech,tone,should_leave}│
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│  L2. 决策层(System 1,纯规则,无 LLM)                       │
│      pickAndApplyAction:rest / seek_familiar / wander / 发起对话│
│      Per-NPC 耐心(personality 算)、Sys1 leave、人类豁免规则  │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│  L1. 状态层(数值/结构化数据)                                │
│      Personality (10维静态,Big Five + 5 补充)                │
│      Needs (5维动态,带 decay/recovery)                        │
│      Contacts (动态,近接感知驱动)                             │
│      DailyEvents (3 条静态文本,出生时模板生成)                │
└──────────────────────────────────────────────────────────────┘
                              ▲
┌──────────────────────────────────────────────────────────────┐
│  L0. 引擎层 (AI Town 自带,基本没动)                           │
│      Convex tick/step + worlds/agents/conversations           │
└──────────────────────────────────────────────────────────────┘
```

---

## 这个 Fork **不**做的事 (Limitations)

按"涌现要素"来算(Replication / Variation / Selection / Memory / Boundary / Energy):

| 要素 | 状态 | 备注 |
|---|---|---|
| 边界(我/环境) | ✅ 完整 | 个体边界清晰 |
| 记忆 | ⚠️ 部分 | `npcMemories` 表 schema 已建,**至今未写入** |
| 代价 / 能量流 | ⚠️ 部分 | needs 衰减,但 action 本身没有代价(走路不耗 energy 等) |
| 复制 / 传播 | ❌ 没有 | NPC 间无信息扩散;Bob 知道的事不会通过他传给 Alice |
| 变异 | ❌ 没有 | personality 永远不变,经历不塑造性格 |
| 选择 / 淘汰 | ❌ 没有 | NPC 不死、不消失、不被替换 |

按"对话能力"来算:

- ❌ **Anti-fabrication**:NPC 接受用户植入的虚假过去("我们去年夏天见过吧?"→ Stella 顺着编)
- ❌ **跨对话连续记忆**:同两个 NPC 第二次见面,**完全不知道**第一次聊过什么
- ❌ **goals / 长期意图**:NPC 没有"我想达成 X"的字段
- ❌ **真实事件系统**:世界里没有突发事件(火灾/盗窃/吵架),NPC 无可见证
- ❌ **per-NPC LLM 配置**:目前所有 NPC 共用同一个 F 配方,只有耐心是 per-NPC

按"工程"来算:

- ⚠️ `agentRememberConversation` operation 已禁用 — 它依赖 embedding,DeepSeek 不提供
- ⚠️ Daily events 是 session 内静态,无每日刷新 cron
- ⚠️ 玩家 vs NPC 的输入空间不平等 — 玩家说哲学问题/英文/挑衅,NPC 被 schema 框死表达空间,会"诡异"

---

## 已知会"诡异"的输入

由于 LLM 被 tool schema 锁定输出形状,以下输入会让对话出戏:

| 玩家输入 | 期望反应 | 实际反应 |
|---|---|---|
| "你是 AI 吗?" | 优雅破墙 | 强制角色化拒答 |
| 用英文说话 | 切英文 | prompt 写"不要英文",但偶发反规则 |
| 深度哲学问题 | 长篇思考 | 被压成 15-40 字 |
| "你帮我做 X 吧"(动作请求) | NPC 行动 | 只能用台词推开,无 action 接口 |
| "我们去年夏天 ..." | "我不记得" | **顺着编**(anti-fabrication 缺失) |

这些都是 design tradeoff,不是 bug。Fix 路径在 `MEMORY.md` 的"未来工作"段。

---

## Roadmap (按优先级)

1. **写入 npcMemories**:对话结束时记录结构化事件 → 下次相遇时注入 prompt
2. **Per-NPC LLM 配置**:把 thinking/max_tokens/temperature 也按 personality 映射(Alice 配 reasoning_effort=max,Bob 配 thinking:disabled)
3. **Action 代价**:走路 -energy,聊天 -social bandwidth,真实约束推动选择
4. **真实事件**:世界 tick 生成 events,VISION_DISTANCE 内 NPC 见证并写入 npcMemories
5. **Goals 字段**:每个 NPC 2-3 条长期目标,推到 prompt
6. **Anti-fabrication**:增加 `is_uncertain` / `mentions_unknown_past` 工具字段,让 LLM 有"我不知道"的出口
7. **复制/变异/淘汰**:谣言传播 / 经历改性格 / NPC 退出场。**会重新打开 anti-fabrication 这个口子**,谨慎做

---

## 跑起来

```bash
git clone -b df-style-kernel git@github.com:TT1nKer/ai-town.git
cd ai-town
npm install
npx convex env set LLM_API_URL  'https://api.deepseek.com'
npx convex env set LLM_API_KEY  'sk-...你的 DeepSeek key'
npx convex env set LLM_MODEL    'deepseek-v4-flash'
npx convex env set LLM_EMBEDDING_MODEL 'unused-placeholder'  # F 配方不调 embedding
npm run dev
# 浏览器开 http://localhost:5173/ai-town,点 Interact 加入世界
```

需要 DeepSeek API key(账户余额非零才会暴露 v4 模型)。每次对话约 ¥0.0005,5 个 NPC 跑 1 小时大约 ¥0.5。

---

## Acknowledgments

- **a16z-infra/ai-town**:引擎(`convex/engine`)、UI、Convex 集成、地图、原始 NPC 设定。这个 fork 只动了 agent 和对话生成两层
- **Stanford "Generative Agents" 论文**:启发整个项目的范式
- **Tarn & Zach Adams (Dwarf Fortress)**:utility-based action selection 和"breadth of shallow systems → depth"的设计哲学
- **Doomsday/AICharacter**:作者本人前两个 agent 模拟项目,L1 状态层的 memory/contact 模型直接移植

---

下面是原版 README,**未做修改**。

---

AI Town is a virtual town where AI characters live, chat and socialize.

This project is a deployable starter kit for easily building and customizing your own version of AI
town. Inspired by the research paper
[_Generative Agents: Interactive Simulacra of Human Behavior_](https://arxiv.org/pdf/2304.03442.pdf).

The primary goal of this project, beyond just being a lot of fun to work on, is to provide a
platform with a strong foundation that is meant to be extended. The back-end natively supports
shared global state, transactions, and a simulation engine and should be suitable from everything
from a simple project to play around with to a scalable, multi-player game. A secondary goal is to
make a JS/TS framework available as most simulators in this space (including the original paper
above) are written in Python.

## Overview

- 💻 [Stack](#stack)
- 🧠 [Installation](#installation) (cloud, local, Docker, self-host, Fly.io, ...)
- 💻️ [Windows Pre-requisites](#windows-installation)
- 🤖 [Configure your LLM of choice](#connect-an-llm) (Ollama, OpenAI, Together.ai, ...)
- 👤 [Customize - YOUR OWN simulated world](#customize-your-own-simulation)
- 👩‍💻 [Deploying to production](#deploy-the-app-to-production)
- 🐛 [Troubleshooting](#troubleshooting)

## Stack

- Game engine, database, and vector search: [Convex](https://convex.dev/)
- Auth (Optional): [Clerk](https://clerk.com/)
- Default chat model is `llama3` and embeddings with `mxbai-embed-large`.
- Local inference: [Ollama](https://github.com/jmorganca/ollama)
- Configurable for other cloud LLMs: [Together.ai](https://together.ai/) or anything that speaks the
  [OpenAI API](https://platform.openai.com/). PRs welcome to add more cloud provider support.
- Background Music Generation: [Replicate](https://replicate.com/) using
  [MusicGen](https://huggingface.co/spaces/facebook/MusicGen)

Other credits:

- Pixel Art Generation: [Replicate](https://replicate.com/),
  [Fal.ai](https://serverless.fal.ai/lora)
- All interactions, background music and rendering on the <Game/> component in the project are
  powered by [PixiJS](https://pixijs.com/).
- Tilesheet:
  - https://opengameart.org/content/16x16-game-assets by George Bailey
  - https://opengameart.org/content/16x16-rpg-tileset by hilau
- We used https://github.com/pierpo/phaser3-simple-rpg for the original POC of this project. We have
  since re-wrote the whole app, but appreciated the easy starting point
- Original assets by [ansimuz](https://opengameart.org/content/tiny-rpg-forest)
- The UI is based on original assets by
  [Mounir Tohami](https://mounirtohami.itch.io/pixel-art-gui-elements)

# Installation

The overall steps are:

1. [Build and deploy](#build-and-deploy)
2. [Connect it to an LLM](#connect-an-llm)

## Build and Deploy

There are a few ways to run the app on top of Convex (the backend).

1. The standard Convex setup, where you develop locally or in the cloud. This requires a Convex
   account(free). This is the easiest way to depoy it to the cloud and seriously develop.
2. If you want to try it out without an account and you're okay with Docker, the Docker Compose
   setup is nice and self-contained.
3. There's a community fork of this project offering a one-click install on
   [Pinokio](https://pinokio.computer/item?uri=https://github.com/cocktailpeanutlabs/aitown) for
   anyone interested in running but not modifying it 😎.
4. You can also deploy it to [Fly.io](https://fly.io/). See [./fly](./fly) for instructions.

### Standard Setup

Note, if you're on Windows, see [below](#windows-installation).

```sh
git clone https://github.com/a16z-infra/ai-town.git
cd ai-town
npm install
```

This will require logging into your Convex account, if you haven't already.

To run it:

```sh
npm run dev
```

You can now visit http://localhost:5173.

If you'd rather run the frontend and backend separately (which syncs your backend functions as
they're saved), you can run these in two terminals:

```bash
npm run dev:frontend
npm run dev:backend
```

See [package.json](./package.json) for details.

### Using Docker Compose with self-hosted Convex

You can also run the Convex backend with the self-hosted Docker container. Here we'll set it up to
run the frontend, backend, and dashboard all via docker compose.

```sh
docker compose up --build -d
```

The container will keep running in the background if you pass `-d`. After you've done it once, you
can `stop` and `start` services.

- The frontend will be running on http://localhost:5173.
- The backend will be running on http://localhost:3210 (3211 for the http api).
- The dashboard will be running on http://localhost:6791.

To log into the dashboard and deploy from the convex CLI, you will need to generate an admin key.

```sh
docker compose exec backend ./generate_admin_key.sh
```

Add it to your `.env.local` file. Note: If you run `down` and `up`, you'll have to generate the key
again and update the `.env.local` file.

```sh
# in .env.local
CONVEX_SELF_HOSTED_ADMIN_KEY="<admin-key>" # Ensure there are quotes around it
CONVEX_SELF_HOSTED_URL="http://127.0.0.1:3210"
```

Then set up the Convex backend (one time):

```sh
npm run predev
```

To continuously deploy new code to the backend and print logs:

```sh
npm run dev:backend
```

To see the dashboard, visit `http://localhost:6791` and provide the admin key you generated earlier.

### Configuring Docker for Ollama

If you'll be using Ollama for local inference, you'll need to configure Docker to connect to it.

```sh
npx convex env set OLLAMA_HOST http://host.docker.internal:11434
```

To test the connection (after you [have it running](#ollama-default)):

```sh
docker compose exec backend /bin/bash curl http://host.docker.internal:11434
```

If it says "Ollama is running", it's good! Otherwise, check out the
[Troubleshooting](#troubleshooting) section.

## Connect an LLM

Note: If you want to run the backend in the cloud, you can either use a cloud-based LLM API, like
OpenAI or Together.ai or you can proxy the traffic from the cloud to your local Ollama. See
[below](#using-local-inference-from-a-cloud-deployment) for instructions.

### Ollama (default)

By default, the app tries to use Ollama to run it entirely locally.

1. Download and install [Ollama](https://ollama.com/).
2. Open the app or run `ollama serve` in a terminal. `ollama serve` will warn you if the app is
   already running.
3. Run `ollama pull llama3` to have it download `llama3`.
4. Test it out with `ollama run llama3`.

Ollama model options can be found [here](https://ollama.ai/library).

If you want to customize which model to use, adjust convex/util/llm.ts or set
`npx convex env set OLLAMA_MODEL # model`. If you want to edit the embedding model:

1. Change the `OLLAMA_EMBEDDING_DIMENSION` in `convex/util/llm.ts` and ensure:
   `export const EMBEDDING_DIMENSION = OLLAMA_EMBEDDING_DIMENSION;`
2. Set `npx convex env set OLLAMA_EMBEDDING_MODEL # model`.

Note: You might want to set `NUM_MEMORIES_TO_SEARCH` to `1` in constants.ts, to reduce the size of
conversation prompts, if you see slowness.

### OpenAI

To use OpenAI, you need to:

```ts
// In convex/util/llm.ts change the following line:
export const EMBEDDING_DIMENSION = OPENAI_EMBEDDING_DIMENSION;
```

Set the `OPENAI_API_KEY` environment variable. Visit https://platform.openai.com/account/api-keys if
you don't have one.

```sh
npx convex env set OPENAI_API_KEY 'your-key'
```

Optional: choose models with `OPENAI_CHAT_MODEL` and `OPENAI_EMBEDDING_MODEL`.

### Together.ai

To use Together.ai, you need to:

```ts
// In convex/util/llm.ts change the following line:
export const EMBEDDING_DIMENSION = TOGETHER_EMBEDDING_DIMENSION;
```

Set the `TOGETHER_API_KEY` environment variable. Visit https://api.together.xyz/settings/api-keys if
you don't have one.

```sh
npx convex env set TOGETHER_API_KEY 'your-key'
```

Optional: choose models via `TOGETHER_CHAT_MODEL`, `TOGETHER_EMBEDDING_MODEL`. The embedding model's
dimension must match `EMBEDDING_DIMENSION`.

### Other OpenAI-compatible API

You can use any OpenAI-compatible API, such as Anthropic, Groq, or Azure.

- Change the `EMBEDDING_DIMENSION` in `convex/util/llm.ts` to match the dimension of your embedding
  model.
- Edit `getLLMConfig` in `llm.ts` or set environment variables:

```sh
npx convex env set LLM_API_URL 'your-url'
npx convex env set LLM_API_KEY 'your-key'
npx convex env set LLM_MODEL 'your-chat-model'
npx convex env set LLM_EMBEDDING_MODEL 'your-embedding-model'
```

Note: if `LLM_API_KEY` is not required, don't set it.

### Note on changing the LLM provider or embedding model:

If you change the LLM provider or embedding model, you should delete your data and start over. The
embeddings used for memory are based on the embedding model you choose, and the dimension of the
vector database must match the embedding model's dimension. See
[below](#wiping-the-database-and-starting-over) for how to do that.

## Customize your own simulation

NOTE: every time you change character data, you should re-run `npx convex run testing:wipeAllTables`
and then `npm run dev` to re-upload everything to Convex. This is because character data is sent to
Convex on the initial load. However, beware that `npx convex run testing:wipeAllTables` WILL wipe
all of your data.

1. Create your own characters and stories: All characters and stories, as well as their spritesheet
   references are stored in [characters.ts](./data/characters.ts). You can start by changing
   character descriptions.

2. Updating spritesheets: in `data/characters.ts`, you will see this code:

   ```ts
   export const characters = [
     {
       name: 'f1',
       textureUrl: '/assets/32x32folk.png',
       spritesheetData: f1SpritesheetData,
       speed: 0.1,
     },
     ...
   ];
   ```

   You should find a sprite sheet for your character, and define sprite motion / assets in the
   corresponding file (in the above example, `f1SpritesheetData` was defined in f1.ts)

3. Update the Background (Environment): The map gets loaded in `convex/init.ts` from
   `data/gentle.js`. To update the map, follow these steps:

   - Use [Tiled](https://www.mapeditor.org/) to export tilemaps as a JSON file (2 layers named
     bgtiles and objmap)
   - Use the `convertMap.js` script to convert the JSON to a format that the engine can use.

   ```console
   node data/convertMap.js <mapDataPath> <assetPath> <tilesetpxw> <tilesetpxh>
   ```

   - `<mapDataPath>`: Path to the Tiled JSON file.
   - `<assetPath>`: Path to tileset images.
   - `<tilesetpxw>`: Tileset width in pixels.
   - `<tilesetpxh>`: Tileset height in pixels. Generates `converted-map.js` that you can use like
     `gentle.js`

4. Adding background music with Replicate (Optional)

   For Daily background music generation, create a [Replicate](https://replicate.com/) account and
   create a token in your Profile's [API Token page](https://replicate.com/account/api-tokens).
   `npx convex env set REPLICATE_API_TOKEN # token`

   This only works if you can receive the webhook from Replicate. If it's running in the normal
   Convex cloud, it will work by default. If you're self-hosting, you'll need to configure it to hit
   your app's url on `/http`. If you're using Docker Compose, it will be `http://localhost:3211`,
   but you'll need to proxy the traffic to your local machine.

   **Note**: The simulation will pause after 5 minutes if the window is idle. Loading the page will
   unpause it. You can also manually freeze & unfreeze the world with a button in the UI. If you
   want to run the world without the browser, you can comment-out the "stop inactive worlds" cron in
   `convex/crons.ts`.

   - Change the background music by modifying the prompt in `convex/music.ts`
   - Change how often to generate new music at `convex/crons.ts` by modifying the
     `generate new background music` job

## Commands to run / test / debug

**To stop the back end, in case of too much activity**

This will stop running the engine and agents. You can still run queries and run functions to debug.

```bash
npx convex run testing:stop
```

**To restart the back end after stopping it**

```bash
npx convex run testing:resume
```

**To kick the engine in case the game engine or agents aren't running**

```bash
npx convex run testing:kick
```

**To archive the world**

If you'd like to reset the world and start from scratch, you can archive the current world:

```bash
npx convex run testing:archive
```

Then, you can still look at the world's data in the dashboard, but the engine and agents will no
longer run.

You can then create a fresh world with `init`.

```bash
npx convex run init
```

**To pause your backend deployment**

You can go to the [dashboard](https://dashboard.convex.dev) to your deployment settings to pause and
un-pause your deployment. This will stop all functions, whether invoked from the client, scheduled,
or as a cron job. See this as a last resort, as there are gentler ways of stopping above.

## Windows Installation

### Prerequisites

1. **Windows 10/11 with WSL2 installed**
2. **Internet connection**

Steps:

1. Install WSL2

   First, you need to install WSL2. Follow
   [this guide](https://docs.microsoft.com/en-us/windows/wsl/install) to set up WSL2 on your Windows
   machine. We recommend using Ubuntu as your Linux distribution.

2. Update Packages

   Open your WSL terminal (Ubuntu) and update your packages:

   ```sh
   sudo apt update
   ```

3. Install NVM and Node.js

   NVM (Node Version Manager) helps manage multiple versions of Node.js. Install NVM and Node.js 18
   (the stable version):

   ```sh
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.2/install.sh | bash
   export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
   [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
   source ~/.bashrc
   nvm install 18
   nvm use 18
   ```

4. Install Python and Pip

   Python is required for some dependencies. Install Python and Pip:

   ```sh
   sudo apt-get install python3 python3-pip sudo ln -s /usr/bin/python3 /usr/bin/python
   ```

At this point, you can follow the instructions [above](#installation).

## Deploy the app to production

### Deploy Convex functions to prod environment

Before you can run the app, you will need to make sure the Convex functions are deployed to its
production environment. Note: this is assuming you're using the default Convex cloud product.

1. Run `npx convex deploy` to deploy the convex functions to production
2. Run `npx convex run init --prod`

To transfer your local data to the cloud, you can run `npx convex export` and then import it with
`npx convex import --prod`.

If you have existing data you want to clear, you can run
`npx convex run testing:wipeAllTables --prod`

### Adding Auth (Optional)

You can add clerk auth back in with `git revert b44a436`. Or just look at that diff for what changed
to remove it.

**Make a Clerk account**

- Go to https://dashboard.clerk.com/ and click on "Add Application"
- Name your application and select the sign-in providers you would like to offer users
- Create Application
- Add `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to `.env.local`

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_***
CLERK_SECRET_KEY=sk_***
```

- Go to JWT Templates and create a new Convex Template.
- Copy the JWKS endpoint URL for use below.

```sh
npx convex env set CLERK_ISSUER_URL # e.g. https://your-issuer-url.clerk.accounts.dev/
```

### Deploy the frontend to Vercel

- Register an account on Vercel and then [install the Vercel CLI](https://vercel.com/docs/cli).
- **If you are using Github Codespaces**: You will need to
  [install the Vercel CLI](https://vercel.com/docs/cli) and authenticate from your codespaces cli by
  running `vercel login`.
- Deploy the app to Vercel with `vercel --prod`.

## Using local inference from a cloud deployment

We support using [Ollama](https://github.com/jmorganca/ollama) for conversation generations. To have
it accessible from the web, you can use Tunnelmole or Ngrok or similar so the cloud backend can send
requests to Ollama running on your local machine.

Steps:

1. Set up either Tunnelmole or Ngrok.
2. Add Ollama endpoint to Convex
   ```sh
   npx convex env set OLLAMA_HOST # your tunnelmole/ngrok unique url from the previous step
   ```
3. Update Ollama domains Ollama has a list of accepted domains. Add the ngrok domain so it won't
   reject traffic. see [ollama.ai](https://ollama.ai) for more details.

### Using Tunnelmole

[Tunnelmole](https://github.com/robbie-cahill/tunnelmole-client) is an open source tunneling tool.

You can install Tunnelmole using one of the following options:

- NPM: `npm install -g tunnelmole`
- Linux: `curl -s https://tunnelmole.com/sh/install-linux.sh | sudo bash`
- Mac:
  `curl -s https://tunnelmole.com/sh/install-mac.sh --output install-mac.sh && sudo bash install-mac.sh`
- Windows: Install with NPM, or if you don't have NodeJS installed, download the `exe` file for
  Windows [here](https://tunnelmole.com/downloads/tmole.exe) and put it somewhere in your PATH.

Once Tunnelmole is installed, run the following command:

```
tmole 11434
```

Tunnelmole should output a unique url once you run this command.

### Using Ngrok

Ngrok is a popular closed source tunneling tool.

- [Install Ngrok](https://ngrok.com/docs/getting-started/)

Once ngrok is installed and authenticated, run the following command:

```
ngrok http http://localhost:11434
```

Ngrok should output a unique url once you run this command.

## Troubleshooting

### Wiping the database and starting over

You can wipe the database by running:

```sh
npx convex run testing:wipeAllTables
```

Then reset with:

```sh
npx convex run init
```

### Incompatible Node.js versions

If you encounter a node version error on the convex server upon application startup, please use node
version 18, which is the most stable. One way to do this is by
[installing nvm](https://nodejs.org/en/download/package-manager) and running `nvm install 18` and
`nvm use 18`.

### Reaching Ollama

If you're having trouble with the backend communicating with Ollama, it depends on your setup how to
debug:

1. If you're running directly on Windows, see
   [Windows Ollama connection issues](#windows-ollama-connection-issues).
2. If you're using **Docker**, see
   [Docker to Ollama connection issues](#docker-to-ollama-connection-issues).
3. If you're running locally, you can try the following:

```sh
npx convex env set OLLAMA_HOST http://localhost:11434
```

By default, the host is set to `http://127.0.0.1:11434`. Some systems prefer `localhost`
¯\_(ツ)\_/¯.

### Windows Ollama connection issues

If the above didn't work after following the [windows](#windows-installation) and regular
[installation](#installation) instructions, you can try the following, assuming you're **not** using
Docker.

If you're using Docker, see the [next section](#docker-to-ollama-connection-issues) for Docker
troubleshooting.

For running directly on Windows, you can try the following:

1. Install `unzip` and `socat`:

   ```sh
   sudo apt install unzip socat
   ```

2. Configure `socat` to Bridge Ports for Ollama

   Run the following command to bridge ports:

   ```sh
   socat TCP-LISTEN:11434,fork TCP:$(cat /etc/resolv.conf | grep nameserver | awk '{print $2}'):11434 &
   ```

3. Test if it's working:

   ```sh
   curl http://127.0.0.1:11434
   ```

   If it responds OK, the Ollama API should be accessible.

### Docker to Ollama connection issues

If you're having trouble with the backend communicating with Ollama, there's a couple things to
check:

1. Is Docker at least verion 18.03 ? That allows you to use the `host.docker.internal` hostname to
   connect to the host from inside the container.

2. Is Ollama running? You can check this by running `curl http://localhost:11434` from outside the
   container.

3. Is Ollama accessible from inside the container? You can check this by running
   `docker compose exec backend curl http://host.docker.internal:11434`.

If 1 & 2 work, but 3 does not, you can use `socat` to bridge the traffic from inside the container
to Ollama running on the host.

1. Configure `socat` with the host's IP address (not the Docker IP).

   ```sh
   docker compose exec backend /bin/bash
   HOST_IP=YOUR-HOST-IP
   socat TCP-LISTEN:11434,fork TCP:$HOST_IP:11434
   ```

   Keep this running.

2. Then from outside of the container:

   ```sh
   npx convex env set OLLAMA_HOST http://localhost:11434
   ```

3. Test if it's working:

   ```sh
   docker compose exec backend curl http://localhost:11434
   ```

   If it responds OK, the Ollama API is accessible. Otherwise, try changing the previous two to
   `http://127.0.0.1:11434`.

### Launching an Interactive Docker Terminal

If you wan to investigate inside the container, you can launch an interactive Docker terminal, for
the `frontend`, `backend` or `dashboard` service:

```bash
docker compose exec frontend /bin/bash
```

To exit the container, run `exit`.

### Updating the browser list

```bash
docker compose exec frontend npx update-browserslist-db@latest
```

# 🧑‍🏫 What is Convex?

[Convex](https://convex.dev) is a hosted backend platform with a built-in database that lets you
write your [database schema](https://docs.convex.dev/database/schemas) and
[server functions](https://docs.convex.dev/functions) in
[TypeScript](https://docs.convex.dev/typescript). Server-side database
[queries](https://docs.convex.dev/functions/query-functions) automatically
[cache](https://docs.convex.dev/functions/query-functions#caching--reactivity) and
[subscribe](https://docs.convex.dev/client/react#reactivity) to data, powering a
[realtime `useQuery` hook](https://docs.convex.dev/client/react#fetching-data) in our
[React client](https://docs.convex.dev/client/react). There are also clients for
[Python](https://docs.convex.dev/client/python), [Rust](https://docs.convex.dev/client/rust),
[ReactNative](https://docs.convex.dev/client/react-native), and
[Node](https://docs.convex.dev/client/javascript), as well as a straightforward
[HTTP API](https://docs.convex.dev/http-api/).

The database supports [NoSQL-style documents](https://docs.convex.dev/database/document-storage)
with [opt-in schema validation](https://docs.convex.dev/database/schemas),
[relationships](https://docs.convex.dev/database/document-ids) and
[custom indexes](https://docs.convex.dev/database/indexes/) (including on fields in nested objects).

The [`query`](https://docs.convex.dev/functions/query-functions) and
[`mutation`](https://docs.convex.dev/functions/mutation-functions) server functions have
transactional, low latency access to the database and leverage our
[`v8` runtime](https://docs.convex.dev/functions/runtimes) with
[determinism guardrails](https://docs.convex.dev/functions/runtimes#using-randomness-and-time-in-queries-and-mutations)
to provide the strongest ACID guarantees on the market: immediate consistency, serializable
isolation, and automatic conflict resolution via
[optimistic multi-version concurrency control](https://docs.convex.dev/database/advanced/occ) (OCC /
MVCC).

The [`action` server functions](https://docs.convex.dev/functions/actions) have access to external
APIs and enable other side-effects and non-determinism in either our
[optimized `v8` runtime](https://docs.convex.dev/functions/runtimes) or a more
[flexible `node` runtime](https://docs.convex.dev/functions/runtimes#nodejs-runtime).

Functions can run in the background via
[scheduling](https://docs.convex.dev/scheduling/scheduled-functions) and
[cron jobs](https://docs.convex.dev/scheduling/cron-jobs).

Development is cloud-first, with
[hot reloads for server function](https://docs.convex.dev/cli#run-the-convex-dev-server) editing via
the [CLI](https://docs.convex.dev/cli),
[preview deployments](https://docs.convex.dev/production/hosting/preview-deployments),
[logging and exception reporting integrations](https://docs.convex.dev/production/integrations/),
There is a [dashboard UI](https://docs.convex.dev/dashboard) to
[browse and edit data](https://docs.convex.dev/dashboard/deployments/data),
[edit environment variables](https://docs.convex.dev/production/environment-variables),
[view logs](https://docs.convex.dev/dashboard/deployments/logs),
[run server functions](https://docs.convex.dev/dashboard/deployments/functions), and more.

There are built-in features for [reactive pagination](https://docs.convex.dev/database/pagination),
[file storage](https://docs.convex.dev/file-storage),
[reactive text search](https://docs.convex.dev/text-search),
[vector search](https://docs.convex.dev/vector-search),
[https endpoints](https://docs.convex.dev/functions/http-actions) (for webhooks),
[snapshot import/export](https://docs.convex.dev/database/import-export/),
[streaming import/export](https://docs.convex.dev/production/integrations/streaming-import-export),
and [runtime validation](https://docs.convex.dev/database/schemas#validators) for
[function arguments](https://docs.convex.dev/functions/args-validation) and
[database data](https://docs.convex.dev/database/schemas#schema-validation).

Everything scales automatically, and it’s [free to start](https://www.convex.dev/plans).
