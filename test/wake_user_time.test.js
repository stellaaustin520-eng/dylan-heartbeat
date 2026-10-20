const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// 执行真实唤醒源码，隔离定时器、环境、文件写入与网络；不会发送推送。
function loadWake(db = {}) {
  const filename = path.join(__dirname, "..", "wake_up.js");
  const localRequire = createRequire(filename);
  const logs = [];
  const sandbox = {
    __dirname: path.dirname(filename),
    process: { env: { TIME_ZONE: "Asia/Shanghai" } },
    console: { log: (...args) => logs.push(args.join(" ")), warn() {}, error() {} },
    setTimeout() {},
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "fs") return {
        existsSync: () => true,
        readFileSync: () => JSON.stringify(db)
      };
      if (name === "./runtime_paths") return {
        ensureDataDir: () => "/test-data",
        runtimeFile: name => "/test-data/" + name,
        runtimeDirectory: name => "/test-data/" + name
      };
      return localRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  return { get: sandbox.getLastUserTime, logs };
}
const now = new Date("2026-10-20T05:50:00.000Z");
const user = content => ({ role: "user", content });

test("无匹配指纹的辅助消息仍能回退到最近的用户时间", () => {
  const db = {
    "user::旧聊天": "2026-10-20T03:00:00.000Z",
    "user::最近聊天": "2026-10-20T04:30:00.000Z",
    "assistant::回复": "2026-10-20T05:40:00.000Z"
  };
  const wake = loadWake(db);
  assert.equal(wake.get([user("独立辅助请求")], db, now)?.toISOString(), db["user::最近聊天"]);
  assert.ok(wake.logs.some(line => line.includes("兜底：使用时间戳库最近用户时间")));
});

test("库回退排除非用户、无效、空值及未来时间", () => {
  const db = {
    "assistant::回复": "2026-10-20T05:45:00.000Z",
    "system::规则": "2026-10-20T05:40:00.000Z",
    "user::无效": "不是时间",
    "user::空值": null,
    "user::空串": "",
    "user::数字": 42,
    "user::未来": "2026-10-21T00:00:00.000Z",
    "user::有效": "2026-10-20T04:00:00.000Z"
  };
  assert.equal(loadWake().get([user("无前缀")], db, now)?.toISOString(), db["user::有效"]);
  delete db["user::有效"];
  assert.equal(loadWake().get([user("无前缀")], db, now), null);
});

test("保留正文和指纹匹配的优先级及原有日期格式", () => {
  const wake = loadWake();
  for (const prefix of ["2026-10-20 12:30", "（2026/10/2012：30）"]) {
    assert.equal(wake.get([user(prefix + " 正文")], {}, now).toISOString(), "2026-10-20T04:30:00.000Z");
  }
  const db = { "user::正文": "2026-10-20T04:20:00.000Z", "user::别处": "2026-10-20T05:00:00.000Z" };
  assert.equal(wake.get([user("正文")], db, now).toISOString(), db["user::正文"]);
});

test("坏的完整指纹不阻止去前缀匹配，坏日期不阻止继续查找", () => {
  const msg = user("（2099-01-01 00:00）正文");
  const db = { ["user::" + msg.content]: "坏日期", "user::正文": "2026-10-20T04:20:00.000Z" };
  assert.equal(loadWake().get([msg], db, now)?.toISOString(), db["user::正文"]);
  assert.equal(loadWake().get([user("2026-10-20 11:00 旧消息"), user("新消息")], { "user::新消息": "坏日期" }, now)?.toISOString(), "2026-10-20T03:00:00.000Z");
});

test("空库与无效库仍返回空，默认从磁盘库加载", () => {
  assert.equal(loadWake().get([user("无时间")], {}, now), null);
  for (const db of [null, [], "无效库"]) {
    assert.equal(loadWake().get([user("无时间")], db, now), null);
  }
  const db = { "user::历史": "2026-10-20T04:30:00.000Z" };
  assert.equal(loadWake(db).get([user("无时间")], undefined, now)?.toISOString(), db["user::历史"]);
});
