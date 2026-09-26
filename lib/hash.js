'use strict';

const crypto = require('crypto');

function contentHash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

module.exports = { contentHash };
