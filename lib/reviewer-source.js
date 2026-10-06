'use strict';

// CLI fields and Q-n references are assertions, not authenticated identities.
// A platform-backed source can be added here only after its trust boundary is measured.
function checkReviewSource() {
  return { status: 'unconfirmed', reason: 'no verified platform or user identity source is available' };
}

function checkGrantSource() {
  return { status: 'unconfirmed', reason: 'Q-n and CLI input do not prove user authorization' };
}

module.exports = { checkReviewSource, checkGrantSource };
