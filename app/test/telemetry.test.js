'use strict';

// Starts the app with telemetry.js and the console span exporter, and checks
// that probe requests make no spans while ordinary requests still do.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const appDir = path.join(__dirname, '..');

// server.js logs the port it was given, so pick a free one up front.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startApp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--require', './telemetry.js', 'server.js'], {
    cwd: appDir,
    env: { PATH: process.env.PATH, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  // Loading every instrumentation is slow on some file systems (WSL /mnt/c).
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app did not start:\n${output}`)), 60000);
    child.stdout.on('data', () => {
      if (output.includes('listening on :')) {
        clearTimeout(timer);
        resolve(port);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`app exited with ${code}:\n${output}`));
    });
  });
  return { child, port: ready, output: () => output };
}

function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

test('probes are not traced; other requests are, with service.version', async () => {
  const app = await startApp({
    APP_VERSION: 'test-version',
    OTEL_TRACES_EXPORTER: 'console',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_NODE_RESOURCE_DETECTORS: 'env,host,os,process,serviceinstance',
  });
  try {
    const port = await app.port;
    for (const p of ['/healthz', '/readyz', '/healthz?x=1']) {
      const res = await fetch(`http://localhost:${port}${p}`);
      assert.strictEqual(res.status, 200);
    }
    const res = await fetch(`http://localhost:${port}/api/sessions`);
    assert.strictEqual(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    await stop(app.child);
  }
  const output = app.output();
  assert.match(output, /\/api\/sessions/);
  assert.doesNotMatch(output, /\/healthz|\/readyz/);
  assert.match(output, /test-version/);
});

test('starts with no OpenTelemetry environment at all', async () => {
  const app = await startApp({});
  try {
    const port = await app.port;
    const res = await fetch(`http://localhost:${port}/healthz`);
    assert.strictEqual(res.status, 200);
  } finally {
    await stop(app.child);
  }
});
