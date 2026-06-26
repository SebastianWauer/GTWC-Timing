'use strict';

const { Client } = require('basic-ftp');
const { EventEmitter } = require('events');

const FTP_FILES = [
  'current.xml',
  'lgView_RunInfo.xml',
  'announcements.xml',
  'lgView_Results.xml',
];

const POLL_INTERVAL_MS = 3000;
const RECONNECT_DELAY_MS = 5000;

class FtpPoller extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.client = new Client();
    this.client.ftp.verbose = false;
    this._running = false;
    this._pollTimer = null;
    this._lastModified = {};
  }

  async start() {
    this._running = true;
    this._scheduleNextPoll(0);
  }

  stop() {
    this._running = false;
    clearTimeout(this._pollTimer);
    this.client.close();
  }

  _scheduleNextPoll(delayMs) {
    if (!this._running) return;
    this._pollTimer = setTimeout(() => this._poll(), delayMs);
  }

  async _connect() {
    if (!this.client.closed) this.client.close();
    this.client = new Client();
    this.client.ftp.verbose = false;
    await this.client.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      secure: false,
    });
  }

  async _poll() {
    try {
      if (this.client.closed) {
        await this._connect();
        this.emit('connected');
      }

      for (const filename of FTP_FILES) {
        try {
          const buf = await this._downloadToBuffer(filename);
          if (buf) {
            this.emit('file', filename, buf.toString('utf8'));
          }
        } catch (fileErr) {
          // individual file missing is non-fatal
          this.emit('fileError', filename, fileErr.message);
        }
      }

      this._scheduleNextPoll(POLL_INTERVAL_MS);
    } catch (err) {
      this.emit('error', err);
      this._scheduleNextPoll(RECONNECT_DELAY_MS);
    }
  }

  async _downloadToBuffer(filename) {
    const { Writable } = require('stream');
    const chunks = [];
    const writable = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    await this.client.downloadTo(writable, filename);
    return Buffer.concat(chunks);
  }
}

function createFtpPoller() {
  const host = process.env.SRO_FTP_HOST;
  const port = parseInt(process.env.SRO_FTP_PORT || '21', 10);
  const user = process.env.SRO_FTP_USER;
  const password = process.env.SRO_FTP_PASS;

  const missing = [];
  if (!host) missing.push('SRO_FTP_HOST');
  if (!user) missing.push('SRO_FTP_USER');
  if (!password) missing.push('SRO_FTP_PASS');

  if (missing.length > 0) {
    throw new Error(`Missing required ENV variables: ${missing.join(', ')}`);
  }

  return new FtpPoller({ host, port, user, password });
}

module.exports = { FtpPoller, createFtpPoller, FTP_FILES };
