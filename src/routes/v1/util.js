'use strict';
// Small helpers the /v1 routes share.

const { fail } = require('../../contract/envelope');

// Express 4 does not catch a rejected promise: every async handler goes through this.
function route(fn) {
  return function routeHandler(req, res, next) {
    Promise.resolve().then(() => fn(req, res, next)).catch(next);
  };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function body(req) {
  return isObject(req.body) ? req.body : {};
}

const MAX_USER_ID = 2147483647;

// A user id from a path or a body: a positive integer (a number, or a string of digits).
function parseUserId(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN);
  return Number.isInteger(n) && n > 0 && n <= MAX_USER_ID ? n : null;
}

function requireUserId(v) {
  const id = parseUserId(v);
  if (id === null) fail('VALIDATION', { message: "That player id isn't valid." });
  return id;
}

// An Error a storage function threw for bad input (its message is for the player) -> VALIDATION.
function asValidation(error) {
  fail('VALIDATION', { message: error.message });
}

module.exports = { route, isObject, body, parseUserId, requireUserId, asValidation };
