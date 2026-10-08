'use strict';
// The request id (spec 4.2, `ref`): in every /v1 error body, in the X-RJ-Ref response header, and in the brain's
// log line for the request, so a player's report and the log meet.

const crypto = require('crypto');
const log = require('../log');

function newRef() {
  return `r-${crypto.randomBytes(6).toString('hex')}`;
}

// Sets req.ref and X-RJ-Ref, and logs one line when the response is finished: method, path (no query), status,
// time, ref, and the error code when there was one.
function requestId({ logger = log } = {}) {
  return function requestIdMiddleware(req, res, next) {
    const ref = newRef();
    const started = process.hrtime.bigint();
    const path = String(req.originalUrl || req.url).split('?')[0];
    req.ref = ref;
    res.setHeader('X-RJ-Ref', ref);
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const code = res.locals.errorCode ? ` ${res.locals.errorCode}` : '';
      logger.info(`[v1] ${ref} ${req.method} ${path} ${res.statusCode}${code} ${ms.toFixed(1)}ms`);
    });
    next();
  };
}

module.exports = { requestId, newRef };
