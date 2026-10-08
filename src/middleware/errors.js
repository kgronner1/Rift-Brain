'use strict';
// The /v1 error funnel: an ApiError becomes its envelope (spec 4.2); a body that is not JSON becomes VALIDATION;
// anything else is a bug and becomes INTERNAL, logged with its ref and stack (redacted by log.js).

const log = require('../log');
const { ApiError, buildError } = require('../contract/envelope');

function sendError(res, req, code, opts, messages) {
  const { status, headers, body } = buildError(code, opts, { ref: req.ref, messages });
  res.locals.errorCode = body.error.code;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json(body);
}

// config: () => the remote config view, for `messages` overrides.
function errors({ config, logger = log }) {
  // Express tells an error handler by its four parameters.
  // eslint-disable-next-line no-unused-vars
  return function errorsMiddleware(err, req, res, next) {
    const messages = (config && config().messages) || {};
    if (res.headersSent) {
      logger.error(`[v1] ${req.ref} error after the response was sent:`, err);
      return;
    }
    if (err instanceof ApiError) {
      sendError(res, req, err.code, err.opts, messages);
      return;
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large'
      || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
      sendError(res, req, 'VALIDATION', {
        message: err.type === 'entity.too.large' ? 'That request is too large.' : "That request couldn't be read.",
      }, messages);
      return;
    }
    logger.error(`[v1] ${req.ref} INTERNAL ${req.method} ${String(req.originalUrl).split('?')[0]}:`, err);
    sendError(res, req, 'INTERNAL', {}, messages);
  };
}

// An unknown /v1 path or method. The registry has no "not found" code, so it is a VALIDATION, status 404.
function notFound(req, res, next) {
  next(new ApiError('VALIDATION', { message: "This request isn't supported.", status: 404 }));
}

module.exports = { errors, notFound };
