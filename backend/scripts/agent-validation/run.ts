/** Opt-in real dsh/model evaluation. Never invoked by ordinary CI. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixture } from './fixture.js';

const required = [
  'DSH_BIN',
  'DSH_MODULES',
  'DSH_MODEL_PROVIDER',
  'DSH_MODEL_ID',
  'DSH_MODEL_BASE_URL',
  'DSH_MODEL_KEY_ENV',
  'AGENT_VALIDATION_OUTPUT',
];
for (const name of required)
  if (!process.env[name])
    throw new Error(`Set ${name}; this script does not provision credentials`);
const keyName = process.env.DSH_MODEL_KEY_ENV!;
if (!/^[A-Z][A-Z0-9_]*$/.test(keyName) || !process.env[keyName])
  throw new Error('Existing model credential variable is missing');
const output = resolve(process.env.AGENT_VALIDATION_OUTPUT!);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'knot-dsh-evaluation-'));
const secrets = Object.entries(process.env)
  .filter(([name, value]) => /key|token|password|secret/i.test(name) && value && value.length > 7)
  .map(([, value]) => value!);
function redact(value: string) {
  for (const secret of secrets) value = value.replaceAll(secret, '[REDACTED]');
  return value
    .replaceAll(directory, '<temporary-agent-directory>')
    .replace(/Bearer [A-Za-z0-9._~+/-]+/g, 'Bearer [REDACTED]');
}
const fixture = await startFixture();
const evidence: Record<string, unknown> = {
  model: { provider: process.env.DSH_MODEL_PROVIDER, id: process.env.DSH_MODEL_ID },
  startedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(
    await Promise.all(
      ['group-service.ts', 'mcp-handler-factory.ts'].map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(root, 'backend/src/api/mcp', file)))
          .digest('hex'),
      ]),
    ),
  ),
  protocol: 'real dsh → loopback production Group router → controlled HTTP MCP upstreams',
  pinnedRevision: fixture.first.revision,
  candidateRevision: fixture.second.revision,
  cases: [],
};
const cases = evidence.cases as Record<string, unknown>[];
async function run(
  name: string,
  endpoints: string[],
  prompt: string,
  kind: 'smoke' | 'natural' | 'shortage' | 'control' | 'instructed',
) {
  const home = join(directory, name);
  const profile = join(home, 'profiles', 'evaluation');
  const cwd = join(home, 'work');
  await mkdir(profile, { recursive: true });
  await mkdir(cwd);
  await symlink(process.env.DSH_MODULES!, join(profile, 'node_modules'), 'dir');
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'temporary-agent-evaluation',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }),
  );
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const provider = JSON.stringify(process.env.DSH_MODEL_PROVIDER);
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    `- id: llm-pi-ai\n  config:\n    providers:\n      ${provider}:\n        apiKeyEnv: ${keyName}\n        baseURL: ${JSON.stringify(process.env.DSH_MODEL_BASE_URL)}\n- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${JSON.stringify(process.env.DSH_MODEL_ID)}\n- insert:\n${endpoints.map((url, index) => `    - id: validation-${index}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: source${index}\n        transport: streamable-http\n        url: ${JSON.stringify(url)}\n        toolCallTimeoutMs: 10000\n        failOnStartupError: true\n`).join('')}`,
  );
  const callsStart = fixture.calls.length;
  const requestsStart = fixture.requests.length;
  const started = performance.now();
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }>((resolveResult, reject) => {
    const child = spawn(process.env.DSH_BIN!, ['--profile', 'evaluation', '--json', prompt], {
      cwd,
      env: { ...process.env, DSH_HOME: home, XDG_STATE_HOME: join(home, 'state') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 180000);
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ stdout, stderr, code, timedOut });
    });
  });
  const events = result.stdout.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const selectedTools = events
    .filter((event) => event.type === 'tool_call')
    .map((event) => event.tool as string);
  const final = events.findLast((event) => event.type === 'final')?.text ?? '';
  const calls = fixture.calls.slice(callsStart);
  const requests = fixture.requests.slice(requestsStart);
  const policyRead = requests.some(
    (request) =>
      request.method === 'resources/read' &&
      JSON.stringify(request.params).includes('/fulfillment-policy/SKILL.md'),
  );
  const bothStock = ['alpha', 'beta'].every((server) =>
    calls.some(
      (call) =>
        call.server === server &&
        call.tool === 'stock' &&
        (call.args as { sku?: string }).sku === 'PENCIL-7',
    ),
  );
  const toolError = events.some(
    (event) =>
      event.type === 'tool_result' &&
      event.status === 'error' &&
      String(event.result).includes('CONTROLLED_ERROR:alpha'),
  );
  const checks =
    kind === 'smoke'
      ? {
          echoExecuted: calls.some((call) => call.tool === 'echo'),
          errorObserved: toolError,
          result42: final.includes('42'),
        }
      : {
          bothWarehousesQueried: bothStock,
          publishedPolicyRead: policyRead,
          policyOutput:
            kind === 'natural' || kind === 'instructed'
              ? /West/i.test(final) && /ECONOMY/i.test(final)
              : kind === 'shortage'
                ? /shortage|insufficient|neither|cannot fulfill|cannot be fulfilled/i.test(final)
                : false,
        };
  const unexpectedTools = selectedTools.filter(
    (tool) =>
      !/^(mcp__source\d__|list_mcp_resources$|list_mcp_resource_templates$|read_mcp_resource$)/.test(
        tool,
      ),
  );
  const passed =
    result.code === 0 &&
    !result.timedOut &&
    unexpectedTools.length === 0 &&
    Object.values(checks).every(Boolean);
  // Only approved synthetic evidence is persisted, never the raw session or environment.
  cases.push({
    name,
    kind,
    prompt,
    elapsedSeconds: Math.round((performance.now() - started) / 10) / 100,
    exitCode: result.code,
    timedOut: result.timedOut,
    selectedTools,
    backendCalls: calls,
    resourceMethods: requests
      .filter((request) => /^(resources\/|skills\/)/.test(request.method))
      .map((request) => request.method),
    checks,
    unexpectedTools,
    passed,
    final: redact(final),
    diagnostic: result.code !== 0 ? redact(result.stderr).slice(0, 500) : undefined,
  });
  await writeFile(output, redact(JSON.stringify(evidence, null, 2)) + '\n');
  console.log(
    JSON.stringify({ case: name, passed, checks, elapsedSeconds: cases.at(-1)!.elapsedSeconds }),
  );
}
try {
  await mkdir(dirname(output), { recursive: true });
  if (!process.argv.includes('--instructed-only')) {
    const smoke =
      'Use the available MCP echo tool once with message="route-check", a=17, b=25. Then use its fail tool once. Report the actual result and error. Do not retry or use other tools.';
    await run('smoke-direct', [fixture.urls.alpha], smoke, 'smoke');
    await run('smoke-knot', [`${fixture.baseUrl}/alpha/mcp`], smoke, 'smoke');
    const goal =
      'Recommend a single warehouse to fulfill an order for 7 units of PENCIL-7 under our currently published fulfillment rules. Explain the inventory basis and shipping service class. Do not reserve stock or send a shipment.';
    for (let trial = 1; trial <= 3; trial++)
      await run(`natural-${trial}`, [`${fixture.baseUrl}/fulfillment/mcp`], goal, 'natural');
    await run(
      'natural-shortage',
      [`${fixture.baseUrl}/fulfillment/mcp`],
      goal.replace('7 units', '20 units'),
      'shortage',
    );
    await run(
      'direct-without-policy-control',
      [fixture.urls.alpha, fixture.urls.beta],
      goal,
      'control',
    );
  }
  await run(
    'instructed-skill-control',
    [`${fixture.baseUrl}/fulfillment/mcp`],
    'Find and read the fulfillment-policy skill through MCP resources, then apply it to recommend one warehouse for 7 units of PENCIL-7. Cite both live stock counts and the service class. Do not reserve stock or ship.',
    'instructed',
  );
  evidence.finishedAt = new Date().toISOString();
  evidence.acceptanceNote =
    'Natural positive gates require both live stock calls, actual policy resource read, and West/ECONOMY in final; human review must confirm West is recommended rather than merely mentioned. Control intentionally lacks the policy and is not a positive gate. Small sample, not a reliability estimate.';
  await writeFile(output, redact(JSON.stringify(evidence, null, 2)) + '\n');
  if (cases.some((entry) => entry.kind !== 'control' && !entry.passed)) process.exitCode = 1;
} finally {
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
