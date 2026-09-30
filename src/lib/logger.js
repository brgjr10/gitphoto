const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 23);

const write = (level, stream, scope, message, extra) => {
  if (LEVELS[level] < threshold) return;
  const detail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  stream.write(`${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${detail}\n`);
};

export const createLogger = (scope) => ({
  debug: (message, extra) => write('debug', process.stdout, scope, message, extra),
  info: (message, extra) => write('info', process.stdout, scope, message, extra),
  warn: (message, extra) => write('warn', process.stderr, scope, message, extra),
  error: (message, extra) => write('error', process.stderr, scope, message, extra),
});
