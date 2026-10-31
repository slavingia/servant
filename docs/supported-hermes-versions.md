# Hermes compatibility

Servant's repository-owned bridge extends Hermes' real API adapter. It uses native session, run, stop, and approval controls; it does not install or patch Hermes source. The bridge restores typed image history before a run and resolves owner image output before the native API records the run's final output. Members use the restrictions described in [Member agent security](member-security.md).

[`config/hermes-versions.json`](../config/hermes-versions.json) records the exact commits verified locally:

| Endpoint | Hermes release | Commit |
| --- | --- | --- |
| Oldest tested | `v2026.7.7.2` | `9de9c25f620ff7f1ce0fd5457d596052d5159596` |
| Newest tested | `v0.22.5` | `bf0203a794a07aac3ff764972ab9087baa4e4f4e` |

Hermes changed from calendar version tags to `0.x` versions. Do not compare these tags lexicographically. The two exact commits above passed the local native contract suite. Versions between them have not all been individually tested. `v2026.7.1` is rejected because it lacks the validated image resolver needed for the bridge. An unlisted source checkout may work, but must pass the same tests before it is treated as supported.

## What CI checks

[Servant contracts](../.github/workflows/hermes-compatibility.yml) runs on every PR, push to main, manual invocation, and daily schedule. Independent jobs run Servant server and relay tests. The Hermes matrix installs the pinned minimum release and the **current latest stable GitHub release**, then runs the same native contract suite against each. A missing Hermes installation or changed contract fails; these tests never silently skip.

The suite uses actual Hermes HTTP handlers, session storage, member AIAgent construction, and approval queues. Model responses are deterministic test doubles; no model credentials or external model calls are required. It checks:

- Bearer authentication, advertised capabilities, session creation, and message history.
- Structured image input and canonical multimodal history through durable runs.
- Resolved output images in both `run.completed` SSE events and pollable run status.
- Native cancellation, structured run failures, and inactive approval rejection.
- Pending approval recovery without an SSE connection, exact action identifiers, and safe retries that cannot approve a later action.
- Actual member tool and memory isolation, context exclusion, and local-file output rejection.

The bridge accepts only one-time approval or denial. Its `pending_approval` status includes a stable `approval_id`. A response must name that exact action; successful duplicate responses return the earlier receipt. Session-wide and permanent approval are rejected. IDs refer to native queued gates, so two pending actions cannot be confused by the FIFO behavior in older Hermes.

Startup checks required hooks and constructor controls before advertising `servant_durable_media_runs`. This catches missing APIs, while the native suite checks behavior. CI has been added to the repository; local passing results do not claim that a remote GitHub Actions run has already completed, nor do they certify an installed production instance.

## Run the same checks locally

Use the Python environment for the Hermes version you are checking:

```sh
/path/to/hermes/venv/bin/python scripts/test-hermes-compat.py /path/to/hermes
node --test server/member-policy.test.mjs
```

Tests create a temporary `HERMES_HOME`; they do not read or overwrite the live profile. A newer release becomes recorded support only after its matrix job passes and its exact commit is added to the version file. Keep the minimum pinned until a deliberate change removes that support. Compatibility does not promise that provider availability, model behavior, or network connectivity are unchanged.

Primary references: [Hermes releases](https://github.com/NousResearch/hermes-agent/releases), [native run adapter](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/gateway/platforms/api_server_runs.py), and [Coconut's documented compatibility approach](https://github.com/antiwork/coconut/blob/main/docs/supported-hermes-versions.md). Coconut was an architectural reference; no Coconut source was copied.
