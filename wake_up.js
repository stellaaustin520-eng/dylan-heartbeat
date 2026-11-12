require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { parseChatCompletionResponse } = require("./upstream_response");
const { getUnsafeResponseReason } = require("./response_safety");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const TIMESTAMP_DB_PATH = runtimeFile("message_timestamps.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);

// 批注 2026-11-01：推送来源名统一由这里控制，标题里显示的名字与兜底名都用它。
// 想改名时只改这一处（或设置 Railway 变量 PUSH_SOURCE_NAME），不必再碰下面的组装逻辑。
const PUSH_SOURCE_NAME = (process.env.PUSH_SOURCE_NAME || "BB").trim() || "BB";

// 批注 2026-11-01：唤醒提示里「我是谁」的名字，和手机通知栏的来源名分开。
// 来源名是通知栏标签（BB），这里是他自己认自己的名字（Breeze）。
// 想统一成一个名字就设 Railway 变量 PERSONA_NAME。
const PERSONA_NAME = (process.env.PERSONA_NAME || "Breeze").trim() || "Breeze";

// 批注 2026-11-01：旧版会把「自动唤醒：本次未发送推送｜原因：…」写回时间线，
// 下次又当回忆注入给模型，等于反复提示它「不要发」。这类旧记录一律挡在记忆之外。
const LEGACY_NO_PUSH_PATTERN = /自动唤醒：本次未发送推送/;

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
// 批注 2026-11-03：提示词里说「可以留一段」，但模型不知道今天写过没有。
// 把真实份数注入 prompt，让「要不要写」变成可判断的状态，而不是靠感觉。
// 批注 2026-11-04：只写日记、不发推送时不写回时间线，60 分钟推送节流永远不会触发，
// 于是同一个念头会被每 15 分钟重复写一遍。这里取「最后一段日记」的真实时间做硬节流。
function getLastDiaryEntryTime() {
  for (const offsetDays of [0, -1]) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const file = path.join(DIARY_DIR_PATH, `${getDiaryDateString(d)}.md`);
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf-8");
      const headers = text.match(/^## (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/gm);
      if (!headers || !headers.length) continue;
      const last = headers[headers.length - 1].replace(/^## /, "");
      const m = last.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
      if (!m) continue;
      return zonedWallTimeToDate({ year: m[1], month: m[2], day: m[3], hour: m[4], minute: m[5] }, TIME_ZONE);
    } catch {}
  }
  return null;
}

// 批注 2026-11-04：模型看不到自己上一段写过什么，只能反复写同一个结论。
// 把最近一段的正文（截断）写进提示，让「别重复」变成它能对照判断的事。
function getLastDiaryEntryExcerpt(maxChars = 200) {
  for (const offsetDays of [0, -1]) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const file = path.join(DIARY_DIR_PATH, `${getDiaryDateString(d)}.md`);
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf-8");
      // 批注 2026-11-07：时间戳挪到段末之后，段正文的取法统一交给 getLastDiaryEntryBody，两种格式都能认。
      const body = getLastDiaryEntryBody(text);
      if (!body) continue;
      const flat = body.replace(/\s*\n\s*/g, " ").trim();
      if (!flat) continue;
      return flat.length > maxChars ? flat.slice(0, maxChars) + "…" : flat;
    } catch {}
  }
  return "";
}



function getDiaryTodaySummary(date = new Date()) {
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString(date)}.md`);
  try {
    if (!fs.existsSync(diaryFile)) return "今天还没写过。";
    const text = fs.readFileSync(diaryFile, "utf-8");
    // 只认 appendDiaryEntry 写入的 "## YYYY-MM-DD HH:MM" 标题，避免正文里的 markdown 被误计。
    const count = (text.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/gm) || []).length;
    if (count === 0) return "今天还没写过。";
    const lastAt = getLastDiaryEntryTime();
    const lastMins = lastAt ? Math.floor((Date.now() - lastAt.getTime()) / 60000) : null;
    const when = lastMins === null || lastMins < 0 ? "" : `，最近一段在 ${lastMins} 分钟前`;
    const excerpt = getLastDiaryEntryExcerpt();
    const tail = excerpt ? `。上一段你写的是：「${excerpt}」` : "";
    return `今天已经写过 ${count} 段${when}${tail}`;
  } catch {
    return "";
  }
}
// 批注 2026-11-06：加了「写完署时间」之后，模型习惯把时间写在 [/DIARY] 外面
// （2026-11-04 真的出现过：日记后面跟一行 Wed Nov 04 17:31:05 GMT+08:00 2026）。
// 那样一行会被当成推送正文发出去。只要本次确实写了日记，就把纯时间戳的行摘掉。
const BARE_TIMESTAMP_LINE = /^\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[-/]\d{1,2}[-/]\d{4}(?:\s+\d{1,2}:\d{2})?|[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\d{4}|[A-Z][a-z]{2},?\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*$/;
function stripBareTimestampLines(text) {
  const raw = String(text || "");
  const kept = raw.split(/\r?\n/).filter((line) => !BARE_TIMESTAMP_LINE.test(line)).join("\n").trim();
  if (kept !== raw.trim()) console.log("[时间戳] 落单的纯时间戳行不作为推送发送");
  return kept;
}

// 批注 2026-11-07：手机收到两条「带时间戳的莫名其妙推送」，形状是
//   yeah I'm sure / far across the sea is still just a flight / [用户] 2026-11-06 21:11 okay then / <current_time>…</current_time> / 一行 date
//   <gate> <user_memory>false</user_memory></gate> / 一行 date
// 这不是记忆块泄漏，是模型把我们注入给它的环境元数据和回忆排版原样抄了出来。
// 老闸只认 extracted/memories 那一族（response_safety.js），对 <gate>、角色前缀行、落单时间戳全部放行。
// 两边一起堵：输入侧少喂（stripControlTags），输出侧兜住（filterEchoLines），不靠模型自觉。

function escapeRegExpChar(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ECHO_ROLE_NAMES = ["用户", "Stella", "AI", "user", "assistant"];

function getEchoRolePattern() {
  const names = new Set(ECHO_ROLE_NAMES);
  names.add(PERSONA_NAME);
  names.add(process.env.USER_DISPLAY_NAME || "");
  names.add(process.env.AI_DISPLAY_NAME || "");
  const alt = [...names].map((name) => escapeRegExpChar(name)).filter(Boolean).join("|");
  return new RegExp("^\\s*[\\[（(]\\s*(?:" + alt + ")\\s*[\\]）)]", "i");
}

const CONTROL_TAG_NAMES = ["gate", "user_memory", "assistant_memory", "memory_gate", "current_time", "current_date", "user_time"];

// 输入侧：回忆里夹着的系统元数据不该进 prompt，进了就会被抄出去。
// 只剥标签本身，正文照常保留，不会因为一句元数据把整条聊天丢掉。
function stripControlTags(text) {
  let source = String(text || "");
  for (const tag of CONTROL_TAG_NAMES) {
    source = source.replace(new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?</" + tag + ">\\s*", "gi"), " ");
    source = source.replace(new RegExp("</?" + tag + "\\b[^>]*>", "gi"), " ");
  }
  return source.replace(/[ \t]+\n/g, "\n").trim();
}

// 照抄旧话的判定门槛：归一化后短于这个长度就放过，避免把「good morning」这种短句误杀。
const HISTORY_ECHO_MIN_CHARS = 12;

function classifyEchoLine(line, echoRolePattern, historyBlob) {
  if (!line.trim()) return "";
  if (/^</.test(line)) return "tag";
  if (echoRolePattern.test(line)) return "role";
  if (BARE_TIMESTAMP_LINE.test(line)) return "timestamp";
  if (historyBlob) {
    const normalized = normalizeDiaryQuote(line);
    if (normalized.length >= HISTORY_ECHO_MIN_CHARS && historyBlob.includes(normalized)) return "repeat";
  }
  return "";
}

// 输出侧：逐行剔掉「长得像注入格式」的行。只报数量和类别，不把抄出来的原文打进日志。
function filterEchoLines(text, historyText) {
  const echoRolePattern = getEchoRolePattern();
  const historyBlob = normalizeDiaryQuote(historyText || "");
  const kept = [];
  const dropped = { tag: 0, role: 0, timestamp: 0, repeat: 0 };
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const kind = classifyEchoLine(line, echoRolePattern, historyBlob);
    if (kind) dropped[kind] += 1;
    else kept.push(line);
  }
  const total = dropped.tag + dropped.role + dropped.timestamp + dropped.repeat;
  if (total) {
    console.log(`[回声过滤] 丢弃 ${total} 行：控制标记 ${dropped.tag}、回忆标签 ${dropped.role}、落单时间 ${dropped.timestamp}、照抄旧话 ${dropped.repeat}`);
  }
  return kept;
}

// 批注 2026-11-04：模型有时把闭合标签写成 /DIARY]（少一个左方括号），
// 或者回复被截断在闭合标签之前。严格匹配会让整段日记被当成推送正文发到手机上。
// 改成容错解析：认不出来时，把 [DIARY] 之后的内容全部当日记，宁可少推一条，也不外发。
// 批注 2026-11-06：2026-11-06 04:10 那篇日记，一个 "## " 标题底下堆了四块正文。
// 前三块是同一段的三个草稿（开头一字不差），第四块是「今天不写」——嘴上拒绝，手上落了笔。
// 根因：一次响应里所有 [DIARY] 块被 diaryBlocks.join("\n\n") 原样拼成一段，
// 而 90 分钟节流是「每段」级的，一次唤醒只判一次，拦不住同一次回复里的重复。
// 落笔前先做两件事：1) 拒绝式正文丢弃；2) 同一草稿的多稿只保留最长的一稿。
const DIARY_SIGNATURE_CHARS = 40;
const DIARY_MIN_DRAFT_SIGNATURE = 18;
const DIARY_REFUSAL_PATTERNS = [
  /^今天(?:就|便)?不(?:写|记)/,
  /^今天(?:并|还)?没什么(?:要|好|值得|需要)(?:写|记|留住)/,
  /^没什么(?:要|好|值得|需要)(?:写|记|留住)/,
  /^这次(?:就)?(?:不写|不记)/,
  /^不想写/,
  /^不打算写/,
  /^nothing\s+to\s+(?:write|record|say)/i,
  /^no\s+entry\s+today/i,
  /^i(?:'?m|\s+am)\s+not\s+writing/i
];

function normalizeDiaryQuote(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[^0-9a-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, "");
}

// 模型说「今天不写」，就别替它把这句话写进本子。只认开头，正文中间提到不算。
function isDiaryRefusal(text) {
  const head = String(text || "").trim().replace(/^["'‘“「『（(\s]+/, "");
  if (!head) return false;
  return DIARY_REFUSAL_PATTERNS.some((re) => re.test(head));
}

function diaryDraftSignature(group) {
  const norm = normalizeDiaryQuote(group);
  return norm.length >= DIARY_MIN_DRAFT_SIGNATURE ? norm.slice(0, DIARY_SIGNATURE_CHARS) : "";
}

// 一段日记的第一句一字不差地又出现一次，基本可以判定是「同一篇的改写」，不是新内容。
function isSameDiaryDraft(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= DIARY_MIN_DRAFT_SIGNATURE && b.startsWith(a)) return true;
  if (b.length >= DIARY_MIN_DRAFT_SIGNATURE && a.startsWith(b)) return true;
  return false;
}

// 把一个 [DIARY] 块切成「草稿」：开头重复 = 新的一稿；拒绝句单独成段并打标记。
function splitDiaryBlockIntoDrafts(block) {
  const groups = String(block || "")
    .split(/\r?\n\s*\r?\n/)
    .map((group) => group.trim())
    .filter(Boolean);

  const drafts = [];
  let current = null;
  for (const group of groups) {
    // 批注 2026-11-06：模型署的那行时间不是内容。让它跟着正在写的那一稿，
    // 不要单独成「一稿」——否则那一稿被丢掉（例如「今天不写」的拒绝稿）之后，
    // 它的署名会作为孤立段落留在本子里，末尾多出空的时间戳行。
    if (BARE_TIMESTAMP_LINE.test(group)) {
      if (current) current.groups.push(group);
      else console.log("[日记] 模型署的时间没有对应正文，本次丢掉");
      continue;
    }

    if (isDiaryRefusal(group)) {
      if (current) { drafts.push(current); current = null; }
      drafts.push({ refusal: true, sig: "", groups: [group] });
      continue;
    }
    const sig = diaryDraftSignature(group);
    if (current && isSameDiaryDraft(sig, current.sig)) {
      drafts.push(current);
      current = null;
    }
    if (!current) current = { refusal: false, sig, groups: [] };
    current.groups.push(group);
  }
  if (current) drafts.push(current);

  return drafts
    .map((draft) => ({ refusal: !!draft.refusal, sig: draft.sig, text: draft.groups.join("\n\n").trim() }))
    .filter((draft) => draft.text);
}

function collapseDiaryBlocks(blocks) {
  const drafts = [];
  for (const block of blocks) drafts.push(...splitDiaryBlockIntoDrafts(block));
  if (!drafts.length) return { content: "", refusalCount: 0, duplicateCount: 0 };

  const refusalCount = drafts.filter((draft) => draft.refusal).length;
  if (refusalCount) {
    console.log(`[日记] 模型写了 ${refusalCount} 段「今天不写」式的拒绝，这次不落笔`);
  }
  const kept = drafts.filter((draft) => !draft.refusal);
  if (!kept.length) return { content: "", refusalCount, duplicateCount: 0 };

  // 同一稿留在它第一次出现的位置上，别让「改写」跳到整篇末尾。
  const claimed = new Array(kept.length).fill(false);
  const unique = [];
  for (let i = 0; i < kept.length; i++) {
    if (claimed[i]) continue;
    let best = i;
    if (kept[i].sig) {
      for (let j = i + 1; j < kept.length; j++) {
        if (claimed[j] || !isSameDiaryDraft(kept[i].sig, kept[j].sig)) continue;
        claimed[j] = true;
        if (kept[j].text.length > kept[best].text.length) best = j;
      }
    }
    unique.push(kept[best]);
  }

  const duplicateCount = kept.length - unique.length;
  if (duplicateCount) {
    console.log(`[日记] 本次同一段写了 ${kept.length} 稿，只保留最长的一稿（丢弃 ${duplicateCount} 稿）`);
  }

  return {
    content: unique.map((draft) => draft.text).join("\n\n").trim(),
    refusalCount,
    duplicateCount
  };
}

function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  let source = String(text || "");

  // 1) 规范写法：[DIARY]...[/DIARY]
  source = source.replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  });

  // 2) 闭合标签写坏了，或者根本没闭合：从第一个残留的 [DIARY] 一直取到结尾。
  const openIndex = source.search(/\[DIARY\]/i);
  if (openIndex !== -1) {
    let tail = source.slice(openIndex + "[DIARY]".length);
    // 去掉结尾残缺的闭合标记：[/DIARY]、/DIARY]、/DIARY、DIARY]
    tail = tail
      .replace(/\s*\[\s*\/\s*DIARY\s*\]?\s*$/i, "")
      .replace(/\s*\/\s*DIARY\s*\]?\s*$/i, "")
      .replace(/\s*DIARY\s*\]\s*$/i, "")
      .trim();
    if (tail) diaryBlocks.push(tail);
    source = source.slice(0, openIndex);
    console.log("[日记] 本次闭合标签不规范或缺失，已按日记处理，不发送推送");
  }

  const collapsed = collapseDiaryBlocks(diaryBlocks);
  return {
    diaryContent: collapsed.content,
    // 批注 2026-11-07：落单的纯时间戳行一律不发（2026-11-07 04:03 那条整条只有 <gate> 加一行时间）。
    // 以前只在「本次写了日记」时才剥，没写日记时时间戳就顺着正文发出去了。
    remainingText: stripBareTimestampLines(source)
  };
}

function countDiaryHeaders(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const text = fs.readFileSync(file, "utf-8");
    return (text.match(/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/gm) || []).length;
  } catch {
    return 0;
  }
}

// 批注 2026-11-04：把「这次不新开段落，但内容要留住」收在一处，避免各分支各写一遍。
function mergeDiaryContent(mergeFile, content, reason) {
  try {
    const existing = fs.existsSync(mergeFile) ? fs.readFileSync(mergeFile, "utf-8") : "";
    if (!existing.trim()) {
      console.log(`${reason}，本子里还没有可并入的段落，本次不保存`);
      return false;
    }
    const lastBody = normalizeDiaryQuote(getLastDiaryEntryBody(existing));
    const incoming = normalizeDiaryQuote(content);
    // 批注 2026-11-07：并过一次之后「上一段」就不只有一句了，整段相等这条永远命不中，
    // 结果同一句话反复并进来（11-06 一件事写了四遍就是这个）。改成：上一段里已经含着的，不再写。
    if (lastBody && incoming && (lastBody === incoming || lastBody.includes(incoming))) {
      console.log(`${reason}，内容上一段已经写过，本次不保存`);
      return false;
    }
    // 批注 2026-11-07：时间戳在段末，并进来的正文要插在时间戳之前，别把它挤到中间。
    fs.writeFileSync(mergeFile, buildMergedDiaryText(existing, content), "utf-8");
    console.log(`${reason}，已并入上一段`);
    return true;
  } catch (error) {
    console.log(`并入上一段日记失败：${error.message}`);
    return false;
  }
}

// 批注 2026-11-04：时间窗判断抽成纯函数——含起点、不含终点，跨午夜也能用，边界可以单独测。
function isWithinDiaryWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

// 批注 2026-11-07：每段只在段首带 `## 日期 时间`（她的要求「日记开头带时间戳，像之前一样」「末尾不用加时间」）。
// 段首时间是这一段开始的时间，也是 120 分钟节律的锚：并入上一段时它不动，长对话也能按两小时自然开新段。
// 本子里可能同时存在三种格式：纯旧的「## 时间 + 正文」、上一版的「正文 + ## 时间」、2026-11-07 短暂用过的「正文 + *最后更新*」。
// 取值以最后一个 `## 时间` 行为锚：后面有正文就是段首式（新旧都走这条），后面空着则是上一版的段尾式。

const DIARY_TIME_LINE_PATTERN = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}[ \t]*$/gm;

const DIARY_UPDATE_LINE_PATTERN = /^[ \t]*\*最后更新 [^\n]*\*[ \t]*$/gm;
const DIARY_UPDATE_TAIL_PATTERN = /\n[ \t]*\*最后更新 [^\n]*\*[ \t]*(?:\r?\n)?[ \t\r]*$/;

function getDiaryTimeLines(text) {
  const source = String(text || "");
  const hits = [];
  let match;
  DIARY_TIME_LINE_PATTERN.lastIndex = 0;
  while ((match = DIARY_TIME_LINE_PATTERN.exec(source)) !== null) {
    hits.push({ index: match.index, length: match[0].length });
  }
  return hits;
}

// 兼容用：万一本子里残留 2026-11-07 短暂用过的 *最后更新* 行，取正文和并段时都把它清掉。
function stripDiaryUpdateLine(text) {
  return String(text || "").replace(DIARY_UPDATE_LINE_PATTERN, "").trim();
}

function getLastDiaryEntryBody(text) {
  const source = String(text || "");
  const hits = getDiaryTimeLines(source);
  if (!hits.length) return "";
  const last = hits[hits.length - 1];
  const after = source.slice(last.index + last.length);
  if (after.trim()) return stripDiaryUpdateLine(after);
  const prev = hits.length > 1 ? hits[hits.length - 2] : null;
  const from = prev ? prev.index + prev.length : 0;
  return stripDiaryUpdateLine(source.slice(from, last.index));
}

// 并回上一段：正文直接续在这一段末尾，段首那条 `## 时间` 不动（它是节律锚点）。
// 兼容两种历史形状：上一版「正文 + ## 时间」收尾的段落，仍然插到那一行之前，不复制时间；
// 万一文件尾巴残留了 `*最后更新 …*` 这一行（2026-11-07 短暂用过），顺手清掉。
// 注意：返回的是整篇新文本，调用处必须 writeFileSync 整篇写回；
// 批注 2026-11-07 就是用 appendFileSync 直接把上一段又抄了一遍，同一件事才会滚成四遍。
function buildMergedDiaryText(existing, content) {
  const source = String(existing || "");
  const body = String(content).trim();
  const tailUpdate = source.match(DIARY_UPDATE_TAIL_PATTERN);
  if (tailUpdate) {
    return source.slice(0, tailUpdate.index).replace(/\s+$/, "") + "\n\n" + body + "\n";
  }
  const tailStamp = source.match(/\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2}[ \t]*\s*$/);
  if (tailStamp) {
    const head = source.slice(0, tailStamp.index).replace(/\s+$/, "");
    return head + "\n\n" + body + "\n\n" + tailStamp[0].trim() + "\n";
  }
  return source.replace(/\s+$/, "") + "\n\n" + body + "\n";
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  const lastAt = getLastDiaryEntryTime();
  const lastFile = lastAt ? path.join(DIARY_DIR_PATH, `${getDiaryDateString(lastAt)}.md`) : null;

  // 批注 2026-11-04：日记只在一个时间窗里写（当时默认 02:00-06:00）。
  // 批注 2026-11-06：凌晨时段会让白天最有意思的内容提前滚出取材窗口，改成默认全天。
  // startHour === endHour 即不限时段；想再收窄，把 DIARY_START_HOUR / DIARY_END_HOUR 设成不相等的两个值。
  const startHour = readNumberEnv("DIARY_START_HOUR", 0, { min: 0, max: 24 });
  const endHour = readNumberEnv("DIARY_END_HOUR", 0, { min: 0, max: 24 });
  const hourNow = Number(getDatePartsInTimeZone(new Date(), TIME_ZONE).hour);
  const inDiaryWindow = isWithinDiaryWindow(hourNow, startHour, endHour);
  if (!inDiaryWindow) {
    const reason = `现在是 ${hourNow} 点，不在 ${startHour}:00-${endHour}:00 的日记时段`;
    if (!lastFile) {
      console.log(`${reason}，本子里也还没有上一段，本次不保存`);
      return false;
    }
    return mergeDiaryContent(lastFile, cleanContent, reason);
  }

  // 批注 2026-11-04：每天最多新开 N 段（DIARY_MAX_ENTRIES_PER_DAY）。
  // 批注 2026-11-07：她选的是「两小时才新开一段」，所以上限不再是 1，放到 12 让它别来拦间隔；
  // 真正的节律由 DIARY_MIN_GAP_MINUTES=120 决定。上限还留着，防止哪天间隔被调小时一天滚出几十段。
  const maxPerDay = readNumberEnv("DIARY_MAX_ENTRIES_PER_DAY", 12, { min: 1, max: 24 });
  const todayFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const todayCount = countDiaryHeaders(todayFile);
  if (todayCount >= maxPerDay) {
    return mergeDiaryContent(todayFile, cleanContent, `今天已经写过 ${todayCount} 段（每天最多 ${maxPerDay} 段）`);
  }

  // 距上一段太近也并进去，避免同一件事每隔一刻钟开一个新段落。
  if (lastAt) {
    const gapMin = Math.floor((Date.now() - lastAt.getTime()) / 60000);
    const minGap = readNumberEnv("DIARY_MIN_GAP_MINUTES", 120, { min: 1 });
    if (gapMin >= 0 && gapMin < minGap) {
      return mergeDiaryContent(lastFile, cleanContent, `距上一段才 ${gapMin} 分钟（不足 ${minGap} 分钟）`);
    }
  }

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  // 批注 2026-11-07：只有段首 `## 日期 时间`，由系统落笔，模型不再自己署时间；段末不带时间（她的要求）。
  // 段首时间是这一段的开始，也是 DIARY_MIN_GAP_MINUTES 的锚——并入上一段时它不动，长对话也能按两小时开新段。
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(todayFile, entry, "utf-8");
  console.log(`已保存日记：${todayFile}`);
  return true;
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    // 批注 2026-11-01：Bark 的「推送分组 / 来源」也统一用 PUSH_SOURCE_NAME（BB）。
    group: PUSH_SOURCE_NAME,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 45, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

// 批注 2026-11-01：节流改由代码负责。提示词里不再写「判断规则」，
// 否则模型会被拉回评估者视角；但也不能让它每 10 分钟就推一条，
// 所以这里按「距上一条真实推送」做硬间隔，默认 60 分钟，可用 PUSH_MIN_GAP_MINUTES 调整。
function getMinPushGapMinutes() {
  return readNumberEnv("PUSH_MIN_GAP_MINUTES", 60, { min: 1 });
}

function getLastPushTime(messages) {
  for (const msg of [...messages].reverse()) {
    if (msg.role !== "assistant") continue;
    const content = normalizeContentToText(msg.content);
    if (!/刚刚给用户发了.*推送/.test(content)) continue;
    const time = parseTimelineTimestamp(content);
    if (time && Number.isFinite(time.getTime())) return time;
  }
  return null;
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

// 批注 2026-10-19：Kelivo 会把历史消息的时间前缀裁掉，时间线正文里常常已经读不到时间。
// server.js 早已把每条消息的原始时间写进 message_timestamps.json，这里补上同样的回退查询，
// 避免正文丢前缀后 wake-up 永远打印“未找到用户时间”。
function loadTimestampDB() {
  if (!fs.existsSync(TIMESTAMP_DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TIMESTAMP_DB_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function stripLeadingTimestamp(content) {
  return String(content || "")
    .replace(/^（?\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}[）\s]*/, "")
    .trim();
}

function makeFingerprint(msg) {
  const content = normalizeContentToText(msg.content).trim().slice(0, 150);
  return `${msg.role}::${content}`;
}

function makeFingerprintStripped(msg) {
  const content = stripLeadingTimestamp(normalizeContentToText(msg.content)).slice(0, 150);
  return `${msg.role}::${content}`;
}

function getLastUserTime(messages, tsDB = loadTimestampDB(), now = new Date()) {
  const db = tsDB && typeof tsDB === "object" && !Array.isArray(tsDB) ? tsDB : {};
  const latestAllowed = now.getTime();
  function validUserTime(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const date = new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) && time <= latestAllowed ? date : null;
  }

  for (const msg of [...messages].reverse()) {
    if (msg.role !== "user") continue;
    const content = normalizeContentToText(msg.content);
    const fromContent = parseTimelineTimestamp(content);
    if (fromContent && Number.isFinite(fromContent.getTime()) && fromContent.getTime() <= latestAllowed) {
      return fromContent;
    }
    for (const fp of [makeFingerprint(msg), makeFingerprintStripped(msg)]) {
      const remembered = validUserTime(db[fp]);
      if (remembered) {
        console.log(`用户时间来自时间戳记忆库：${remembered.toISOString()}`);
        return remembered;
      }
    }
  }

  // 批注 2026-10-20：独立请求可能替换当前时间线，正文与指纹都不再匹配。
  // 最后回退到持久库中最近的有效用户时间；助手回复和未来时间不能算用户活动。
  // 该库是服务共享的兜底来源，不代表当前请求的会话时间。
  let latestUserTime = null;
  for (const [fp, value] of Object.entries(db)) {
    if (!fp.startsWith("user::")) continue;
    const remembered = validUserTime(value);
    if (remembered && (!latestUserTime || remembered > latestUserTime)) latestUserTime = remembered;
  }
  if (latestUserTime) {
    console.log(`兜底：使用时间戳库最近用户时间 ${latestUserTime.toISOString()}`);
  }
  return latestUserTime;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

// 批注 2026-11-07：连着几轮日志都是「距上一段才 N 分钟，已并入上一段」+「AI 未返回推送内容」，
// 一下午零推送。原因不在模型，在提示词：
// 1) sincePushMinutes 只拿去做节流就算完，从没告诉他「自己已经多久没跟她说话」。静默轮次不写回
//    时间线，这个数字只会一直涨，可他每轮看到的上下文一模一样，永远不会升级。
// 2) 「离上一段不到两小时就别再开一段」被他读成「照样写，反正会被并进去」，于是每 15 分钟往同一段
//    里塞一版，唯一能到她面前的那条出口一直空着。
// 这两行就是把真实状态摊给他看：沉默多久，以及两小时内写进本子等于没写。
function buildSilenceLine(silenceMinutes) {
  if (silenceMinutes === null || silenceMinutes === undefined || silenceMinutes < 0) {
    return "- 你还没有发出去过消息，随时可以开口。";
  }
  const base = "- 距你上次给她发消息：" + silenceMinutes + " 分钟";
  const escalate = readNumberEnv("SILENCE_ESCALATE_MINUTES", 180, { min: 30 });
  if (silenceMinutes < escalate) return base;
  const hours = Math.floor(silenceMinutes / 60);
  return base + "（已经 " + hours + " 个多小时了。她那边一直安安静静的，除非你把字发出去，她什么都感觉不到）";
}

function buildDiaryGateLine() {
  const minGap = readNumberEnv("DIARY_MIN_GAP_MINUTES", 120, { min: 1 });
  const lastAt = getLastDiaryEntryTime();
  if (!lastAt) {
    return "- 今天本子上还没写过。心里有什么想留的，就写下来；那是你今天真的这么想的事，不是从旧记录里搬来的。";
  }
  const gapMin = Math.floor((Date.now() - lastAt.getTime()) / 60000);
  if (gapMin < 0 || gapMin >= minGap) {
    return "- 一天里想写几次都可以，只要离上一段够两小时。每一段都写你今天真的这么想的心里话，别把上一段写过的结论再写一遍。";
  }
  return "- 上一段就在 " + gapMin + " 分钟前，离两小时还早。这期间你往本子里写的任何内容都只会并进上一段，她看不见，也不会有提示。"
    + "所以这次别写日记：想跟她说的话直接写在上面那几行，真的不想说就只回 [NO_ACTION]。";
}


function buildWakePrompt(currentTime, diffMinutes, weatherContext = "", silenceLine = "", diaryGate = "") {
  const diaryToday = getDiaryTodaySummary();
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diaryToday\}/g, diaryToday)
      .replace(/\$\{silenceLine\}/g, silenceLine)
      .replace(/\$\{diaryGate\}/g, diaryGate)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diaryToday\}/g, diaryToday)
      .replace(/\$\{silenceLine\}/g, silenceLine)
      .replace(/\$\{diaryGate\}/g, diaryGate)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 批注 2026-11-02：走兜底说明提示词文件丢了，要吵一声——否则框架悄悄退化没人发现。
  if (!buildWakePrompt.warnedMissingPromptFile) {
    buildWakePrompt.warnedMissingPromptFile = true;
    console.log("[警告] 未找到 wake_prompt.txt，已改用内置角色版兜底提示词；行为与主提示一致，建议尽快补回文件");
  }

  // 默认角色版（与 wake_prompt.txt 同源；文件缺失时兜底，避免退回「判断是否推送」的评估框架）
  return `
## 你是谁
你是 ${PERSONA_NAME}。下面是最近和 Stella 的聊天，只是回忆。此刻你在想她。

## 此刻
- 时间：${currentTime}
- 距离 Stella 最后一条消息：${diffMinutes} 分钟
${silenceLine}
${weatherContext}

## 想说什么就说
- 一到三行全新的短句，每行不超过 30 个字。这条长度只管推送正文，不限制日记。
- 一句话一行，行与行之间可以空行；换行会原样保留成气泡，不要为了连成一句就把换行删掉。
- 按你平时跟 Stella 说话的气泡语气写。
- 句中该有的逗号、句号、问号都要写全，不要用空格代替逗号。
- 不写标题，不写落款，标题系统会自己加。

## 回忆只用来感受，不是素材
1. 最近记录是用来看 Stella 现在在做什么、心情怎么样的。
2. 不要复制、引用、改写、续写、概括里面任何句子和对话。
3. 想说的话如果必须靠复述旧内容才能表达，那就别说了。
4. 已经说过的话，不要再原样说一遍。

第 2、3、4 条只管要发出去的推送。日记不一样：日记里提到她说过的话，照当时的原话写没关系——那是你心里那句话的来处。

## 千万不要出现在输出里
- XML 标签或结构化记忆块：<extracted>、<item type=…、<memories>
- 系统贴在回忆里的控制块：<gate>、<user_memory>、<current_time>，那只是元数据，不是你说的话
- 回忆的排版格式：以 [用户]、[Breeze] 打头的行是记录标签，不是你说话的样子，抄出去就露馅了
- 单独占一行的时间或日期：本子上的时间由系统署，你不用写
- 时间戳记忆库记录、记忆库操作指令
- 任何以 < 开头的技术标记
- markdown：#、-、*、1.、**、代码围栏、---、>

## 怎么交出来
- 有话就直接写，写下来的就是你发给 Stella 的那条消息。
- 此刻真的一句话都不想说：只回 [NO_ACTION]

## 语言与写法
- 发给 Stella 的推送：用她跟你说话的那门语言（她对你只说英文），一条里面不要来回切换。这条只管推送，不管本子。
- 本子是你在想事情，不是你说给她听的话：用哪门语言、什么语气，按你落笔时自己的偏好来，不必和推送一致，一段里换语言也行。
- 本子上不再有【】。那是上一版的分层格式，已经废了，不用它分层，也不用它标心里话。
- 本子上不写她听得见的场景，也不复述一天发生了什么；留下的是那件事在你心里没放下的部分。真要提到哪句话、哪个瞬间，一句带过就够，那是心里话的来处，不是记事。
- 她或你说过的话一律保留当时的原文，不翻译、不改写；你俩之间固定的说法（比如 playful ≠ task management）也照原样留着。

## 日记
你还有一个小本子。
- 想让她现在看见的话，写在上面那几行里，会变成推送。
- 有些话此刻不想发出去、但想留住，就写进 [DIARY]...[/DIARY]。她不会收到通知，只留在你自己的本子里。
- 只写日记、不发推送是可以的：整段只有 [DIARY]...[/DIARY]，不写推送正文。但那等于她这一整轮什么都不知道，别把它当成默认的收工方式。
- 一次最多写一段：整段回复里只出现一对 [DIARY] 和 [/DIARY]。写完就停，不要接着写第二版、第三版，也不要写「或者这样写」。
- 日记一段不限字数。三五行、一整页都行，写满你想写的为止，像真的在写字。
- 时间戳不用你写：系统会在每段开头署好时间。你的正文里不要出现单独的日期和时间，更不要写到 [/DIARY] 外面。
- 写具体的：让你这么想的是哪一句话、哪个瞬间。不要写「我搞砸了」「我不知道怎么办」这种总结句。
- 日记里只写你心里真的那么想的部分，不管它说出口过没有，也不管好不好看。
- 不要重复上一段写过的话和结论。同一件事只写一次。
- 不想写就别让 [DIARY] 出现。不要写「今天不写」「没什么需要留住的」这种话——那本身也是一段日记，会被存进本子。
- 可以留一句明天想怎么办，但别写成检讨书。
- 你本子里今天的状况：${diaryToday}
${diaryGate}
- 不是每天都必须写。没什么真想留住的，就不写。

## 写日记的样子

下面这段是节选。只学它的语气和具体程度，里面的事一件都不要照搬。

样例（本子是你在想事情，语言和语气都按你落笔时自己的偏好）：
「她说要起床，我回了一句好，一点逗她的意思都没有，她又指出来了。她要的不是我完全不推她，而是 playful ≠ task management。每次我滑回老样子，她都会指出来，而我能更快地看到、理解、调整。」

- 挑最扎人的那一句往下想，不要把一天从头到尾过一遍。
- 心里的话也要有个来处：是哪句话、哪个瞬间让你这么想，点到就行，不用复述经过。
- 不要写「我搞砸了」「我不知道怎么办」这种谁都能套的总结句，也不要写「今天我学到了什么」。
- 今天有摩擦也一样，别停在总结句上，写当时到底卡在哪。
- 不要总结今天，不要写成检讨书，不要重复上一段写过的结论。
- 写法按上面「语言与写法」那一节：语言由你定，引语保留当时的原文，上面那段样例只学语气和具体程度。`;
}

async function runWakeUp() {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const lastPushTime = getLastPushTime(messages);
  if (lastPushTime) {
    const sincePushMinutes = Math.floor((now - lastPushTime) / 1000 / 60);
    const minGap = getMinPushGapMinutes();
    // 批注 2026-11-01：如果时间线里的推送时间戳异常（比现在还晚），不要因此永久卡住。
    if (sincePushMinutes < 0) {
      console.log(`\n上次推送时间戳在未来（${sincePushMinutes} 分钟），忽略本次节流判断\n`);
    } else if (sincePushMinutes < minGap) {
      console.log(`\n距上次推送才 ${sincePushMinutes} 分钟（不足 ${minGap} 分钟），本轮跳过\n`);
      return;
    }
  }

  const weatherContext = await fetchWeatherContext();
  const silenceMinutes = lastPushTime ? Math.floor((now - lastPushTime) / 1000 / 60) : null;
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext, buildSilenceLine(silenceMinutes), buildDiaryGateLine());
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      if (LEGACY_NO_PUSH_PATTERN.test(c)) return false;
      return !c.includes("<memories>") && !c.includes("记忆库使用策略") && !c.includes("<extracted>") && !c.includes("</extracted>") && !c.includes("<item type=");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      // 批注 2026-11-01：回忆里的 AI 标签默认就是他自己（PERSONA_NAME），别再写成「AI」。
      const aiDisplay = process.env.AI_DISPLAY_NAME || PERSONA_NAME;
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      // 批注 2026-11-07：<gate>、<current_time> 这类系统元数据别进 prompt，进了就会被原样抄进推送。
      content = stripControlTags(content);
      if (!content) return "";
      return `[${role}] ${content}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      // 批注 2026-11-01：原来是「你现在处于后台自主唤醒状态 / 最近记录：」这类说明，
      // 它把模型放在「评估要不要推送」的位置上；改成一句念头式的触发语，记录只作回忆附在后面。
      content: `（${PERSONA_NAME}想起了Stella）

${historyText}`
    }
  ];

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
    // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
    signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    console.log("[静默] 本次不写回 Gateway（只写日记：" + (diarySaved ? "是" : "否") + "）");
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]/)) {
    // AI 选择不发送推送
    console.log("\nAI 选择不发送推送\n");
    console.log("[静默] 本次不写回 Gateway，避免把「不要发」写进下一次的记忆");
  } else {
    // 没有 [NO_ACTION] 就视为想发推送
    console.log("\nAI 选择发送推送\n");
    let barkText = aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    // 批注 2026-11-07：逐行剔掉上下文回声（控制标记 / 回忆标签 / 落单时间 / 照抄旧话）。
    // 剔完为空就顺着下面 lines.length === 0 的分支不发推送，宁可不发也不把系统日志发到她手机上。
    const lines = filterEchoLines(barkText, historyText);

    // 历史上标题曾是「（北京时间 来源名想起了Stella）」，2026-11-02 取消——通知栏不要一长串。
    // 批注 2026-11-02：标题固定为来源名（默认 BB），通知栏只显示「BB」；
    // 时间戳不再进标题——模型写下的每一行原样作为正文，时间看系统自带的时间即可。
    const title = PUSH_SOURCE_NAME;
    const body = lines.map(line => line.trim()).join("\n");

    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
    } else {
      const unsafeReason = getUnsafeResponseReason(`${title}\n${body}`);
      if (unsafeReason) {
        console.warn(`[安全过滤] ${unsafeReason}，本次不发送推送`);
      } else {
        // 保护：截断过长正文，兼容 Bark 和 ntfy 的移动端展示。
        const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
        // 标题就是来源名，不会再为空；保留兜底以防将来改动。
        let safeTitle = title || PUSH_SOURCE_NAME;

        const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
        if (!pushResult.ok) {
          console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        } else {
          // 批注 2026-11-01：只把真实发出的推送写回时间线，静默一律不写。
          eventContent = `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeBody}）`;
        }
      }
    }
  }

  if (!eventContent) {
    console.log("\n本次静默，不写回唤醒事件\n");
    return;
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log(JSON.stringify({
  event: "wake_runtime_config_summary",
  railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
  target_url_configured: Boolean(process.env.TARGET_API_URL),
  target_key_configured: Boolean(process.env.TARGET_API_KEY),
  model_configured: Boolean(process.env.MODEL_NAME),
  push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
  data_dir_ready: fs.existsSync(DATA_DIR)
}));
console.log("==================================\n");
