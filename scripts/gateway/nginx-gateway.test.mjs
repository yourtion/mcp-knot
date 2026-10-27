import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import policy from '../../examples/nginx-gateway/policy.mjs';
import { startOAuthHub } from './oauth-hub.mjs';

const { allowsRequest } = policy;

const root = fileURLToPath(new URL('../../', import.meta.url));
const image =
  'nginx:stable@sha256:a7675fcee220f59b4a99f7098c06a0d5d999c2c0ee37c0211efb780536e5cb20';
const dockerEnv = { ...process.env };
for (const key of [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
]) {
  delete dockerEnv[key];
}
function docker(args, options = {}) {
  return execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8',
    env: dockerEnv,
    timeout: 180_000,
    ...options,
  });
}

test('gateway policy validates actual headers and distinguishes absent from invalid Origin', () => {
  const origin = 'https://mcp.example.test';
  const host = [['Host', 'mcp.example.test']];
  for (const headers of [host, [...host, ['Origin', origin]], [['Host', 'MCP.EXAMPLE.TEST:443']]]) {
    assert(allowsRequest(headers, origin));
  }
  for (const headers of [
    [],
    [['Host', 'evil.example']],
    [['Host', 'mcp.example.test.evil.example']],
    [...host, ['Host', 'evil.example']],
    ...[
      '',
      'null',
      'http://mcp.example.test',
      'https://evil.example',
      origin + '/',
      origin + ':444',
    ].map((value) => [...host, ['Origin', value]]),
    [...host, ['Origin', origin], ['Origin', origin]],
    [...host, ['Origin', 'https://evil.example'], ['X-Forwarded-Origin', origin]],
    [
      ['Host', 'evil.example'],
      ['X-Forwarded-Host', 'mcp.example.test'],
    ],
  ]) {
    assert(!allowsRequest(headers, origin), JSON.stringify(headers));
  }
  for (const config of [
    undefined,
    '',
    'http://mcp.example.test',
    origin + '/',
    origin + '/mcp',
    origin + ':443',
    origin + ':0',
    origin + ':65536',
    'https://user@mcp.example.test',
  ]) {
    assert(!allowsRequest(host, config));
  }
  assert(allowsRequest([['Host', 'mcp.example.test:8443']], origin + ':8443'));
  assert(!allowsRequest(host, origin + ':8443'));
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

test(
  'real Nginx TLS entry, private upstream topology and Hub conformance',
  { timeout: 600_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-knot-gateway-'));
    const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
    const network = `mcp-knot-gateway-${suffix}`;
    const upstream = `${network}-upstream`;
    const gateway = `${network}-entry`;
    const port = await availablePort();
    const publicOrigin = `https://localhost:${port}`;
    const host = `localhost:${port}`;
    const artifacts = join(root, '.conformance-gateway-results');
    let networkCreated = false;
    const containers = new Set();
    const startGateway = (hostUpstream = false) => {
      const args = [
        'run',
        '-d',
        '--name',
        gateway,
        '--network',
        network,
        '-p',
        `127.0.0.1:${port}:443`,
        '-e',
        `MCP_PUBLIC_ORIGIN=${publicOrigin}`,
        '-v',
        `${root}/examples/nginx-gateway/nginx.conf:/etc/nginx/nginx.conf:ro`,
        '-v',
        `${root}/examples/nginx-gateway/policy.mjs:/etc/nginx/mcp/policy.mjs:ro`,
        '-v',
        `${directory}:/etc/nginx/tls:ro`,
      ];
      if (hostUpstream)
        args.push(
          '--add-host',
          'mcp-knot-api:host-gateway',
          '--add-host',
          'mcp-knot-web:host-gateway',
        );
      args.push('--entrypoint', 'nginx', image, '-g', 'daemon off;');
      containers.add(gateway);
      docker(args);
    };
    try {
      try {
        docker(['image', 'inspect', image]);
      } catch {
        docker(['pull', image]);
      }
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost',
          '-keyout',
          join(directory, 'tls.key'),
          '-out',
          join(directory, 'tls.crt'),
        ],
        { stdio: 'ignore' },
      );
      const certificate = await readFile(join(directory, 'tls.crt'));
      const inheritedTrust = process.env.NODE_EXTRA_CA_CERTS
        ? await readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8')
        : '';
      await writeFile(
        join(directory, 'trust.pem'),
        inheritedTrust + '\n' + certificate.toString('utf8'),
      );
      const send = (headers = {}, authorized = true, options = {}) =>
        new Promise((resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port,
              servername: 'localhost',
              ca: certificate,
              path: options.path ?? '/default/mcp',
              method: options.method ?? 'POST',
              timeout: 5000,
              headers: {
                Host: host,
                ...(authorized ? { Authorization: 'Bearer gateway-test-token' } : {}),
                ...headers,
              },
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () =>
                resolve({ status: response.statusCode, headers: response.headers, body }),
              );
            },
          );
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
          req.end(options.body ?? '{}');
        });
      await writeFile(
        join(directory, 'upstream.conf'),
        `
events {}
http {
  server {
    listen 8181;
    add_header WWW-Authenticate 'Bearer realm="gateway-test"' always;
    location / {
      if ($http_authorization != "Bearer gateway-test-token") { return 401; }
      default_type application/json;
      return 200 '{"host":"$http_host","origin":"$http_origin","forwardedHost":"$http_x_forwarded_host","forwardedProto":"$http_x_forwarded_proto","forwardedFor":"$http_x_forwarded_for","forwarded":"$http_forwarded"}';
    }
  }
  server { listen 80; return 200 'web'; }
}`,
      );
      docker(['network', 'create', network]);
      networkCreated = true;
      docker([
        'run',
        '-d',
        '--name',
        upstream,
        '--network',
        network,
        '--network-alias',
        'mcp-knot-api',
        '--network-alias',
        'mcp-knot-web',
        '-v',
        `${directory}/upstream.conf:/etc/nginx/nginx.conf:ro`,
        '--entrypoint',
        'nginx',
        image,
        '-g',
        'daemon off;',
      ]);
      containers.add(upstream);
      startGateway();
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          if ((await send()).status === 200) {
            ready = true;
            break;
          }
        } catch {
          /* Starting. */
        }
        await delay(100);
      }
      if (!ready)
        assert.fail(`Nginx did not become ready: ${docker(['logs', gateway]).slice(-3000)}`);

      await t.test(
        'merged Compose publishes only the TLS gateway; neither API nor Web bypass it',
        () => {
          const config = JSON.parse(
            docker(
              [
                'compose',
                '-f',
                join(root, 'docker-compose.release.yml'),
                '-f',
                join(root, 'examples/nginx-gateway/compose.yaml'),
                'config',
                '--format',
                'json',
              ],
              {
                env: {
                  ...dockerEnv,
                  MCP_KNOT_VERSION: 'v0.1.1',
                  MCP_KNOT_CONFIG_DIR: directory,
                  MCP_KNOT_TLS_DIR: directory,
                  MCP_PUBLIC_ORIGIN: publicOrigin,
                },
              },
            ),
          );
          assert.equal(config.services['mcp-knot-api'].ports?.length ?? 0, 0);
          assert.equal(config.services['mcp-knot-web'].ports?.length ?? 0, 0);
          assert.deepEqual(
            config.services['mcp-knot-gateway'].ports.map((p) => [p.target, p.published]),
            [[443, '443']],
          );
          assert.equal(config.services['mcp-knot-gateway'].image, image);
          assert.equal(docker(['port', upstream]).trim(), '');
        },
      );
      await t.test(
        'HTTPS same-origin requests and authenticated clients without Origin work',
        async () => {
          assert.equal((await send()).status, 200);
          assert.equal((await send({ Origin: publicOrigin })).status, 200);
          const response = await send({}, false);
          assert.equal(response.status, 401);
          assert.match(response.headers['www-authenticate'], /^Bearer /);
        },
      );
      for (const [name, headers] of [
        ['evil Host', { Host: 'evil.example' }],
        ['evil Origin', { Origin: 'https://evil.example' }],
        ['null Origin', { Origin: 'null' }],
        ['empty Origin', { Origin: '' }],
        ['duplicate Origin', { Origin: [publicOrigin, publicOrigin] }],
        ['HTTP Origin at HTTPS entry', { Origin: `http://${host}` }],
        ['spoofed forwarded Host', { Host: 'evil.example', 'X-Forwarded-Host': host }],
        [
          'spoofed forwarded Origin',
          { Origin: 'https://evil.example', 'X-Forwarded-Origin': publicOrigin },
        ],
      ]) {
        await t.test(`returns 403 for ${name}`, async () =>
          assert.equal((await send(headers)).status, 403),
        );
      }
      await t.test(
        'overwrites untrusted forwarding metadata while preserving actual Origin and authorization',
        async () => {
          const response = await send({
            Origin: publicOrigin,
            'X-Forwarded-Host': 'evil.example',
            'X-Forwarded-Proto': 'http',
            'X-Forwarded-For': '203.0.113.66',
            Forwarded: 'host=evil.example;proto=http',
          });
          assert.equal(response.status, 200);
          const body = JSON.parse(response.body);
          assert.equal(body.host, host);
          assert.equal(body.origin, publicOrigin);
          assert.equal(body.forwardedHost, host);
          assert.equal(body.forwardedProto, 'https');
          assert.notEqual(body.forwardedFor, '203.0.113.66');
          assert.equal(body.forwarded, '');
        },
      );

      // This second profile uses the actual isolated Hub, not the auth mock.
      // Host-gateway routing is confined to the test container. The deployment
      // Compose topology above deliberately publishes neither backend entry.
      docker(['rm', '-f', gateway]);
      containers.delete(gateway);
      startGateway(true);
      await t.test(
        'official TCK runs against the real Hub through verified TLS, with honest residual failures',
        async () => {
          const log = openSync(join(directory, 'conformance.log'), 'w');
          try {
            execFileSync('bash', [join(root, 'scripts/conformance/run.sh')], {
              cwd: root,
              timeout: 240_000,
              stdio: ['ignore', log, log],
              env: {
                ...process.env,
                CONFORMANCE_URL: `${publicOrigin}/default/mcp`,
                NODE_EXTRA_CA_CERTS: join(directory, 'trust.pem'),
                OUT_DIR: artifacts,
              },
            });
          } finally {
            closeSync(log);
            process.stdout.write(await readFile(join(directory, 'conformance.log'), 'utf8'));
          }
          const summary = JSON.parse(await readFile(join(artifacts, 'summary.json'), 'utf8'));
          const target = JSON.parse(await readFile(join(artifacts, 'target.json'), 'utf8'));
          assert.equal(target.profile, 'gateway');
          assert.equal(target.testedUrl, `${publicOrigin}/default/mcp`);
          for (const name of [
            'simple-text',
            'image',
            'audio',
            'embedded-resource',
            'mixed-content',
            'error',
          ]) {
            assert.equal(
              summary.scenarios.find((s) => s.name === `tools-call-${name}`).status,
              'passed',
            );
          }
          const dns = summary.scenarios.find((s) => s.name === 'dns-rebinding-protection');
          const rejectedHost = dns.checks.find((c) => c.id === 'localhost-host-rebinding-rejected');
          assert.equal(rejectedHost.status, 'FAILURE');
          assert.match(rejectedHost.errorMessage, /does not match certificate's altnames/);
          assert.equal(rejectedHost.details.hostHeader, 'evil.example.com');
          // This fixed localhost-only TCK verifies TLS against its forged Host
          // (certificate mismatch) and emits an HTTP Origin for an HTTPS URL.
          // Preserve both failures; the TLS tests above use the real endpoint's
          // SNI/identity and separately require HTTP 403 for malicious headers.
          assert.equal(
            dns.checks.find((c) => c.id === 'localhost-host-valid-accepted').details.statusCode,
            403,
          );
          assert.equal(dns.status, 'failed');
          console.log(
            `Gateway TCK actual: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.warnings} warning-only; not full conformance.`,
          );
        },
      );
      await t.test(
        'real Hub requires OAuth for no-Origin clients through the TLS gateway',
        async () => {
          const hub = await startOAuthHub(root, directory, publicOrigin);
          try {
            const missing = await send({}, false);
            assert.equal(missing.status, 401);
            assert.match(missing.headers['www-authenticate'], /resource_metadata=/);
            assert(
              missing.headers['www-authenticate'].includes(
                `${publicOrigin}/.well-known/oauth-protected-resource`,
              ),
            );
            assert.equal(
              (await send({ Authorization: 'Bearer invalid-token' }, false)).status,
              401,
            );
            const token = await send(
              { 'Content-Type': 'application/x-www-form-urlencoded' },
              false,
              {
                path: '/api/oauth/token',
                body: new URLSearchParams({
                  grant_type: 'client_credentials',
                  client_id: hub.clientId,
                  client_secret: hub.clientSecret,
                  scope: 'mcp:tools',
                  resource: publicOrigin,
                }).toString(),
              },
            );
            assert.equal(token.status, 200);
            const accessToken = JSON.parse(token.body).access_token;
            assert.equal(typeof accessToken, 'string');
            const headers = {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2025-11-25',
            };
            const body = JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'gateway-oauth-client', version: '1' },
              },
            });
            const allowed = await send(headers, false, { body });
            assert.equal(allowed.status, 200);
            const message = allowed.headers['content-type'].startsWith('text/event-stream')
              ? allowed.body
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => JSON.parse(line.slice(5)))
                  .find((value) => value.id === 1)
              : JSON.parse(allowed.body);
            assert.equal(message.id, 1);
            assert(message.result.serverInfo);
            assert.equal(
              (await send({ ...headers, Origin: publicOrigin }, false, { body })).status,
              200,
            );
            assert.equal(
              (await send({ ...headers, Origin: 'https://evil.example' }, false, { body })).status,
              403,
            );
            assert.equal(
              (await send({ ...headers, Host: 'evil.example' }, false, { body })).status,
              403,
            );
            const metadata = await send({}, false, {
              path: '/.well-known/oauth-protected-resource',
              method: 'GET',
              body: '',
            });
            assert.equal(metadata.status, 200);
            assert.equal(JSON.parse(metadata.body).resource, publicOrigin);
          } finally {
            await hub.stop();
          }
        },
      );
    } finally {
      for (const name of containers) {
        try {
          docker(['rm', '-f', name]);
        } catch {
          /* Already stopped. */
        }
      }
      if (networkCreated) {
        try {
          docker(['network', 'rm', network]);
        } catch {
          /* Report original failure. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
