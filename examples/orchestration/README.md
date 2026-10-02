# Orchestration examples (Conductor OSS)

Run ai-sdk-letta agents from [Conductor OSS](https://conductor-oss.org)
workflows. For n8n, see [`packages/n8n-nodes-ai-sdk-letta`](../../packages/n8n-nodes-ai-sdk-letta).
Background and the API: README, "Automations (n8n, Conductor)".

## Set up

1. Start the server with the automation API (`npm run gui -- --automation-port 4402`)
   and create a token for Conductor (Automations → New token, used by
   Conductor).
2. Start Conductor with the token as a secret (Conductor OSS reads secrets
   from its environment, prefix `CONDUCTOR_SECRET_`):

   ```sh
   docker run -d --name conductor -p 127.0.0.1:8080:8080 \
     -e CONDUCTOR_SECRET_AI_SDK_LETTA_TOKEN='lta_…' conductoross/conductor:3.32.5
   ```

3. Register the definitions: `CONDUCTOR_URL=http://127.0.0.1:8080 npm run register --workspace @ai-sdk-letta/example-orchestration`.

## Workflows

- **`ai_sdk_letta_run_turn`** ([JSON](conductor/ai_sdk_letta_run_turn.json)):
  no worker. An `HTTP` task starts the turn (the workflow ID is the
  idempotency key, so Conductor's retries never start a second turn) and
  waits up to 110 s; a `DO_WHILE` asks again (each request held up to 110 s)
  until the run ended; a `SWITCH` fails the workflow with
  `approval_required: …` (or any other code) when the turn did not complete.
  Input: `serverUrl` (`http://host.docker.internal:4402` from Docker),
  `text`, `title`. Output: `reply`, `conversation`, `tools`, `files`.
- **`ai_sdk_letta_run_turn_worker`** ([JSON](conductor/ai_sdk_letta_run_turn_worker.json)):
  one `ai_sdk_letta_turn` task, done by the worker in
  [`src/conductor-worker.ts`](src/conductor-worker.ts) (Conductor's JavaScript
  SDK). The worker waits in steps of 25 s and hands the task back
  `IN_PROGRESS` in between, so long turns hold no thread and the worker can
  restart. A turn that needed a person fails the task for good
  (`FAILED_WITH_TERMINAL_ERROR`); rate limits fail it for a retry.

  ```sh
  CONDUCTOR_SERVER_URL=http://127.0.0.1:8080/api AI_SDK_LETTA_URL=http://127.0.0.1:4402 AI_SDK_LETTA_TOKEN='lta_…' \
    npm run worker --workspace @ai-sdk-letta/example-orchestration
  ```

## Schedules

[`conductor/weekday-report.schedule.json`](conductor/weekday-report.schedule.json)
runs `ai_sdk_letta_run_turn` every weekday at 07:00 UTC:

```sh
curl -X POST http://127.0.0.1:8080/api/scheduler/schedules -H 'Content-Type: application/json' \
  --data-binary @examples/orchestration/conductor/weekday-report.schedule.json
```

Agent self-scheduling (`schedule_task`) with Conductor needs only
`automation: { scheduler: { kind: 'conductor', url, callbackUrl } }` on the
server: it registers its own small workflow (`ai_sdk_letta_fire_task`) and
creates one schedule per task.

Tested with `conductoross/conductor:3.32.5` (SQLite, scheduler on by default)
and `@io-orkes/conductor-javascript` 4.0.0.
