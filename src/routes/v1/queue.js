'use strict';
// The one queue endpoint (spec 4.10) for both kinds of spec 4.2's `queued`:
//   GET    /v1/queue/:ticket   X-RJ-Install must be the ticket's
//            admission (M6): ok {grant} | queued | QUEUE_TICKET_INVALID
//            lobby (M4):     ok as /v1/match/join | queued | QUEUE_TICKET_INVALID
//   DELETE /v1/queue/:ticket   ok {} | QUEUE_TICKET_INVALID
// Tickets share one format and one install binding; the admission queue is asked first, then the match registry. A
// ticket neither knows (unknown, expired, or never issued) is QUEUE_TICKET_INVALID.

const { fail, sendOk, sendQueued } = require('../../contract/envelope');
const { route } = require('./util');

const TICKET_RE = /^q_[A-Za-z0-9_-]{8,64}$/;

function answer(res, r) {
  if (r.result === 'ok') return sendOk(res, r.data);
  if (r.result === 'queued') return sendQueued(res, r.queued);
  return fail(r.code, r.opts || (r.message ? { message: r.message } : {}));
}

// admission: admission/admission.js's createAdmission(). match: match/registry.js's registry, or null.
function registerQueueRoutes(router, { admission, match = null }) {
  function ticketOp(name) {
    return route(async (req, res) => {
      const ticket = req.params.ticket;
      const install = req.rjClient.install;
      let r = null;
      if (TICKET_RE.test(ticket) && install !== '') {
        r = admission[name](ticket, install);
        if (!r && match) r = match[name](ticket, install);
      }
      if (!r) fail('QUEUE_TICKET_INVALID');
      answer(res, r);
    });
  }
  router.get('/queue/:ticket', ticketOp('poll'));
  router.delete('/queue/:ticket', ticketOp('leave'));
}

module.exports = { registerQueueRoutes, answer, TICKET_RE };
