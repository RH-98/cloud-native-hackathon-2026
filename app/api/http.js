// Small HTTP helpers shared by the API handlers: security headers, JSON
// responses in the contract's error format, and a size-limited JSON body reader.

const { trace } = require('@opentelemetry/api');

// Only our own origin, plus Google Fonts for the typeface and GitHub avatars.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const STATUS_BY_CODE = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
  upstream: 502,
  unavailable: 503,
};

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(data));
}

function sendError(res, code, message, extraHeaders = {}) {
  const status = STATUS_BY_CODE[code] || 500;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error: { code, message } }));
}

// Reads a JSON body of at most `limit` bytes. Rejects with HttpError.
function readJsonBody(req, limit = 16 * 1024) {
  // Record the body size on the request's span (Dash0 Agent0 found large
  // plan saves spend most of their time uploading the body).
  const span = trace.getActiveSpan();
  const declaredSize = Number(req.headers['content-length']);
  if (span && Number.isFinite(declaredSize)) span.setAttribute('http.request.body.size', declaredSize);
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HttpError('unsupported_media_type', 'Send the request body as application/json'));
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError('payload_too_large', `The request body is larger than ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new HttpError('payload_too_large', `The request body is larger than ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      span?.setAttribute('app.request.body.decoded_size', size);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError('invalid_input', 'The request body is not valid JSON'));
      }
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

module.exports = { HttpError, SECURITY_HEADERS, STATUS_BY_CODE, send, sendJson, sendError, readJsonBody };
