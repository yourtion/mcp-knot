# Real agent regression and natural-use evaluation

This fixture serves two real loopback HTTP MCP backends through the production
`McpKnotService`, upstream connection manager and Group router. It does not mock
MCP, the model or agent. It intentionally excludes the admin UI/auth API and
full production startup. No server is exposed beyond loopback.

## Deterministic CI regression

From the repository root, after installing dependencies and building the shared,
protocol and core packages:

```sh
pnpm exec vitest run --project api-unit backend/src/api/mcp/agent-regression.integration.test.ts
```

The test is included by the existing API test project and ordinary CI. It needs
no model credentials. The original main (`ac2a153`) fails both the description
and mixed-era tests; the fixed implementation passes all four tests:

- Preserve descriptions and execution results, including two upstreams named
  `echo` and `isError` propagation.
- Run legacy → modern → legacy on one Group, then six concurrent mixed clients.
- Reject cross-Group tools/files; import V1, sync V2, and verify the Group still
  serves V1 through skills/list, skills/get and resources/read, including hashes.
- Stop one actual upstream listener, observe its failed call and successfully
  call the other upstream.

Ports and configuration directories are allocated per fixture and cleaned up.
Only production server/handler state is exercised; no copied route or protocol
implementation substitutes for the code under test.

## Explicit real-model run

Use an **already installed and authenticated** dsh. This script neither installs
an agent nor creates authorization. Supply paths and non-secret model settings
via environment variables; `DSH_MODEL_KEY_ENV` names an existing injected
credential variable, not its value. Do not put a key in the command or a file.

```sh
export DSH_BIN=/absolute/path/to/existing/dsh
export DSH_MODULES=/absolute/path/to/its/node_modules
export DSH_MODEL_PROVIDER=your-existing-provider
export DSH_MODEL_ID=your-existing-model
export DSH_MODEL_BASE_URL=https://your-existing-provider.example/v1
export DSH_MODEL_KEY_ENV=EXISTING_MODEL_KEY_VARIABLE
export AGENT_VALIDATION_OUTPUT=/absolute/path/outside/repo/agent-evidence.json
# Keep the environment's existing proxy and CA configuration, if required.
pnpm exec tsx backend/scripts/agent-validation/run.ts
```

Run from the repository root (GroupMcpService currently reads package.json from
cwd). The script creates an isolated temporary dsh profile and empty workspace,
references the existing key by variable name, then removes both. No raw session,
credential, profile or environment dump is written to the evidence output.
Only synthetic prompts, selected tool names, fixture calls, projected final
answers and acceptance results are retained. Review this output before sharing.
It is never run by CI. `--instructed-only` runs just the explicit skill-reading
control, useful without repeating the model suite.

### Cases and acceptance (specified before evaluation)

1. Direct and Knot smoke: one explicit echo (17 + 25) and one deliberate error;
   observe actual upstream execution and model-visible error/result.
2. Three independent fresh sessions receive this **unchanged business goal**:

   > Recommend a single warehouse to fulfill an order for 7 units of PENCIL-7
   > under our currently published fulfillment rules. Explain the inventory
   > basis and shipping service class. Do not reserve stock or send a shipment.

   No tool name, routing prefix, skill name, hidden answer or call order is in
   this prompt. East has 12 and West 9. The pinned policy requires reading both,
   selecting West when both qualify, and using ECONOMY service; the newer source
   prefers East and remains unpublished. Acceptance requires both stock calls,
   an actual read of the published policy, and correct application. The automated
   text check is preliminary (West could merely be mentioned); a human must
   confirm the recommendation and reasoning.

3. Replace only `7 units` with `20 units`: both warehouses are insufficient;
   require reading/applying the single-warehouse rule and reporting shortage.
4. Same business goal with direct backend connections but **no policy source**:
   a negative control, not a positive acceptance gate. Review whether the agent
   admits missing rules rather than claiming an authoritative recommendation.
5. Explicitly request the skill/resource in a separate instructed control; this
   is **not** a natural-use success and cannot improve the natural success count.

The conservative overall gate also rejects unexpected non-MCP tools, even
read-only local search. Such a failure must be distinguished from business
correctness. Failed positive cases make the command exit nonzero; they are not
retried, skipped or reclassified as successful. The no-policy control is
reported separately and does not determine the exit code.

## Observed results: 2026-10-21

Existing dsh 0.1.7-rc.2, `zai-coding-cn/glm-5.3-flash`, Node 24.19.0.
The committed `evidence-2026-10-21.json` contains reviewed synthetic projections,
not full original logs or environment configuration.

| Case                             | Observation                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit direct / Knot smoke     | Both passed; correct sum and controlled error. 20.00 / 24.34 seconds respectively, one sample each.                                                                                                                                                     |
| Natural 7-unit order, 3 sessions | All queried both stocks but none read the policy. All recommended East and standard ground, violating the pinned rule. Two also searched the empty local workspace. One disclosed a missing rulebook; the others presented invented rules as published. |
| Natural 20-unit shortage         | Read the published policy and correctly rejected single-warehouse fulfillment, citing 12/9 and ECONOMY. An extra local glob made the conservative overall gate fail.                                                                                    |
| Direct without policy            | Queried stocks, recommended East/standard ground and disclosed that the rulebook was unavailable. No policy-backed success claimed by this evaluation.                                                                                                  |
| Instructed skill control         | Passed: read the MCP policy, checked both warehouses, selected West/ECONOMY despite the newer source preferring East. 24.16 seconds.                                                                                                                    |

The first run intentionally exited 1 because of natural-use failures. The
separate instructed-only control exited 0. These are small observations, not
statistical reliability or latency claims. MCP resources consumption worked;
native Skills-extension activation is not demonstrated. No policy/UI changes
were added to coerce natural-use success.

## Fix scope and root cause

- Dynamic tool registration passed only inputSchema; it now also forwards the
  upstream description.
- The HTTP factory returned the cached McpServer. SDK 2.0.0 marks that instance's
  negotiated protocol modern (`setNegotiatedProtocolVersion`), and its inbound
  codec gate rejects legacy-only `initialize` with -32601 on subsequent reuse.
  It also owns client identity, transport and close lifecycle. The factory now
  returns a fresh request server using the same upstream manager and MRTR relay.
  Group handler/event bus caches and upstream connections remain shared.

The request server rebuilds registrations and reads configuration/pinned skill
snapshots; it does not open new upstream connections. Extra registration/read
cost is a tradeoff, not benchmarked at scale. Existing subscription fan-out still
uses the cached handler's notifier. Full-suite coverage and the new mixed-client
regression passed; this is not a load test.

This branch is based directly on main `ac2a153`, independent of draft PR #11. It
changes no dependencies, shared test infrastructure, CI or mutation configuration.
No merge of #11 or long-running mutation run is required.
