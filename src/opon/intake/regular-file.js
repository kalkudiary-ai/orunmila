'use strict';

/**
 * src/opon/intake/regular-file.js — read a file only if it is a regular file
 * (NF83, decision LD73). The session header reads files the agent can replace:
 * a FIFO there with no writer would block the read, and with it the session's
 * start; a device could feed it without end.
 *
 *   readRegular(p, maxBytes?) -> the file's bytes (a Buffer), or null when p
 *                     is absent, unreadable, not a regular file, or longer
 *                     than maxBytes (no limit when it is not given)
 *
 * The file is opened first and judged by fstat on that same descriptor, so a
 * file swapped in after the check is never the one read (NF84). Its length is
 * checked again after the read, for a file that grew after the fstat. O_NONBLOCK lets the
 * open of a FIFO return at once; a regular file ignores it. Windows has no
 * O_NONBLOCK and no FIFO a project folder can hold, so the flag is left out
 * there.
 */

const fs = require('fs');

const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

function readRegular(p, maxBytes = Infinity) {
  let fd;
  try {
    fd = fs.openSync(p, FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = fs.readFileSync(fd);
    return buf.length > maxBytes ? null : buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readRegular };
