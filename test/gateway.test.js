import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { ThreadQueue, buildPrimeRunnerArgs, buildRpcRunnerArgs, createGateway, firstMention, loadGatewayConfig, parseAllowlist, primeSlackGatewayExtension, redactGatewayConfig, registerSocketEventHandlers, stripMention, threadKey } from "../index.js";

test("factory registers an explicit start hook without starting Slack", () => {
  let registration;
  primeSlackGatewayExtension({ registerCommand: (name, options) => { registration = { name, options }; } });
  assert.equal(registration.name, "slack-gateway");
  assert.match(registration.options.description, /explicit opt-in/);
  assert.equal(typeof registration.options.handler, "function");
});

test("exports a valid Prime Agent extension factory without side effects", () => {
  assert.equal(typeof primeSlackGatewayExtension, "function");
  assert.deepEqual(buildPrimeRunnerArgs({ cwd: "/work", sessionDir: "/tmp/thread", prompt: "hello" }), [
    "--print", "--cwd", "/work", "--session-dir", "/tmp/thread", "--no-extensions", "--no-skills", "--", "hello",
  ]);
  assert.deepEqual(buildPrimeRunnerArgs({ cwd: "/work", sessionDir: "/tmp/thread", resumed: true, prompt: "follow up" }).slice(-3), ["--continue", "--", "follow up"]);
});

test("builds an RPC runner command for persistent per-thread sessions", () => {
  assert.deepEqual(buildRpcRunnerArgs({ cwd: "/work", sessionDir: "/tmp/thread" }), [
    "--mode", "rpc", "--cwd", "/work", "--session-dir", "/tmp/thread", "--no-extensions", "--no-skills",
  ]);
});

test("loads 0600 config and applies environment overrides without exposing tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prime-slack-config-"));
  const configPath = path.join(dir, "slack-gateway.json");
  const secrets = { botToken: "xoxb-test-secret", appToken: "xapp-test-secret" };
  await writeFile(configPath, JSON.stringify({ ...secrets, allowedUsers: ["U1"], concurrency: 3 }));
  await chmod(configPath, 0o600);
  const config = await loadGatewayConfig({ configPath, env: { PRIME_SLACK_ALLOWED_USERS: "U2", PRIME_SLACK_CONCURRENCY: "2" } });
  assert.equal(config.botToken, secrets.botToken);
  assert.equal(config.appToken, secrets.appToken);
  assert.equal(config.allowedUsers, "U2");
  assert.equal(config.concurrency, 2);
  const redacted = redactGatewayConfig(config);
  assert.equal(redacted.botToken, "[redacted]");
  assert.equal(redacted.appToken, "[redacted]");
  assert.doesNotMatch(JSON.stringify(redacted), /xoxb-test-secret|xapp-test-secret/);
  await chmod(configPath, 0o644);
  await assert.rejects(loadGatewayConfig({ configPath, env: {} }), /mode 0600/);
  await rm(dir, { recursive: true, force: true });
});

test("allowlist and mention parsing are fail-safe", () => {
  assert.deepEqual([...parseAllowlist("U1, U2")], ["U1", "U2"]);
  assert.equal(parseAllowlist("").size, 0);
  assert.equal(parseAllowlist("*"), null);
  assert.equal(firstMention("hi <@B1>", "B1"), true);
  assert.equal(stripMention("<@B1> hi", "B1"), "hi");
});
test("first mention opens an isolated thread and replies do not need mention", async () => {
  const seen = [], posted = [];
  const q = new ThreadQueue({ concurrency: 2, handler: async x => { seen.push(x); return `answer:${x.prompt}`; } });
  const g = createGateway({ botUserId: "B1", allowlist: new Set(["U1"]), queue: q, runPrime: async () => "unused", post: async x => posted.push(x) });
  assert.deepEqual(await g.onMessage({ user:"U1", channel:"C1", ts:"1", text:"hello" }), { ignored:"mention-required" });
  assert.equal((await g.onMessage({ user:"U1", channel:"C1", ts:"2", text:"<@B1> hello" })).handled, true);
  assert.equal((await g.onMessage({ user:"U1", channel:"C1", ts:"3", thread_ts:"2", text:"follow up" })).handled, true);
  assert.equal(seen.length, 2); assert.equal(posted.length, 2); assert.equal(posted[1].thread_ts, "2");
  assert.deepEqual(await g.onMessage({ user:"U9", channel:"C1", ts:"4", text:"<@B1> no" }), { ignored:"user-not-allowed" });
});

test("registers Socket Mode direct message and app_mention events", async () => {
  const posted = [];
  const q = new ThreadQueue({ concurrency: 1, handler: async ({ prompt }) => `answer:${prompt}` });
  const g = createGateway({ botUserId: "B1", allowlist: new Set(["U1"]), queue: q, runPrime: async () => "unused", post: async x => posted.push(x) });
  const listeners = {};
  const socket = { on: (name, fn) => { listeners[name] = fn; } };
  registerSocketEventHandlers(socket, g);
  let acked = 0;
  await listeners.app_mention({ ack: async () => { acked++; }, event: { type: "app_mention", user: "U1", channel: "C1", ts: "10", text: "<@B1> hello" } });
  assert.equal(acked, 1);
  assert.equal(posted[0].thread_ts, "10");
});


test("deduplicates the same Slack message across event types and retries", async () => {
  let runs = 0;
  const q = new ThreadQueue({ concurrency: 1, handler: async () => { runs++; return "ok"; } });
  const g = createGateway({ botUserId: "B1", allowlist: new Set(["U1"]), queue: q, runPrime: async () => "unused", post: async () => {} });
  const event = { user: "U1", team: "T1", channel: "C1", ts: "35", text: "<@B1> once" };
  const results = await Promise.all([g.onMessage(event), g.onMessage({ ...event, type: "app_mention" })]);
  assert.equal(runs, 1);
  assert.equal(results.filter(result => result.ignored === "duplicate-event").length, 1);
});

test("serializes concurrent turns within one Slack thread", async () => {
  let active = 0;
  let peak = 0;
  const q = new ThreadQueue({ concurrency: 4, handler: async ({ prompt }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    return prompt;
  } });
  const posted = [];
  const g = createGateway({ botUserId: "B1", allowlist: new Set(["U1"]), queue: q, runPrime: async () => "unused", post: async x => posted.push(x) });
  await Promise.all([
    g.onMessage({ user: "U1", channel: "C1", ts: "20", text: "<@B1> first" }),
    g.onMessage({ user: "U1", channel: "C1", ts: "21", thread_ts: "20", text: "second" }),
  ]);
  assert.equal(peak, 1);
  assert.equal(posted.length, 2);
});

test("posts a safe error reply when a thread turn fails", async () => {
  const posted = [];
  const q = new ThreadQueue({ concurrency: 1, handler: async () => { throw new Error("worker failed /Users/jachinshen/.prime/x"); } });
  const g = createGateway({ botUserId: "B1", allowlist: new Set(["U1"]), queue: q, runPrime: async () => "unused", post: async x => posted.push(x) });
  const result = await g.onMessage({ user: "U1", channel: "C1", ts: "30", text: "<@B1> fail" });
  assert.equal(result.failed, true);
  assert.match(posted[0].text, /Prime Agent failed: worker failed/);
  assert.doesNotMatch(posted[0].text, /Users\/jachinshen/);
  assert.equal(g.status().failed, 1);
});

test("adds and removes a processing reaction around a turn", async () => {
  const reactions = [];
  const q = new ThreadQueue({ concurrency: 1, handler: async () => "done" });
  const g = createGateway({
    botUserId: "B1",
    allowlist: new Set(["U1"]),
    queue: q,
    runPrime: async () => "unused",
    post: async () => {},
    processingReaction: async event => reactions.push(event),
  });
  await g.onMessage({ user: "U1", channel: "C1", ts: "40", text: "<@B1> work" });
  assert.deepEqual(reactions, [
    { channel: "C1", timestamp: "40", active: true },
    { channel: "C1", timestamp: "40", active: false },
  ]);
});

test("queue limits parallel work", async () => {
  let active=0, peak=0;
  const q = new ThreadQueue({ concurrency: 2, handler: async () => { active++; peak=Math.max(peak,active); await new Promise(r=>setTimeout(r,10)); active--; return "ok"; } });
  await Promise.all(Array.from({length:5}, () => q.push({})));
  assert.equal(peak,2);
});
