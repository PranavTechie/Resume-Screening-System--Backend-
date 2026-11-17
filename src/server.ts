import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env, validateEnv } from './config/env';
import { logger } from './utils/logger';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';
import { apiLimiter } from './middleware/rateLimit.middleware';
import { requestContext } from './middleware/requestContext.middleware';
import { jobWorker } from './workers/jobWorker';

const app = express();
const PORT = parseInt(env.PORT, 10) || 3000;

// Validate essential environment configuration
validateEnv();

// Security and utility middlewares
app.use(helmet({
  contentSecurityPolicy: false, // Allows flexible integration when embedded
}));

// CORS Configuration
const corsOptions: cors.CorsOptions = {
  origin: (requestOrigin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman, server-to-server)
    if (!requestOrigin) {
      return callback(null, true);
    }

    const normalizedOrigin = requestOrigin.replace(/\/+$/, '');
    const isDev = env.NODE_ENV !== 'production';

    // 1. Check explicitly configured frontend URLs (supported in development and production)
    const configuredOrigins = (env.FRONTEND_URL || '')
      .split(',')
      .map((u) => u.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    // In production, disallow '*' wildcard for security when credentials are used
    const hasWildcard = configuredOrigins.includes('*');
    if (configuredOrigins.includes(normalizedOrigin) || (hasWildcard && isDev)) {
      return callback(null, true);
    }

    // 2. Local development origins (localhost, 127.0.0.1, [::1] on any port, http/https)
    if (isDev) {
      // Matches http/https localhost or loopback with optional port
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(normalizedOrigin);
      if (isLocalhost) {
        return callback(null, true);
      }

      // Matches private LAN IPs (RFC 1918) when Vite is accessed via --host 0.0.0.0
      const isPrivateLan = /^https?:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/i.test(normalizedOrigin);
      if (isPrivateLan) {
        return callback(null, true);
      }
    }

    logger.warn('cors.blocked', { origin: requestOrigin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Explicit preflight handler for OPTIONS requests
app.options('*', cors(corsOptions));

app.set('trust proxy', 1); // Railway / reverse proxy: rate limits see the real client IP

app.use(requestContext);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Apply general API rate limiting
app.use('/api', apiLimiter);

// Mount combined API routes
app.use('/', routes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
    timestamp: new Date().toISOString(),
  });
});

// Centralized error handling middleware
app.use(errorHandler);

// Start HTTP server + background worker
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { port: PORT, mode: env.NODE_ENV, worker: env.WORKER_ENABLED, aiMock: env.AI_MOCK_MODE });
  if (env.WORKER_ENABLED) jobWorker.start();
});
server.requestTimeout = 180_000; // single uploads with vision OCR can take up to ~2 min
server.headersTimeout = 185_000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { signal });
  server.close();
  await jobWorker.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason: any) => {
  logger.error('process.unhandled_rejection', { error: String(reason?.message || reason).slice(0, 300) });
});

export default app;
