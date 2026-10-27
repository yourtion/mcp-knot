import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Exercise the existing internal AS with isolated configuration and keys.
export async function startOAuthHub(root, directory, publicOrigin) {
  const config = join(directory, 'oauth-config');
  await mkdir(config);
  const clientId = 'gateway-test-client';
  const clientSecret = randomBytes(24).toString('hex');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = join(config, 'signing-key.pem');
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(
    join(config, 'system.json'),
    JSON.stringify({
      server: { port: 8181, host: 'localhost' },
      auth: {
        jwt: {
          secret: randomBytes(32).toString('hex'),
          expiresIn: '1h',
          refreshExpiresIn: '7d',
          issuer: 'gateway-test',
        },
        security: {
          maxLoginAttempts: 5,
          lockoutDuration: 1000,
          passwordMinLength: 12,
          requireStrongPassword: true,
        },
      },
      users: {},
      ui: {
        title: 'Gateway auth test',
        theme: 'light',
        features: { apiToMcp: false, debugging: false, monitoring: false },
      },
      monitoring: { metricsEnabled: false, logLevel: 'error', retentionDays: 1 },
      oauth: {
        mode: 'internal',
        resource: publicOrigin,
        scopes: ['mcp:tools'],
        internal: {
          issuer: publicOrigin,
          tokenTtlSeconds: 60,
          clients: [{ clientId, clientSecret, scopes: ['mcp:tools'] }],
        },
      },
    }),
  );
  await writeFile(
    join(config, 'group.json'),
    JSON.stringify({
      default: {
        id: 'default',
        name: 'gateway-auth-test',
        servers: ['test'],
        tools: [],
      },
    }),
  );
  await writeFile(
    join(config, 'mcp_server.json'),
    JSON.stringify({
      servers: {
        test: {
          type: 'stdio',
          command: process.execPath,
          args: [join(root, 'scripts/conformance/tool-fixtures.mjs'), 'serve'],
          env: {},
          enabled: true,
        },
      },
    }),
  );
  const logPath = join(config, 'hub.log');
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, [join(root, 'backend/dist/index.js')], {
    cwd: join(root, 'backend'),
    env: {
      ...process.env,
      CONFIG_PATH: config,
      OAUTH_INTERNAL_PRIVATE_KEY: key,
      OAUTH_PUBLIC_SCHEME: 'https',
    },
    stdio: ['ignore', log, log],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    closeSync(log);
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch('http://localhost:8181/.well-known/oauth-protected-resource', {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok && (await response.json()).resource === publicOrigin) {
          return { stop, clientId, clientSecret };
        }
      } catch {
        /* Starting. */
      }
      await delay(100);
    }
    throw new Error('OAuth Hub failed to start: ' + (await readFile(logPath, 'utf8')).slice(-3000));
  } catch (error) {
    await stop();
    throw error;
  }
}
