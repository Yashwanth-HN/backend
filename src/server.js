import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { startResearch, getJobStatus } from "./services/agent-orchestrator.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const OTP_TTL_MS = 5 * 60 * 1000;
const VERIFIED_TTL_MS = 10 * 60 * 1000;

const usersByEmail = new Map();
const pendingOtps = new Map();
const verifiedOtps = new Map();

function otpKey(email, purpose) {
  return `${String(email || "").trim().toLowerCase()}::${purpose}`;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function validatePurpose(purpose) {
  return purpose === "register" || purpose === "login";
}

function cleanupExpired() {
  const now = Date.now();
  for (const [key, value] of pendingOtps.entries()) {
    if (value.expiresAt <= now) pendingOtps.delete(key);
  }
  for (const [key, value] of verifiedOtps.entries()) {
    if (value.expiresAt <= now) verifiedOtps.delete(key);
  }
}

async function sendOtpEmail(email, otp, purpose) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!host || !user || !pass || !from) {
    return { sent: false };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const label = purpose === "register" ? "registration" : "login";

  await transporter.sendMail({
    from,
    to: email,
    subject: `ResearchHub ${label} OTP`,
    text: `Your ResearchHub OTP is ${otp}. It expires in 5 minutes.`,
    html: `<p>Your <strong>ResearchHub</strong> OTP is:</p><h2 style="letter-spacing:2px">${otp}</h2><p>This code expires in 5 minutes.</p>`,
  });

  return { sent: true };
}

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "glow-research-backend",
    timestamp: new Date().toISOString(),
  });
});

// ── Research Agent Routes ────────────────────────────────────────────────────

// POST /api/research/start  { query: string }
// Returns { jobId } immediately; pipeline runs in background.
app.post("/api/research/start", (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "Missing or empty query" });
    }
    const jobId = startResearch(query);
    return res.json({ ok: true, jobId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/research/status/:jobId
// Returns full job state including stage, status, result (when done).
app.get("/api/research/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }
  const job = getJobStatus(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }
  return res.json({ ok: true, job });
});

// POST /api/research/synthesize/:jobId
// Compatibility route expected by frontend. Returns synthesis text for completed jobs.
app.post("/api/research/synthesize/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  const job = getJobStatus(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found or expired" });
  }

  if (job.status !== "completed" || !job.result) {
    return res.status(409).json({ error: "Synthesis is not ready yet" });
  }

  const synthesis =
    typeof job.result?.synthesis?.summary === "string"
      ? job.result.synthesis.summary
      : typeof job.result?.synthesis === "string"
      ? job.result.synthesis
      : "";

  return res.json({ ok: true, synthesis });
});

app.post("/api/auth/request-otp", async (req, res) => {
  try {
    cleanupExpired();

    const email = String(req.body?.email || "").trim().toLowerCase();
    const purpose = String(req.body?.purpose || "").trim();

    if (!email || !validatePurpose(purpose)) {
      return res.status(400).json({ error: "Invalid email or purpose" });
    }

    if (purpose === "login" && !usersByEmail.has(email)) {
      return res.status(404).json({ error: "No account found for this email" });
    }

    if (purpose === "register" && usersByEmail.has(email)) {
      return res.status(409).json({ error: "Account already exists for this email" });
    }

    const otp = generateOtp();
    const key = otpKey(email, purpose);

    pendingOtps.set(key, {
      otp,
      expiresAt: Date.now() + OTP_TTL_MS,
    });
    verifiedOtps.delete(key);

    const mailResult = await sendOtpEmail(email, otp, purpose);

    // For local development without SMTP, expose OTP so frontend can continue.
    if (!mailResult.sent) {
      console.log(`[DEV OTP] ${purpose} ${email}: ${otp}`);
      return res.json({
        ok: true,
        message: "OTP generated. SMTP not configured; using dev OTP mode.",
        dev_otp: otp,
      });
    }

    return res.json({
      ok: true,
      message: "OTP sent to your email.",
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

app.post("/api/auth/verify-otp", (req, res) => {
  cleanupExpired();

  const email = String(req.body?.email || "").trim().toLowerCase();
  const purpose = String(req.body?.purpose || "").trim();
  const otp = String(req.body?.otp || "").trim();

  if (!email || !otp || !validatePurpose(purpose)) {
    return res.status(400).json({ error: "Invalid verification payload" });
  }

  const key = otpKey(email, purpose);
  const pending = pendingOtps.get(key);

  if (!pending) {
    return res.status(400).json({ error: "OTP expired or not requested" });
  }

  if (pending.otp !== otp) {
    return res.status(401).json({ error: "Invalid OTP" });
  }

  pendingOtps.delete(key);
  verifiedOtps.set(key, { expiresAt: Date.now() + VERIFIED_TTL_MS });

  return res.json({ ok: true, message: "OTP verified" });
});

function consumeVerifiedOtp(email, purpose) {
  cleanupExpired();
  const key = otpKey(email, purpose);
  const verified = verifiedOtps.get(key);
  if (!verified) return false;
  verifiedOtps.delete(key);
  return true;
}

app.post("/api/auth/register", (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (usersByEmail.has(email)) {
    return res.status(409).json({ error: "Account already exists" });
  }

  if (!consumeVerifiedOtp(email, "register")) {
    return res.status(401).json({ error: "OTP verification required" });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
  };

  usersByEmail.set(email, {
    ...user,
    password,
  });

  return res.json({ ok: true, user });
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  const stored = usersByEmail.get(email);
  if (!stored || stored.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!consumeVerifiedOtp(email, "login")) {
    return res.status(401).json({ error: "OTP verification required" });
  }

  const { password: _pwd, ...user } = stored;
  return res.json({ ok: true, user });
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
