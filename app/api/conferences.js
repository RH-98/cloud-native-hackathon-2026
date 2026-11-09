// GET /api/conferences: the conferences we have snapshots for, read once from
// app/data/conferences/ and cached for the life of the process.
const fs = require('node:fs');
const path = require('node:path');
const { sendJson } = require('./http');

const DATA_DIR = path.join(__dirname, '..', 'data', 'conferences');

let cache = null;

function loadConferences(dir = DATA_DIR) {
  const conferences = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const snapshot = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const c = snapshot.conference;
    if (!c || !c.id) continue;
    conferences.push({
      id: c.id,
      name: c.name,
      location: c.location,
      timezone: c.timezone,
      startDate: c.startDate,
      endDate: c.endDate,
      sessionCount: (snapshot.sessions || []).filter((s) => s.kind === 'session').length,
    });
  }
  return conferences;
}

function listConferences() {
  if (!cache) cache = loadConferences();
  return cache;
}

function hasConference(id) {
  return listConferences().some((c) => c.id === id);
}

function handleConferences(req, res) {
  sendJson(res, 200, { conferences: listConferences() });
}

module.exports = { handleConferences, listConferences, hasConference, loadConferences };
