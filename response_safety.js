const DANGEROUS_XML_PATTERNS = [
  /<\/?(?:extracted|memories|environment_context|thinking|system|heartbeat)\b/i,
  /<item\s+type\s*=/i,
  /记忆库使用策略/i,
  /\[SYSTEM\][\s\S]*?\[\/SYSTEM\]/i
];

const MEMORY_JSON_FIELD_PATTERN = /["'](?:results|action|targetId|mergedContent|relatedIds)["']\s*:/i;
const MEMORY_ID_PATTERN = /\bmem_[a-z0-9]{6,}\b/i;

function getUnsafeResponseReason(text) {
  const source = String(text ?? "");
  if (!source.trim()) return "";

  for (const pattern of DANGEROUS_XML_PATTERNS) {
    if (pattern.test(source)) return "检测到系统/记忆 XML 标记";
  }

  // 记忆服务的结果可能是完整 JSON，也可能在模型回复中被截断；
  // 因此同时检查 JSON 字段和 mem_ 条目标识，不能只依赖 JSON.parse。
  const hasResultsField = /["']results["']\s*:/i.test(source);
  const hasMemoryFields = MEMORY_JSON_FIELD_PATTERN.test(source);
  if ((hasResultsField && hasMemoryFields) || MEMORY_ID_PATTERN.test(source)) {
    return "检测到记忆服务 JSON 结果或记忆条目标识";
  }

  return "";
}

function isUnsafeResponse(text) {
  return Boolean(getUnsafeResponseReason(text));
}

module.exports = {
  getUnsafeResponseReason,
  isUnsafeResponse
};
