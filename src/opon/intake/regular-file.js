'use strict';

/**
 * src/opon/intake/regular-file.js — read a file only if it is a regular file
 * (NF83, decision LD73). The session header reads files the agent can replace:
 * a FIFO there with no writer would block the read, and with it the session's
 * start; a device could feed it without end.
 *
 *   readRegular(p) -> the file's bytes (a Buffer), or null when p is absent,
 *                     unreadable, or not a regular file
 *
 * The file is opened first and judged by fstat on that same descriptor, so a
 * file swapped in after the check is never the one read. O_NONBLOCK lets the
 * open of a FIFO return at once; a regular file ignores it. Windows has no
 * O_NONBLOCK and no FIFO a project folder can hold, so the flag is left out
 * there.
 */

const fs = require('fs');

const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

function readRegular(p) {
  let fd;
  try {
    fd = fs.openSync(p, FLAGS);
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readRegular };
