// Fetches a source page inside an OpenTelemetry span, with a timeout.
// Shared by the snapshot importer (scripts/import-kubecon-na-2026.js) and the
// schedule watcher (scripts/watch-schedule.js).
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const tracer = trace.getTracer('conference-importer');

async function fetchText(url, spanName, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  return tracer.startActiveSpan(spanName, { attributes: { 'url.full': url } }, async (span) => {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': 'conference-planner-importer (Cloud Native Hackathon 2026)' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      span.setAttribute('http.response.status_code', res.status);
      if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

module.exports = { fetchText };
