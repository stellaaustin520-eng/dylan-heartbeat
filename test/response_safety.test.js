const test = require("node:test");
const assert = require("node:assert/strict");
const { getUnsafeResponseReason, isUnsafeResponse } = require("../response_safety");

test("blocks complete memory merge JSON", () => {
  const text = '{"results":[{"action":"MERGE","targetId":"mem_a7d4c881","mergedContent":"用户会在写作前估计时间"}]}';
  assert.equal(isUnsafeResponse(text), true);
  assert.match(getUnsafeResponseReason(text), /记忆服务/);
});

test("blocks truncated memory JSON from a push", () => {
  const text = '{\n"results": [{\n"index": 1,\n"action": "MERGE",\n"targetId": "mem_a7d4c881",\n...';
  assert.equal(isUnsafeResponse(text), true);
});

test("blocks extracted and instruction wrappers", () => {
  assert.equal(isUnsafeResponse('<extracted><item type="instruction">不要分析</item></extracted>'), true);
  assert.equal(isUnsafeResponse('<environment_context>internal context</environment_context>'), true);
});

test("allows ordinary assistant text", () => {
  assert.equal(isUnsafeResponse("我刚刚想到你，今天学习还顺利吗？"), false);
  assert.equal(isUnsafeResponse("我记得你喜欢在晚上散步。"), false);
});
