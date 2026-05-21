import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PROJECT_ROOT, PUBLIC_DIR, VIEWS_DIR, settings, validateSettings } from './config.js';
import { jobsRouter } from './api/jobs.js';
import { runsRouter } from './api/runs.js';
import { pagesRouter } from './api/pages.js';
import { settingsRouter } from './api/settings.js';
import { reloadAll } from './scheduler.js';
import { seedIfEmpty } from './seed.js';
import { registerNotifier } from './notifications.js';
import { emailNotifier } from './notifications/email.js';

const app = express();

app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);

// ── Security headers ──────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '5mb', extended: false }));
app.use('/static', express.static(PUBLIC_DIR));

// ── CSRF protection for mutating endpoints ────────────────────────────
// Generate a per-session CSRF token and embed it in pages via res.locals.
// All POST/PUT/DELETE requests to /api/* must include this token.
const csrfTokens = new Map<string, number>(); // token → creation timestamp
const CSRF_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateCsrfToken(): string {
  const token = randomBytes(24).toString('base64url');
  csrfTokens.set(token, Date.now());
  // Prune old tokens
  const cutoff = Date.now() - CSRF_MAX_AGE_MS;
  for (const [t, ts] of csrfTokens) {
    if (ts < cutoff) csrfTokens.delete(t);
  }
  return token;
}

// Make CSRF token available to all EJS views
app.use((_req, res, next) => {
  res.locals.csrfToken = generateCsrfToken();
  next();
});

// Validate CSRF on mutating API requests
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'] as string;
  if (!token || !csrfTokens.has(token)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
});

// Rate limiting — prevent abuse of run triggers and provider tests
const apiLimiter = rateLimit({ windowMs: 60_000, max: 60, message: { error: 'Too many requests, try again later' } });
const runLimiter = rateLimit({ windowMs: 60_000, max: 5, message: { error: 'Too many manual runs, try again later' } });
app.use('/api', apiLimiter);
app.use('/api/jobs/:id/run', runLimiter);
app.use('/api/settings/test', runLimiter);

app.use('/api/jobs', jobsRouter);
app.use('/api/runs', runsRouter);
app.use('/api/settings', settingsRouter);
app.use('/', pagesRouter);

validateSettings();
seedIfEmpty();
registerNotifier(emailNotifier);
reloadAll();

const server = app.listen(settings.port, settings.host, () => {
  console.log(`Argus AI running at http://${settings.host}:${settings.port}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
});

const shutdown = (sig: string): void => {
  console.log(`\n${sig} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
