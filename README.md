# Prime Agent Slack Gateway

A small, Prime Agent 0.7-native Slack Socket Mode adapter.

## Features

- Channel `@mention` admission through Slack `app_mention` events.
- DM and known-thread follow-up handling through `message` events.
- Replies stay in the originating Slack thread.
- One persistent Prime Agent RPC session per Slack thread.
- Same-thread turns are serialized; different threads run concurrently.
- Tool activity is mirrored into the Slack thread as start/finish updates.
- Explicit start, status, and stop commands.
- Owner-only config validation (`0600`) and fail-closed user allowlist.
- No Pinet dependency and no second Pi Core dependency.

## Requirements

- Prime Agent 0.7 with extension auto-discovery.
- Node.js 18+ (Node 22 recommended).
- A Slack app with Socket Mode enabled, `chat:write`, and the relevant message event subscriptions (`message.im`, `message.channels`, optionally `message.groups` and `app_mention`).
- Bot and app-level tokens.

## Install as a Prime Agent extension

Copy this repository into the auto-discovered extensions directory:

```bash
mkdir -p ~/.prime/agent/extensions/prime-slack-gateway
cp index.js package.json slack-gateway.schema.json slack-gateway.example.json \
  ~/.prime/agent/extensions/prime-slack-gateway/
cp -R test ~/.prime/agent/extensions/prime-slack-gateway/
cd ~/.prime/agent/extensions/prime-slack-gateway
npm install
```

Create the private config without committing it:

```bash
cp slack-gateway.example.json ~/.prime/agent/slack-gateway.json
chmod 600 ~/.prime/agent/slack-gateway.json
```

Set `botToken`, `appToken`, `allowedUsers`, and `cwd`. An empty or missing allowlist rejects all users; use `"*"` only intentionally.

Start Prime Agent and run:

```text
/slack-gateway start
/slack-gateway status
```

Stop it with:

```text
/slack-gateway stop
```

## Slack app events

The Slack Socket Mode client emits `message` and `app_mention` directly. The adapter handles both. A top-level channel mention creates a new thread root; replies in that thread do not need another mention.

The bot must be invited to the target channel. The allowlist is checked against the Slack sender ID.

## Configuration

See [`slack-gateway.schema.json`](./slack-gateway.schema.json) and [`slack-gateway.example.json`](./slack-gateway.example.json). Supported environment overrides include `PRIME_SLACK_CONFIG`, `PRIME_SLACK_BOT_TOKEN`, `PRIME_SLACK_APP_TOKEN`, `PRIME_SLACK_ALLOWED_USERS`, `PRIME_SLACK_CONCURRENCY`, `PRIME_SLACK_CWD`, and `PRIME_SLACK_SESSION_ROOT`.

Never commit `slack-gateway.json`, tokens, or session directories.

## Development

```bash
npm install
npm test
```

The test suite covers config security, mention admission, direct Socket Mode event dispatch, thread serialization, RPC argument construction, and global concurrency.

## Current limitations

Message edits/deletes, file transfer, durable event-id deduplication, retry/dead-letter persistence, and Slack rate-limit backoff are not implemented. Tool updates intentionally show tool names and status only, not raw arguments, to reduce accidental secret exposure. Runtime failures now produce a safe error reply in the originating Thread, and Gateway shutdown closes the Socket Mode client and per-thread RPC processes.
