// TLS for Postgres: verified TLS for public hosts (Neon etc.); off for localhost and Render's private network
// (internal hostnames have no dot, e.g. dpg-xxxx-a), where Render does not present a public certificate.
"use strict";
module.exports = function pgSsl(url) {
  let host = ""; try { host = new URL(url).hostname; } catch { return { rejectUnauthorized: true }; }
  if (host === "localhost" || host === "127.0.0.1" || !host.includes(".")) return false;
  return { rejectUnauthorized: true };
};
