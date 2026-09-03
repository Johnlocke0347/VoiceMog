// log.js — deliberately minimal. Real production logging usually means
// shipping to a log aggregator (Datadog, CloudWatch, etc.) which is a
// hosting-specific integration, not something to fake here. This gives
// consistent, timestamped, leveled lines to stdout/stderr — every major
// hosting platform (Render, Fly, Railway) already captures and indexes
// that without any extra setup.
function ts(){ return new Date().toISOString(); }
function info(...args){ console.log(`[${ts()}] INFO `, ...args); }
function warn(...args){ console.warn(`[${ts()}] WARN `, ...args); }
function error(...args){ console.error(`[${ts()}] ERROR`, ...args); }

module.exports = { info, warn, error };
