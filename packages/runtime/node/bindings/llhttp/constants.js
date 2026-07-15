// llhttp constants needed by the Wasm bridge. Mirrors undici@6.21.3's
// lib/llhttp/constants.js (which mirrors llhttp's generated C headers). Kept in
// llhttp's own enum order so `llhttp_get_method(ptr)` round-trips through
// METHODS[n], exactly as Node's lib/_http_common.js expects (`allMethods[method]`).

export const TYPE = { BOTH: 0, REQUEST: 1, RESPONSE: 2 };

// llhttp_get_errno() values → name, used to build HPE_* Error messages.
export const ERROR = [
  "OK", "INTERNAL", "STRICT", "LF_EXPECTED", "UNEXPECTED_CONTENT_LENGTH",
  "CLOSED_CONNECTION", "INVALID_METHOD", "INVALID_URL", "INVALID_CONSTANT",
  "INVALID_VERSION", "INVALID_HEADER_TOKEN", "INVALID_CONTENT_LENGTH",
  "INVALID_CHUNK_SIZE", "INVALID_STATUS", "INVALID_EOF_STATE",
  "INVALID_TRANSFER_ENCODING", "CB_MESSAGE_BEGIN", "CB_HEADERS_COMPLETE",
  "CB_MESSAGE_COMPLETE", "CB_CHUNK_HEADER", "CB_CHUNK_COMPLETE", "PAUSED",
  "PAUSED_UPGRADE", "PAUSED_H2_UPGRADE", "USER",
];

export const ERROR_OK = 0;
export const ERROR_PAUSED = 21;
export const ERROR_PAUSED_UPGRADE = 22;

// Method enum order (llhttp). MUST NOT be reordered.
export const METHODS = [
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE",
  "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH",
  "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
  "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE",
  "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "PRI",
  "DESCRIBE", "ANNOUNCE", "SETUP", "PLAY", "PAUSE", "TEARDOWN",
  "GET_PARAMETER", "SET_PARAMETER", "REDIRECT", "RECORD", "FLUSH",
];
