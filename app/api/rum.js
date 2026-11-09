// Real-user monitoring with the Dash0 Web SDK (public/rum.js loads both):
// GET /config.js answers the browser's Dash0 settings as an ES module, and
// GET /vendor/dash0-sdk-web.js serves the SDK's ESM bundle from node_modules,
// so there is no build step and no third-party script origin. The token is
// ingest-only and dedicated to the browser: it is public by design, but it
// stays out of git (Secret app-credentials) and out of logs.
const fs = require('node:fs');
const path = require('node:path');
const { send, sendError } = require('./http');

const DEFAULT_ENDPOINT = 'https://ingress.us-west-2.aws.dash0.com';
const SERVICE_NAME = 'switchback-web';
const VENDOR_PATH = '/vendor/dash0-sdk-web.js';
const JS = 'text/javascript; charset=utf-8';

// The browser's settings, or null when the token is not set (local dev, CI).
function dash0WebConfig(env = process.env) {
  const authToken = (env.DASH0_WEB_AUTH_TOKEN || '').trim();
  if (!authToken) return null;
  let url = DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(env.DASH0_WEB_ENDPOINT || DEFAULT_ENDPOINT);
    if (parsed.protocol === 'https:') url = parsed.origin;
  } catch {
    // Keep the default endpoint.
  }
  return { url, authToken, serviceName: SERVICE_NAME, version: env.APP_VERSION || 'dev', environment: env.NODE_ENV || 'development' };
}

// The SDK's self-contained ESM bundle, at a fixed path (never from the URL).
function sdkFile() {
  try {
    return path.join(path.dirname(require.resolve('@dash0/sdk-web')), 'dash0.js');
  } catch {
    return null;
  }
}

let sdkCache = null;

function createRumHandler({ env = process.env } = {}) {
  return function handleRum(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET, HEAD' });
    }
    if (p === '/config.js') {
      const body = `export default ${JSON.stringify({ dash0: dash0WebConfig(env) })};\n`;
      const headers = { 'content-type': JS, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) };
      return send(res, 200, headers, req.method === 'HEAD' ? undefined : body);
    }
    if (!sdkCache) {
      const file = sdkFile();
      try {
        sdkCache = file && fs.readFileSync(file);
      } catch {
        sdkCache = null;
      }
    }
    if (!sdkCache) return sendError(res, 'not_found', 'Not found');
    const headers = { 'content-type': JS, 'cache-control': 'public, max-age=300', 'content-length': sdkCache.length };
    return send(res, 200, headers, req.method === 'HEAD' ? undefined : sdkCache);
  };
}

const isRumPath = (p) => p === '/config.js' || p === VENDOR_PATH;

module.exports = { createRumHandler, dash0WebConfig, isRumPath, VENDOR_PATH, DEFAULT_ENDPOINT };
