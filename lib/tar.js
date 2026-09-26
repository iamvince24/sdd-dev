'use strict';

const { BlockedError } = require('./errors');

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const slash = name.lastIndexOf('/');
  const base = slash === -1 ? name : name.slice(slash + 1);
  const prefix = slash === -1 ? '' : name.slice(0, slash);
  if (!prefix || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) {
    throw new BlockedError(`path too long for ustar: ${name}`);
  }
  return { name: base, prefix };
}

function writeOctal(buf, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  buf.write(text, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function header(fileName, size, mtime) {
  const parts = splitName(fileName);
  const buf = Buffer.alloc(512, 0);
  buf.write(parts.name, 0, 'ascii');
  writeOctal(buf, 0o644, 100, 8);
  writeOctal(buf, 0, 108, 8);
  writeOctal(buf, 0, 116, 8);
  writeOctal(buf, size, 124, 12);
  writeOctal(buf, mtime, 136, 12);
  buf.write('        ', 148, 8, 'ascii');
  buf[156] = '0'.charCodeAt(0);
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  if (parts.prefix) buf.write(parts.prefix, 345, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  buf.write(`${checksum}\0 `, 148, 8, 'ascii');
  return buf;
}

function pack(files, mtime = Math.floor(Date.now() / 1000)) {
  const chunks = [];
  for (const file of files) {
    chunks.push(header(file.name, file.bytes.length, mtime));
    chunks.push(file.bytes);
    const pad = (512 - (file.bytes.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

module.exports = { pack };
