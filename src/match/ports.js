'use strict';

// The first port of `ports`, in configured order, that no running game instance holds; null when all are taken.
function firstFreePort(ports, inUse) {
  for (const p of ports) {
    if (!Object.prototype.hasOwnProperty.call(inUse, p)) return p;
  }
  return null;
}

module.exports = { firstFreePort };
