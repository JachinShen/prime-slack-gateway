import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG_FILENAME = "slack-gateway.json";
const CONFIG_ENV = "PRIME_SLACK_CONFIG";

function defaultConfigPath(homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd()) {
  return path.join(homeDir, ".prime", "agent", DEFAULT_CONFIG_FILENAME);
}

function envValue(env, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  }
  return undefined;
}

function validateConfig(config, source) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Slack Gateway config must be a JSON object (${source})`);
  }
  const allowed = new Set(["botToken", "appToken", "allowedUsers", "concurrency", "cwd", "sessionRoot"]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new Error(`Unknown Slack Gateway config field: ${key}`);
  }
  for (const key of ["botToken", "appToken", "cwd", "sessionRoot"]) {
    if (config[key] !== undefined && (typeof config[key] !== "string" || !config[key].trim())) {
      throw new Error(`Slack Gateway config field ${key} must be a non-empty string`);
    }
  }
  if (config.allowedUsers !== undefined && config.allowedUsers !== "" &&
      !(typeof config.allowedUsers === "string" || (Array.isArray(config.allowedUsers) && config.allowedUsers.every(v => typeof v === "string")))) {
    throw new Error("Slack Gateway config field allowedUsers must be a string or array of strings");
  }
  if (config.concurrency !== undefined && (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 64)) {
    throw new Error("Slack Gateway config field concurrency must be an integer from 1 to 64");
  }
  return config;
}

/** Return a config-shaped object that can safely be included in diagnostics. */
export function redactGatewayConfig(config = {}) {
  return {
    ...config,
    ...(config.botToken !== undefined ? { botToken: "[redacted]" } : {}),
    ...(config.appToken !== undefined ? { appToken: "[redacted]" } : {}),
  };
}

/**
 * Load the gateway config only when the user explicitly starts the gateway.
 * The file is owner-only (0600); environment variables override file values.
 */
export async function loadGatewayConfig({ configPath, env = process.env, homeDir } = {}) {
  const filePath = configPath || envValue(env, CONFIG_ENV) || defaultConfigPath(homeDir || env.HOME || env.USERPROFILE);
  let fileConfig = {};
  try {
    const info = await stat(filePath);
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error(`Slack Gateway config must have mode 0600: ${filePath}`);
    }
    try {
      fileConfig = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      throw new Error(`Slack Gateway config is not valid JSON: ${filePath}`);
    }
    validateConfig(fileConfig, filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const config = { ...fileConfig };
  const overrides = [
    ["botToken", ["PRIME_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN"]],
    ["appToken", ["PRIME_SLACK_APP_TOKEN", "SLACK_APP_TOKEN"]],
    ["allowedUsers", ["PRIME_SLACK_ALLOWED_USERS"]],
    ["cwd", ["PRIME_SLACK_CWD"]],
    ["sessionRoot", ["PRIME_SLACK_SESSION_ROOT"]],
  ];
  for (const [key, names] of overrides) {
    const value = envValue(env, ...names);
    if (value !== undefined && (key === "allowedUsers" || value !== "")) config[key] = value;
  }
  const concurrency = envValue(env, "PRIME_SLACK_CONCURRENCY");
  if (concurrency !== undefined && concurrency !== "") {
    const parsed = Number(concurrency);
    if (!Number.isInteger(parsed)) throw new Error("PRIME_SLACK_CONCURRENCY must be an integer");
    config.concurrency = parsed;
  }
  return validateConfig(config, filePath);
}

/**
 * Prime Agent extension entrypoint.
 *
 * The Socket Mode gateway is intentionally opt-in: loading this module must
 * never contact Slack or read credentials. Runtime users can call
 * startSocketGateway() explicitly from their host process.
 */
export function primeSlackGatewayExtension(pi) {
  if (!pi || typeof pi.registerCommand !== "function") {
    throw new TypeError("Prime Slack Gateway requires the Prime Agent ExtensionAPI");
  }
  let running;
  pi.registerCommand("slack-gateway", {
    description: "Start or inspect the Prime Slack Socket Mode gateway (explicit opt-in)",
    handler: async (args, ctx) => {
      const command = String(args || "").trim().toLowerCase();
      if (command === "status") {
        ctx.ui.notify(running ? JSON.stringify(running.status()) : "Prime Slack Gateway is not running", "info");
        return;
      }
      if (command === "stop") {
        if (!running) {
          ctx.ui.notify("Prime Slack Gateway is not running", "info");
          return;
        }
        await running.stop();
        running = undefined;
        ctx.ui.notify("Prime Slack Gateway stopped", "info");
        return;
      }
      if (command && command !== "start") {
        ctx.ui.notify("Usage: /slack-gateway [start|status|stop]", "warning");
        return;
      }
      if (running) {
        ctx.ui.notify("Prime Slack Gateway is already running", "info");
        return;
      }
      try {
        const config = await loadGatewayConfig();
        const cwd = config.cwd || ctx.cwd;
        const sessionRoot = config.sessionRoot ||
          path.join(process.env.PRIME_AGENT_HOME || process.env.HOME || cwd, ".prime", "slack-sessions");
        // Credentials are read only after this explicit command and are never logged.
        // startSocketGateway creates one persistent RPC runner per Slack thread.
        running = await startSocketGateway({ ...config, cwd, sessionRoot,
          logger: message => ctx.ui.notify(message, "error") });
        ctx.ui.notify("Prime Slack Gateway started", "info");
      } catch (error) {
        running = undefined;
        ctx.ui.notify(error instanceof Error ? error.message : "Prime Slack Gateway failed to start", "error");
      }
    },
  });
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", async () => {
      try { await running?.stop?.(); } catch { /* best-effort cleanup during host shutdown */ }
      running = undefined;
    });
  }
}
export default primeSlackGatewayExtension;

export function parseAllowlist(value) {
  if (value == null || value === "") return new Set(); // fail closed when no allowlist is configured
  const ids = String(value).split(",").map(s => s.trim()).filter(Boolean);
  return ids.includes("*") ? null : new Set(ids);
}
export function isAllowed(userId, allowlist) { return allowlist === null || allowlist.has(userId); }
export function stripMention(text, botUserId) {
  if (!text || !botUserId) return text?.trim() ?? "";
  return text.replace(new RegExp(`<@${escapeRegex(botUserId)}>`, "g"), "").trim();
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function threadKey(event) { return `${event.team ?? ""}:${event.channel}:${event.thread_ts || event.ts}`; }
export function firstMention(text, botUserId) { return Boolean(botUserId && new RegExp(`<@${escapeRegex(botUserId)}>`).test(text || "")); }

export class ThreadQueue {
  constructor({ concurrency = 4, handler }) { this.concurrency = concurrency; this.handler = handler; this.active = 0; this.pending = []; }
  push(item) { return new Promise((resolve, reject) => { this.pending.push({ item, resolve, reject }); this.#drain(); }); }
  #drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift(); this.active++;
      Promise.resolve(this.handler(job.item)).then(job.resolve, job.reject).finally(() => { this.active--; this.#drain(); });
    }
  }
  get size() { return this.pending.length; }
}

/** Build arguments for the Prime Agent 0.7 CLI. These are all public,
 * documented options; the per-thread session directory is the isolation
 * boundary and --no-extensions/--no-skills prevent host resource leakage. */
export function buildPrimeRunnerArgs({ cwd, sessionDir, resumed = false, extraArgs = [], prompt }) {
  if (!cwd || !sessionDir) throw new Error("cwd and sessionDir are required");
  const args = ["--print", "--cwd", cwd, "--session-dir", sessionDir, "--no-extensions", "--no-skills", ...extraArgs];
  if (resumed) args.push("--continue");
  args.push("--", prompt);
  return args;
}

function extractAgentText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content.filter(part => part?.type === "text").map(part => String(part.text ?? "")).join("").trim();
      if (text) return text;
    }
  }
  return "";
}

export function buildRpcRunnerArgs({ cwd, sessionDir, extraArgs = [] }) {
  if (!cwd || !sessionDir) throw new Error("cwd and sessionDir are required");
  return ["--mode", "rpc", "--cwd", cwd, "--session-dir", sessionDir, "--no-extensions", "--no-skills", ...extraArgs];
}

/**
 * Keep one RPC process per Slack thread. Besides avoiding session-file races,
 * RPC mode exposes tool_execution_* events so the Slack transport can mirror
 * tool activity while the agent is working.
 */
export function createPrimeRunner({ primeCommand = "prime-agent", cwd, sessionRoot, timeoutMs = 10 * 60_000, extraArgs = [], onEvent = () => {} } = {}) {
  if (!cwd || !sessionRoot) throw new Error("cwd and sessionRoot are required");
  const sessions = new Map();
  let requestCounter = 0;

  function notify(thread, event) {
    Promise.resolve(onEvent(thread, event)).catch(() => {});
  }

  async function createSession(thread) {
    const dir = path.join(sessionRoot, encodeURIComponent(thread));
    await mkdir(dir, { recursive: true });
    const child = spawn(primeCommand, buildRpcRunnerArgs({ cwd, sessionDir: dir, extraArgs }), {
      cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    const state = { child, buffer: "", stderr: "", pending: null, closed: false };
    sessions.set(thread, state);
    const fail = error => {
      if (state.pending) {
        clearTimeout(state.pending.timer);
        state.pending.reject(error);
        state.pending = null;
      }
    };
    child.stdout.on("data", chunk => {
      state.buffer += chunk.toString();
      let newline;
      while ((newline = state.buffer.indexOf("\n")) >= 0) {
        const line = state.buffer.slice(0, newline).replace(/\r$/, "");
        state.buffer = state.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type?.startsWith("tool_execution_") || message.type === "message_update") {
          notify(thread, message);
        }
        if (message.type === "response" && state.pending && message.id === state.pending.id && message.command === "prompt" && !message.success) {
          const error = new Error(message.error || "Prime Agent rejected prompt");
          clearTimeout(state.pending.timer);
          state.pending.reject(error);
          state.pending = null;
        }
        if (message.type === "agent_end" && state.pending) {
          const pending = state.pending;
          state.pending = null;
          clearTimeout(pending.timer);
          pending.resolve(extractAgentText(message.messages));
        }
      }
    });
    child.stderr.on("data", chunk => {
      state.stderr = (state.stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", error => fail(error));
    child.on("close", code => {
      state.closed = true;
      sessions.delete(thread);
      if (code !== 0) fail(new Error(`prime-agent exited ${code}: ${state.stderr.trim().slice(-500)}`));
      else if (state.pending) fail(new Error("prime-agent RPC session closed"));
    });
    return state;
  }

  const run = async function run(thread, prompt) {
    let state = sessions.get(thread);
    if (!state || state.closed) state = await createSession(thread);
    if (state.pending) throw new Error(`Prime session is already busy for ${thread}`);
    const id = `slack-${++requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.child.kill("SIGTERM");
        if (state.pending) {
          state.pending = null;
          reject(new Error("prime-agent timed out"));
        }
      }, timeoutMs);
      state.pending = { id, resolve, reject, timer };
      try {
        state.child.stdin.write(`${JSON.stringify({ id, type: "prompt", message: prompt })}\n`);
      } catch (error) {
        clearTimeout(timer);
        state.pending = null;
        reject(error);
      }
    });
  };
  run.close = async () => {
    const states = [...sessions.values()];
    sessions.clear();
    await Promise.all(states.map(state => new Promise(resolve => {
      if (state.closed) return resolve();
      const done = () => resolve();
      state.child.once("close", done);
      state.child.kill("SIGTERM");
      setTimeout(done, 2_000);
    })));
  };
  return run;
}

function formatGatewayError(error) {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return raw
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-token]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "[redacted-token]")
    .replace(/(?:file:\/\/)?\/(?:Users|home|private|var|tmp)\/[^\s)]+/g, "[local-path]")
    .slice(0, 500);
}

export function createGateway({ botUserId, allowlist, queue, runPrime, post, logger = () => {}, processingReaction, dedupeTtlMs = 5 * 60_000, requireThreadReplies = true }) {
  if (!botUserId || !queue || !runPrime || !post) throw new Error("botUserId, queue, runPrime, and post are required");
  const sessions = new Set();
  const keyTails = new Map();
  const seenEvents = new Map();
  const stats = { received: 0, handled: 0, failed: 0, ignored: 0, ignoredByReason: {}, lastError: null };
  const ignored = reason => {
    stats.ignored++;
    stats.ignoredByReason[reason] = (stats.ignoredByReason[reason] || 0) + 1;
    return { ignored: reason };
  };
  async function onMessage(event) {
    stats.received++;
    if (!event || event.bot_id || event.subtype === "message_changed") return ignored("bot-or-subtype");
    if (!isAllowed(event.user, allowlist)) return ignored("user-not-allowed");
    const now = Date.now();
    for (const [id, timestamp] of seenEvents) if (now - timestamp > dedupeTtlMs) seenEvents.delete(id);
    // Slack can deliver a channel mention through both `message` and
    // `app_mention`; channel+ts identifies the original Slack message across
    // both event types and also absorbs Socket Mode retries.
    const eventId = event.channel && event.ts
      ? `${event.team ?? ""}:${event.channel}:${event.ts}`
      : event.event_id || event.client_msg_id;
    if (eventId && seenEvents.has(eventId)) return ignored("duplicate-event");
    if (eventId) seenEvents.set(eventId, now);
    const key = threadKey(event), mentioned = firstMention(event.text, botUserId);
    if (!sessions.has(key) && !mentioned) return ignored("mention-required");
    if (requireThreadReplies && sessions.has(key) && event.thread_ts && event.thread_ts !== key.split(":").pop()) { /* key is stable; no-op */ }
    if (mentioned) sessions.add(key);
    const prompt = stripMention(event.text || "", botUserId);
    if (!prompt) return ignored("empty-prompt");
    // Serialize turns within one Slack thread. The Prime session file is
    // single-writer, while different threads may still use global concurrency.
    const previous = keyTails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => queue.push({ key, prompt }));
    keyTails.set(key, current);
    const updateProcessingReaction = async active => {
      if (!processingReaction || !event.ts) return;
      try {
        await processingReaction({ channel: event.channel, timestamp: event.ts, active });
      } catch (error) {
        logger(`processing reaction ${active ? "add" : "remove"} failed: ${formatGatewayError(error)}`);
      }
    };
    await updateProcessingReaction(true);
    try {
      const result = await current;
      try {
        await post({ channel: event.channel, thread_ts: event.thread_ts || event.ts, text: result || "(Prime Agent returned no text.)" });
        stats.handled++;
        return { handled: true, key };
      } catch (error) {
        const detail = formatGatewayError(error);
        stats.failed++;
        stats.lastError = detail;
        logger(`gateway reply failed: ${detail}`);
        return { failed: true, key, error: detail };
      }
    } catch (error) {
      const detail = formatGatewayError(error);
      stats.failed++;
      stats.lastError = detail;
      try {
        await post({
          channel: event.channel,
          thread_ts: event.thread_ts || event.ts,
          text: `⚠️ Prime Agent failed: ${detail}\nPlease retry this message.`,
        });
      } catch (postError) {
        logger(`gateway error reply failed: ${formatGatewayError(postError)}`);
      }
      return { failed: true, key, error: detail };
    } finally {
      await updateProcessingReaction(false);
      if (keyTails.get(key) === current) keyTails.delete(key);
    }
  }
  return {
    onMessage,
    sessions,
    status: () => ({ ...stats, admittedThreads: sessions.size, activeThreads: keyTails.size, queueActive: queue.active, queuePending: queue.size }),
  };
}

export function registerSocketEventHandlers(socket, gateway, logger = () => {}) {
  const dispatch = async ({ event, ack }) => {
    await ack();
    // SocketModeClient emits the Slack event type directly (not an `events_api`
    // envelope): channel/DM messages use `message`, mentions use `app_mention`.
    if (event?.type !== "message" && event?.type !== "app_mention") return;
    try {
      await gateway.onMessage(event);
    } catch (error) {
      logger(`gateway error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  socket.on("message", dispatch);
  socket.on("app_mention", dispatch);
  return dispatch;
}

export async function startSocketGateway(options = {}) {
  const config = options.config || await loadGatewayConfig({ configPath: options.configPath });
  const appToken = options.appToken ?? config.appToken;
  const botToken = options.botToken ?? config.botToken;
  const allowedUsers = options.allowedUsers ?? config.allowedUsers;
  if (!appToken || !botToken) throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required");
  const [{ SocketModeClient }, { WebClient }] = await Promise.all([import("@slack/socket-mode"), import("@slack/web-api")]);
  const socket = new SocketModeClient({ appToken });
  const web = new WebClient(botToken);
  const auth = await web.auth.test();
  const cwd = options.cwd || config.cwd || process.cwd();
  const sessionRoot = options.sessionRoot || config.sessionRoot || path.join(process.env.PRIME_AGENT_HOME || process.env.HOME || cwd, ".prime", "slack-sessions");
  const toolMessages = new Map();
  const toolTails = new Map();
  const mirrorToolEvent = (thread, event) => {
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
    const parts = String(thread).split(":");
    const channel = parts[1];
    const threadTs = parts.slice(2).join(":");
    if (!channel || !threadTs || !event.toolCallId) return;
    const key = `${thread}:${event.toolCallId}`;
    const toolName = String(event.toolName || "tool");
    const previous = toolTails.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (event.type === "tool_execution_start") {
        const result = await web.chat.postMessage({ channel, thread_ts: threadTs, text: `🔧 Tool started: \`${toolName}\`` });
        if (result.ts) toolMessages.set(key, result.ts);
        return;
      }
      const toolTs = toolMessages.get(key);
      const failed = Boolean(event.isError);
      const text = `${failed ? "❌" : "✅"} Tool ${failed ? "failed" : "finished"}: \`${toolName}\``;
      if (toolTs) {
        await web.chat.update({ channel, ts: toolTs, text });
        toolMessages.delete(key);
      } else {
        await web.chat.postMessage({ channel, thread_ts: threadTs, text });
      }
    });
    toolTails.set(key, current);
    return current.finally(() => {
      if (toolTails.get(key) === current) toolTails.delete(key);
    });
  };

  const runPrime = options.runPrime || createPrimeRunner({ cwd, sessionRoot, onEvent: mirrorToolEvent });
  const queue = options.queue || new ThreadQueue({ concurrency: options.concurrency ?? config.concurrency ?? 4, handler: ({ key, prompt }) => runPrime(key, prompt) });
  const gateway = createGateway({
    ...options,
    botUserId: options.botUserId || auth.user_id,
    allowlist: parseAllowlist(allowedUsers),
    queue,
    post: message => web.chat.postMessage(message),
    runPrime,
    processingReaction: ({ channel, timestamp, active }) =>
      web.reactions[active ? "add" : "remove"]({
        channel,
        timestamp,
        name: "hourglass_flowing_sand",
      }),
  });
  registerSocketEventHandlers(socket, gateway, options.logger);
  await socket.start();
  return {
    socket,
    gateway,
    stop: async () => {
      try { await socket.disconnect(); } finally {
        toolMessages.clear();
        toolTails.clear();
        await runPrime.close?.();
      }
    },
    status: () => ({ connected: Boolean(socket.websocket), botUserId: auth.user_id, allowedUsers: parseAllowlist(allowedUsers)?.size ?? "all", ...gateway.status() }),
  };
}
