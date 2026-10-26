'use strict';
// Structured JSON logs (one line per event) — Render's log view and any log drain can filter on the fields.
const out = (level, msg, fields) => { const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields || {}) }); (level === 'error' ? console.error : console.log)(line); };
module.exports = { info: (m, f) => out('info', m, f), warn: (m, f) => out('warn', m, f), error: (m, f) => out('error', m, f) };
