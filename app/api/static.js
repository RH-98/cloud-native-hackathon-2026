// Serves the UI from app/public/: known file types only, no directory
// traversal, index.html at /, short cache headers (there is no build step and
// no fingerprinting, so assets must not be cached for long).
const fs = require('node:fs');
const path = require('node:path');
const { send, sendError } = require('./http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function notFound(res) {
  sendError(res, 'not_found', 'Not found');
}

// Maps a URL path to a file under root, or null if it is not allowed.
function resolveStatic(urlPath, root = PUBLIC_DIR) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  // Reject any dot segment or hidden file outright, before resolving.
  if (decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) return null;
  const file = path.resolve(root, `.${decoded}`);
  if (!file.startsWith(root + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  return file;
}

function createStaticHandler(root = PUBLIC_DIR) {
  return function handleStatic(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 'method_not_allowed', 'Use GET', { allow: 'GET, HEAD' });
    }
    const file = resolveStatic(urlPath, root);
    if (!file) return notFound(res);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return notFound(res);
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'content-type': TYPES[ext],
        'content-length': stat.size,
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      };
      if (req.method === 'HEAD') return send(res, 200, headers);
      fs.readFile(file, (readErr, data) => {
        if (readErr) return notFound(res);
        send(res, 200, headers, data);
      });
    });
  };
}

module.exports = { createStaticHandler, resolveStatic, PUBLIC_DIR };
