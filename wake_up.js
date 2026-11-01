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
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
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

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

## 输出格式
- 如果想联系用户，直接写你想说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- **使用自然流畅的中文句子。句中在并列成分之间、从句与主句之间、较长短语之后、需要停顿的地方都要写逗号，句末使用句号、问号或感叹号。每一条气泡单独占一行，不要合并成一整段。**
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果你想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
`;
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
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext);
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
      return `[${role}] ${content}`;
    })
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
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    // 批注 2026-11-01：标题改为统一的「（北京时间 来源名想起了Stella）」格式；
    // 单行、两行、多行不再各走一套标题（旧的“来自AI”“来自伴侣”已废弃），
    // 模型写下的每一行都原样进入正文。
    const title = `（${getChinaTimeString()} ${PUSH_SOURCE_NAME}想起了Stella）`;
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
        // 标题已固定为「（时间 来源名…）」，理论上不会为空；保留兜底以防将来改动。
        let safeTitle = title || PUSH_SOURCE_NAME;
        if (/^\d/.test(safeTitle)) safeTitle = `${PUSH_SOURCE_NAME}｜${safeTitle}`;

        const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
        if (!pushResult.ok) {
          console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        } else {
          // 批注 2026-11-01：只把真实发出的推送写回时间线，静默一律不写。
          eventContent = `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
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
