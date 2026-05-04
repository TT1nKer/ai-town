// L2 daily events: structured "what happened to me today" tokens that NPCs
// can reference in conversation. Generated at NPC creation; static for the
// lifetime of the session (refresh-on-day-tick can be added in Phase 2+).
//
// Pure templates — no LLM call. Cheap, deterministic, no async. The point is
// to give the Interpreter (System 2) something concrete to render beyond the
// fixed personality + needs vector.

const ACTIVITIES = [
  '修剪花圃', '喂一只野猫', '跟人争执', '在井边发呆', '看星星',
  '试着写诗', '修一个坏掉的工具', '种一棵新树苗', '搬运石块', '修补屋顶',
];
const DREAM_TOPICS = [
  '失去了一个朋友', '天空裂开', '回到童年', '一只会说话的鸟',
  '掉进深井', '丢了重要的东西', '回到母亲的厨房', '飞过整片森林',
];
const ITEMS = [
  '一把钥匙', '一只袜子', '一本笔记', '半块面包', '一支笔',
  '一个铜币', '一只皮手套', '祖母给的项链',
];
const GOSSIPS = [
  '镇上有人偷东西', '雨快来了', '远方有人来访', '河水变浊了',
  '夜里听到怪声', '镇外的小路被冲毁了', '老酒馆的猫不见了',
];
const MOODS = [
  '今天心情不错,什么都顺', '今天有点烦躁,谁都看不顺眼',
  '今天觉得空虚,做什么都没劲', '今天有种说不出的预感',
  '今天比昨天平静一些', '今天背后一直发凉,像有人在看',
];
const ENCOUNTERS = [
  '擦肩而过,他没跟我打招呼', '在路上被他撞了一下,没道歉',
  '看见他和别人在低声说话,看到我赶紧停了',
  '他朝我笑了一下,我没认出来是为什么',
  '我看见他一个人坐在那儿很久',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateDailyEvents(myName: string, otherNames: string[]): string[] {
  const someone = () => (otherNames.length > 0 ? pick(otherNames) : '不认识的人');
  const generators: Array<() => string> = [
    () => `今早看见 ${someone()} 在 ${pick(ACTIVITIES)}`,
    () => `做了一个奇怪的梦,梦里 ${pick(DREAM_TOPICS)}`,
    () => `丢了 ${pick(ITEMS)},找了半天没找到`,
    () => `听说 ${pick(GOSSIPS)}`,
    () => pick(MOODS),
    () => `跟 ${someone()} ${pick(ENCOUNTERS)}`,
  ];
  // Pick 3 distinct generators, run each once.
  const picked = new Set<number>();
  while (picked.size < 3 && picked.size < generators.length) {
    picked.add(Math.floor(Math.random() * generators.length));
  }
  return [...picked].map((i) => generators[i]());
}
