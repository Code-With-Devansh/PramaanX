import express from 'express';
import { createServer } from "node:http";
import authRouter from "./routes/auth.route.js"
import cookieParser from 'cookie-parser';
import cors from 'cors'
import documentsRouter from "./routes/documents.route.js";
import commentsRouter from "./routes/comments.route.js";
import auditRouter from "./routes/audit.route.js";
import caseRouter from "./routes/cases.route.js";
import usersRouter from "./routes/users.route.js";
import governanceRouter from "./routes/governance.route.js";
import referenceRouter from "./routes/reference.route.js";
import notificationsRouter from "./routes/notifications.route.js";
import searchRouter from "./routes/search.route.js";

import { storage } from "./storage/index.js";
import { errorHandler } from "./middlewares/error.js";
import { requireAuth } from './middlewares/auth.js';
import { ensureDocumentsIndex } from "./search/documents.index.js";
import { attachRealtimeServer } from "./realtime/server.js";
import redisClient from "./config/redis.js";

const app = express();
const port = 3000;
app.use(cors({
    origin: "http://localhost:5173", // React/Vite app
    credentials: true,
  }))
app.use(express.json());
app.use(cookieParser());


app.get('/', (req, res) => {
  res.send('Hello World!');
});
// unauthenticated keep it at the top.
app.use("/api/v1/governance", governanceRouter);

app.use("/api/v1", authRouter);
app.use("/api/v1/cases", requireAuth, caseRouter);

app.use("/api/v1", documentsRouter);
app.use("/api/v1", commentsRouter);
app.use("/api/v1", auditRouter);
app.use("/api/v1", usersRouter);
app.use("/api/v1", referenceRouter);
app.use("/api/v1", notificationsRouter);
app.use("/api/v1", searchRouter);

// Liveness + storage reachability (handy for a compose healthcheck).
app.get("/health/storage", async (req, res) => {
  try {
    await storage.ping();
    res.json({ storage: "ok", bucket: storage.bucket });
  } catch (err) {
    res.status(503).json({ storage: "unavailable", error: err.message });
  }
});

// Error handler must be registered last so it catches errors from every route
// above (Express 5 forwards rejected async handlers here automatically).
app.use(errorHandler);

async function start() {
  // Make sure the documents bucket exists before serving (retries a cold MinIO).
  await storage.ensureBucket();
  // Idempotent — creates the OpenSearch index on first boot, no-ops after.
  await ensureDocumentsIndex();
  const server = createServer(app);
  await attachRealtimeServer(server, redisClient);
  server.listen(port, () => {
    console.log(`DMS app listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error("[startup] failed to start:", err);
  process.exit(1);
});
