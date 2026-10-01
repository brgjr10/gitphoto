const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 23);

// A clone URL carries the token in its userinfo, and a GitHub error message can
// echo it back. Scrubbing at the single write point is the only place that
// cannot be forgotten by a future call site.
const redact = (text) =>
  String(text)
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_REDACTED')
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_REDACTED')
    .replace(/(x-access-token:)[^@\s]+@/gi, '$1REDACTED@')
    .replace(/([?&](?:access_token|token|api_key)=)[^&\s]+/gi, '$1REDACTED');

const write = (level, stream, scope, message, extra) => {
  if (LEVELS[level] < threshold) return;
  const detail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  stream.write(redact(`${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${detail}\n`));
};

export const createLogger = (scope) => ({
  debug: (message, extra) => write('debug', process.stdout, scope, message, extra),
  info: (message, extra) => write('info', process.stdout, scope, message, extra),
  warn: (message, extra) => write('warn', process.stderr, scope, message, extra),
  error: (message, extra) => write('error', process.stderr, scope, message, extra),
});
