const express = require("express");
const session = require("express-session");
const fileUpload = require("express-fileupload");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;
// Find your existing import and update it like this:
const {
  getGeminiResponse,
  extractTextFromBuffer,
  listModels,
} = require("./ai-service");

// 1. GLOBAL SECURITY & PARSERS (MUST BE FIRST)
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "5mb" })); // Increased limit for larger metadata
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

// 2. FILE UPLOAD CONFIGURATION
app.use(
  fileUpload({
    limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 25) * 1024 * 1024 },
    abortOnLimit: true,
    useTempFiles: false, // Keep in memory for fast Supabase transfer
  }),
);

// 3. DATABASE & SUPABASE INIT
const db = require("./db_pg");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

// 4. CORS CONFIG
app.use(cors({ origin: true, credentials: true }));
app.options("/api/*", cors({ origin: true, credentials: true }));

// 5. SESSION MANAGEMENT (After Parsers)
const pgSession = require("connect-pg-simple")(session);
const isProd = process.env.RENDER || process.env.NODE_ENV === "production";

app.use(
  session({
    store: new pgSession({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
      tableName: "user_sessions",
    }),
    name: "sid",
    secret: process.env.SESSION_SECRET || "your_secret_key",
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// 6. STATIC FILES
app.use(express.static(path.join(__dirname, "public")));

// --- Static pages ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Middleware to sanitize any downstream redirect Location headers (defense-in-depth)
app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (statusOrUrl, maybeUrl) => {
    let status = 302;
    let url = statusOrUrl;
    if (typeof statusOrUrl === "number") {
      status = statusOrUrl;
      url = maybeUrl;
    }
    if (typeof url === "string") {
      const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url);
      if (isAbsolute) {
        // Never allow absolute localhost or mismatched host redirects
        try {
          const u = new URL(url);
          if (
            /^localhost$/i.test(u.hostname) ||
            /^127\.0\.0\.1$/i.test(u.hostname)
          ) {
            url = "/index.html";
          } else {
            // Convert any absolute URL to a relative path to stay same-origin
            url = u.pathname + (u.search || "") + (u.hash || "");
          }
        } catch {
          url = "/index.html";
        }
      } else {
        const safe = path.posix.normalize(url);
        url = safe.startsWith("/") ? safe : `/${safe}`;
      }
    }
    return originalRedirect(status, url);
  };
  next();
});

const BUCKET_SLIDES = process.env.SUPABASE_BUCKET || "slides";
const BUCKET_RESOURCES = "campus-resources";
// Sanitize path segments for Supabase Storage keys
function sanitizeSegment(value, fallback = "x") {
  let v = String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!v) v = fallback;
  return v;
}

const webpush = require("web-push");

// Use your VAPID keys from Render Environment Variables
webpush.setVapidDetails(
  "mailto:support@upsa-it09.onrender.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

async function notifyTargetGroup(payload, criteria) {
  try {
    let query =
      "SELECT push_subscription FROM users_app WHERE push_subscription IS NOT NULL";
    let params = [];

    if (criteria.type === "institution") {
      query += " AND institution_id = $1";
      params.push(criteria.id);
    } else if (criteria.type === "program") {
      query += " AND program_id = $1";
      params.push(criteria.id);
    }

    const { rows } = await db.pool.query(query, params);

    const pushPayload = JSON.stringify({
      title: payload.title,
      content: payload.content,
      type: payload.type,
      url: payload.url,
    });

    // 2. Send the push to each valid subscription
    rows.forEach((row) => {
      webpush
        .sendNotification(row.push_subscription, pushPayload)
        .catch((err) => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // Clean up expired subscriptions
            db.pool.query(
              "UPDATE users_app SET push_subscription = NULL WHERE push_subscription = $1",
              [JSON.stringify(row.push_subscription)],
            );
          }
        });
    });
  } catch (err) {
    console.error("Push Notification Error:", err);
  }
}

app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/index.html");
  const role = req.session.user.role;
  if (role === "admin") {
    return res.redirect("/admin.html");
  }
  if (role === "rep") {
    return res.redirect("/rep-dashboard");
  }
  // student (default)
  return res.sendFile(path.join(__dirname, "public", "dashboard-modern.html"));
});

// Rep dashboard route
app.get("/rep-dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/index.html");
  const role = req.session.user.role;
  if (role === "admin") return res.redirect("/admin.html");
  if (role !== "rep") return res.redirect("/dashboard");
  return res.sendFile(path.join(__dirname, "public", "rep-dashboard.html"));
});

// Who am I (quick role check)
app.get("/api/whoami", (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  return res.json({ ok: true, user: req.session.user });
});

// Admin guard
function requireAdmin(req, res, next) {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ ok: false, message: "Unauthorized" });
  if (u.role !== "admin")
    return res.status(403).json({ ok: false, message: "Forbidden" });
  next();
}

const requireLeader = (req, res, next) => {
  const u = req.session?.user;
  if (!u) return res.status(401).json({ ok: false });

  if (u.role === "admin" || u.is_leader) return next();

  return res.status(403).json({
    ok: false,
    message: "Leader access required",
  });
};

// List users for admin
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json({ ok: true, users });
  } catch (e) {
    console.error("List users error:", e);
    res.status(500).json({ ok: false, message: "Failed to load users" });
  }
});

// Update program / academicYearStart / classGroup (admin only)
app.post(
  "/api/admin/users/:studentId/update-cohort",
  requireAdmin,
  async (req, res) => {
    try {
      const sid = String(req.params.studentId || "").trim();
      if (!sid)
        return res
          .status(400)
          .json({ ok: false, message: "Student ID is required" });

      // Accept partial updates
      const program = (req.body?.program || "").toString().trim();
      const yearRaw = req.body?.academicYearStart;
      const classGroupRaw = (req.body?.classGroup || "").toString().trim();

      // Fetch existing user
      const userRes = await db.pool.query(
        "select * from users_app where student_id=$1",
        [sid],
      );
      if (!userRes.rowCount)
        return res.status(404).json({ ok: false, message: "User not found" });
      const u = userRes.rows[0];

      // Determine new values (falling back to existing ones)
      const newProgram = program || u.program || "";
      const newProgramId = newProgram
        ? db.programIdFromName(newProgram)
        : u.program_id || "";
      const newYear =
        typeof yearRaw === "number" && !Number.isNaN(yearRaw)
          ? yearRaw
          : (() => {
              const m = String(u.cohort_id || "").split("|"); // upsa|programId|year
              const yr = m[2] ? Number(m[2]) : undefined;
              return Number.isFinite(yr) ? yr : new Date().getFullYear();
            })();
      const classGroup = classGroupRaw
        ? db.normalizeClassGroup(classGroupRaw)
        : u.class_group || "";

      // Recompute cohort and classGroup IDs
      const institutionId = u.institution_id || "upsa";
      const cohortId = db.makeCohortId(institutionId, newProgramId, newYear);
      const classGroupId = classGroup
        ? db.makeClassGroupId(cohortId, classGroup)
        : u.class_group_id;

      // Apply update
      const q = `
      update users_app
         set program = $1,
             program_id = $2,
             cohort_id = $3,
             class_group = $4,
             class_group_id = $5
       where student_id = $6
       returning id, student_id, role, program, class_group, cohort_id, class_group_id
    `;
      const vals = [
        newProgram || null,
        newProgramId || null,
        cohortId || null,
        classGroup || null,
        classGroupId || null,
        sid,
      ];
      const upd = await db.pool.query(q, vals);
      return res.json({ ok: true, user: upd.rows[0] });
    } catch (e) {
      console.error("Update cohort error:", e);
      return res.status(500).json({ ok: false, message: "Server error" });
    }
  },
);

// --- API: authentication & session ---
app.post("/api/login", async (req, res) => {
  try {
    const sid = (req.body?.studentId || "").trim();
    const password = req.body?.password || "";

    if (!sid || !password) {
      return res.status(400).json({
        ok: false,
        message: "Student ID and password are required",
      });
    }

    const user = await db.findUserByStudentId(sid);
    if (!user) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const crypto = require("crypto");
    const shaValid =
      user.password_hash &&
      user.password_hash.length === 64 &&
      user.password_hash ===
        crypto.createHash("sha256").update(String(password)).digest("hex");

    const bcryptValid =
      user.password_hash &&
      user.password_hash.startsWith("$2") &&
      bcrypt.compareSync(password, user.password_hash);

    if (!shaValid && !bcryptValid) {
      return res.status(401).json({
        ok: false,
        message: "Invalid credentials",
      });
    }

    const fullName = user.full_name || "";
    const firstName =
      fullName.trim().split(/\s+/)[0] || user.student_id || "User";

    // Always normalize classGroupId for session
    let classGroupId = user.class_group_id;
    if (db.makeClassGroupId && user.cohort_id && user.class_group) {
      classGroupId = db.makeClassGroupId(user.cohort_id, user.class_group);
    }
    const sessionUser = {
      id: user.id,
      role: user.role,
      studentId: user.student_id,
      institutionId: user.institution_id,
      program: user.program || null,
      programId: user.program_id,
      cohortId: user.cohort_id,
      classGroup: user.class_group,
      classGroupId,
      fullName,
      firstName,
      is_rep: !!user.is_rep,
      is_leader: !!user.is_leader,
      is_creator: !!user.is_creator,
      currentLevel: user.current_level || 100,
    };

    // Role-based redirect hint
    let redirect = "/dashboard";
    if (sessionUser.role === "admin") redirect = "/admin.html";
    else if (sessionUser.role === "rep") redirect = "/rep-dashboard";
    else if (sessionUser.role === "student") redirect = "/dashboard";

    req.session.user = sessionUser;

    req.session.save((err) => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({
          ok: false,
          message: "Session error",
        });
      }

      return res.json({
        ok: true,
        user: sessionUser,
        redirect,
      });
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({
      ok: false,
      message: "Server error",
    });
  }
});

app.post("/api/signup", async (req, res) => {
  try {
    const {
      studentId,
      full_name,
      email,
      password,
      program,
      classGroup,
      academicYearStart,
      institutionId,
    } = req.body || {};
    if (
      !studentId ||
      !full_name ||
      !email ||
      !password ||
      !program ||
      !classGroup ||
      !academicYearStart
    ) {
      return res.status(400).json({ ok: false, message: "Missing fields" });
    }

    // Enforce Student ID 6–12 digits to support different schools (UPSA is 8)
    const idOk = /^\d{6,12}$/.test(String(studentId).trim());
    if (!idOk) {
      return res.status(400).json({
        ok: false,
        message: "Please enter a valid Student ID (6–12 digits).",
      });
    }

    // Uniqueness checks
    const [byId, byEmail] = await Promise.all([
      db.findUserByStudentId(studentId),
      db.findUserByEmail(email),
    ]);
    if (byId)
      return res
        .status(409)
        .json({ ok: false, message: "Student ID already exists." });
    if (byEmail)
      return res
        .status(409)
        .json({ ok: false, message: "Email already registered." });

    // DYNAMIC LEVEL CALCULATION
    const currentYear = 2026;
    const startYear = Number(academicYearStart);
    let calculatedLevel = 100; // Baseline fallback

    // Calculate level based on cohort year progression
    if (startYear <= currentYear) {
      calculatedLevel = (currentYear - startYear + 1) * 100;
    }

    // Safety clamp to avoid rendering level 500+ for normal undergraduate tracks
    if (calculatedLevel > 400) {
      calculatedLevel = 400;
    }

    // Pass the calculated level into the DB creation function
    const user = await db.createUser({
      studentId,
      full_name,
      email,
      program,
      classGroup: db.normalizeClassGroup(classGroup),
      password, // db_pg hashes to sha256
      role: "student",
      institutionId: institutionId || "upsa",
      academicYearStart: startYear,
      current_level: calculatedLevel, // Make sure your db.createUser helper maps this parameter to the table insert column!
    });

    // Auto-login: set session so the user can access /dashboard immediately after signup
    const fullName = user.full_name || full_name || "";
    const firstName =
      fullName.trim().split(/\s+/)[0] || user.student_id || studentId || "User";

    // Always normalize classGroupId for session
    let classGroupId = user.class_group_id;
    if (db.makeClassGroupId && user.cohort_id && user.class_group) {
      classGroupId = db.makeClassGroupId(user.cohort_id, user.class_group);
    }
    const sessionUser = {
      id: user.id,
      role: user.role,
      studentId: user.student_id || studentId,
      institutionId: user.institution_id || "upsa",
      program: user.program || program || null,
      programId: user.program_id,
      cohortId: user.cohort_id,
      classGroup: user.class_group || db.normalizeClassGroup(classGroup),
      classGroupId,
      fullName,
      firstName,
      currentLevel: user.current_level || calculatedLevel, // Pushing accurate level to session memory
    };
    req.session.user = sessionUser;

    // Provide a redirect hint to the client
    return res.json({ ok: true, user: sessionUser, redirect: "/dashboard" });
  } catch (e) {
    if (e && e.code === "23505") {
      const msg =
        e.detail && /Key \(email\)/.test(e.detail)
          ? "Email already registered."
          : "Student ID already exists.";
      return res.status(409).json({ ok: false, message: msg });
    }
    console.error("Signup error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// Availability check for signup
// GET /api/check-availability?studentId=&email=
app.get("/api/check-availability", async (req, res) => {
  try {
    const sid = (req.query.studentId || "").toString().trim();
    const email = (req.query.email || "").toString().trim().toLowerCase();
    let studentIdAvailable = true;
    let emailAvailable = true;

    if (sid) {
      const u = await db.findUserByStudentId(sid);
      studentIdAvailable = !u;
    }
    if (email) {
      const e = await db.findUserByEmail(email);
      emailAvailable = !e;
    }
    return res.json({ ok: true, studentIdAvailable, emailAvailable });
  } catch (err) {
    console.error("Availability check error:", err);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.get("/api/courses", async (req, res) => {
  try {
    if (!db.listCourses) {
      return res.json({ ok: true, courses: [] });
    }

    let classGroupId = null;
    if (req.session && req.session.user) {
      classGroupId =
        req.session.user.class_group_id || req.session.user.classGroupId;
    }

    const courses = await db.listCourses(classGroupId);
    return res.json({ ok: true, courses });
  } catch (e) {
    console.error("List courses error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load courses" });
  }
});

app.get("/api/courses/mine", async (req, res) => {
  try {
    const u = req.session?.user;
    if (!u) return res.status(401).json({ ok: false, message: "Unauthorized" });

    if (!db.listCourseTitlesForClassGroupId) {
      return res.json({ ok: true, titles: [] });
    }

    const targetGroupId = u.class_group_id || u.classGroupId;

    const titles = await db.listCourseTitlesForClassGroupId(targetGroupId);
    return res.json({ ok: true, titles });
  } catch (e) {
    console.error("List my course titles error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load titles" });
  }
});

app.post("/api/courses/manage", async (req, res) => {
  try {
    const u = req.session?.user;
    if (!u) return res.status(401).json({ ok: false, message: "Unauthorized" });

    const allowed = new Set(["rep", "admin", "teacher"]);
    if (!allowed.has(u.role))
      return res.status(403).json({ ok: false, message: "Forbidden" });

    // Handle both raw req.body formats gracefully
    const title = (req.body?.title || req.body?.courseTitle || "")
      .toString()
      .trim();
    if (!title)
      return res.status(400).json({ ok: false, message: "Title is required" });

    if (!db.addCourseTitleForClassGroupId) {
      return res
        .status(500)
        .json({ ok: false, message: "Course title storage not available" });
    }

    // FIX: Fall back to snake_case column property populated from users_app table
    const targetClassGroupId = u.class_group_id || u.classGroupId;
    if (!targetClassGroupId) {
      return res
        .status(400)
        .json({
          ok: false,
          message: "User class group identifier missing from session",
        });
    }

    await db.addCourseTitleForClassGroupId(targetClassGroupId, title);
    return res.json({ ok: true, message: "Added", title });
  } catch (e) {
    console.error("Add course title error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// Upload slide (rep/admin/teacher) to Supabase Storage and save metadata
app.post("/api/upload", async (req, res) => {
  try {
    const u = req.session?.user;
    if (!u) return res.status(401).json({ ok: false, message: "Unauthorized" });
    if (!req.files || !req.files.file)
      return res.status(400).json({ ok: false, message: "No file uploaded" });

    const file = req.files.file;
    const {
      slideTitle,
      courseTitle,
      institution_id,
      program_id,
      class_group_id,
    } = req.body;

    const targetBucket = courseTitle ? BUCKET_SLIDES : BUCKET_RESOURCES;

    const inst = sanitizeSegment(institution_id || u.institution_id || "upsa");
    const prog = sanitizeSegment(program_id || u.program_id || "it");
    const group = sanitizeSegment(
      class_group_id || u.class_group_id || "general",
    );
    const course = sanitizeSegment(courseTitle, "general");

    const { v4: uuidv4 } = require("uuid");
    const uniqueId = uuidv4();
    const safeFileName = sanitizeSegment(file.name, "file");

    // Structure: upsa/it/upsa_it_2026_it9/communication_skills/uuid-filename.pdf
    const objectPath = `${inst}/${prog}/${group}/${course}/${uniqueId}-${safeFileName}`;

    // 3. Upload to Supabase Storage
    const { error: upErr } = await supabase.storage
      .from(targetBucket)
      .upload(objectPath, file.data, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (upErr) throw upErr;

    // 4. Insert into the 'slides' table
    const { error: dbErr } = await supabase.from("slides").insert([
      {
        id: uniqueId,
        class_group_id: class_group_id || u.class_group_id,
        course_title: courseTitle || "General",
        slide_title: slideTitle || file.name,
        object_path: objectPath,
        original_name: file.name,
        content_type: file.mimetype,
        size_bytes: file.size,
        uploader_id: u.id,
        institution_id: inst,
        program_id: prog,
        cohort_id: u.cohort_id || "2026",
      },
    ]);

    if (dbErr) throw dbErr;

    const notifyCriteria = program_id
      ? { type: "program", id: program_id }
      : { type: "institution", id: inst };

    notifyTargetGroup(
      {
        title: "New Resource Uploaded",
        content: `${u.full_name} uploaded ${slideTitle || file.name}`,
        type: "resource",
        url: "/resources.html",
      },
      notifyCriteria,
    );

    return res.json({
      ok: true,
      message: `Successfully uploaded to ${targetBucket}`,
      id: uniqueId,
    });
  } catch (e) {
    console.error("Upload process error:", e.message);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Email verification flow not used in current production path (skipped)

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  try {
    // Always serve the live level from the DB so the Master Vault follows promotions
    const { rows } = await db.pool.query(
      "SELECT current_level, is_rep, is_leader, is_creator, role FROM users_app WHERE id = $1 LIMIT 1",
      [req.session.user.id],
    );
    if (rows.length > 0) {
      req.session.user.currentLevel = rows[0].current_level || req.session.user.currentLevel || 100;
      req.session.user.is_rep = !!rows[0].is_rep;
      req.session.user.is_leader = !!rows[0].is_leader;
      req.session.user.is_creator = !!rows[0].is_creator;
      req.session.user.role = rows[0].role;
    }
  } catch (e) {
    console.error("Session refresh error:", e.message);
  }
  return res.json({ ok: true, user: req.session.user });
});

app.post("/api/admin/create", async (req, res) => {
  try {
    const setupSecret = process.env.ADMIN_SETUP_SECRET;
    const provided =
      req.get("X-Admin-Setup-Secret") || req.get("x-admin-setup-secret");
    if (!setupSecret || !provided || setupSecret !== provided) {
      return res.status(403).json({ ok: false, message: "Forbidden" });
    }

    const { studentId, full_name, email, password } = req.body || {};
    if (!studentId || !full_name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing required fields" });
    }

    // Avoid duplicates
    const exists = await db.findUserByStudentId(studentId);
    if (exists) {
      return res
        .status(409)
        .json({ ok: false, message: "Student ID already exists" });
    }

    const currentYear = new Date().getFullYear();
    const institutionId = "upsa";
    const program = "Administration";
    const programId = db.programIdFromName
      ? db.programIdFromName(program)
      : "administration";
    const cohortId = db.makeCohortId
      ? db.makeCohortId(institutionId, programId, currentYear)
      : `${institutionId}|${programId}|${currentYear}`;
    const classGroup = db.normalizeClassGroup
      ? db.normalizeClassGroup("ADM")
      : "ADM";
    const classGroupId = db.makeClassGroupId
      ? db.makeClassGroupId(cohortId, classGroup)
      : `${cohortId}|${classGroup}`;

    // Hash password (bcrypt) to align with current bcrypt usage in this file
    const hashed = bcrypt.hashSync(password, 10);

    // Insert directly with elevated role using db.createUser if it supports role, else create+update
    let user = null;
    if (typeof db.createUser === "function") {
      user = await db.createUser({
        studentId,
        full_name,
        email,
        program,
        classGroup,
        password, // db_pg.createUser hashes with sha256 by default; we want bcrypt here for app.js compatibility
        role: "admin",
        institutionId,
        academicYearStart: currentYear,
      });
      // If db.createUser hashed differently, force-set bcrypt by updating password_hash
      if (user && user.id && db.pool) {
        try {
          await db.pool.query(
            "update users_app set role=$1, password_hash=$2, program=$3, program_id=$4, institution_id=$5, cohort_id=$6, class_group=$7, class_group_id=$8 where id=$9",
            [
              "admin",
              hashed,
              program,
              programId,
              institutionId,
              cohortId,
              classGroup,
              classGroupId,
              user.id,
            ],
          );
          const r = await db.findUserByStudentId(studentId);
          user = r || user;
        } catch (_) {}
      }
    } else if (db.pool) {
      const { rows } = await db.pool.query(
        `insert into users_app (student_id, full_name, email, role, institution_id, program, program_id, cohort_id, class_group, class_group_id, password_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning *`,
        [
          studentId,
          full_name,
          email,
          "admin",
          institutionId,
          program,
          programId,
          cohortId,
          classGroup,
          classGroupId,
          hashed,
        ],
      );
      user = rows[0];
    } else {
      return res.status(500).json({ ok: false, message: "DB not available" });
    }

    if (!user) {
      return res
        .status(500)
        .json({ ok: false, message: "Failed to create admin" });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        student_id: user.student_id || studentId,
        role: "admin",
      },
    });
  } catch (e) {
    console.error("Admin create error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const all = await db.getAllUsers();
  return res.json({ ok: true, users: all });
});

app.post("/api/admin/promote", requireAdmin, async (req, res) => {
  const { studentId, role } = req.body;
  const allowed = [
    "student",
    "rep",
    "rep_assistant",
    "course_secretary",
    "admin",
  ];
  if (!studentId || !role)
    return res.status(400).json({ ok: false, message: "Missing fields" });
  if (!allowed.includes(role))
    return res.status(400).json({ ok: false, message: "Invalid role" });
  const u =
    (await db.findUserByStudentId(studentId)) ||
    (await db.getUserById(studentId));
  if (!u) return res.status(404).json({ ok: false, message: "User not found" });
  const updated = await db.setUserRole(u.id, role);
  return res.json({ ok: true, user: { id: updated.id, role: updated.role } });
});

app.post("/api/admin/import", requireAdmin, async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ ok: false, message: "No file uploaded" });
    }

    const file = req.files.file;
    const name = String(file.name || "").toLowerCase();
    if (!name.endsWith(".csv")) {
      return res
        .status(400)
        .json({ ok: false, message: "Please upload a CSV file" });
    }

    const data =
      file.data ||
      (file.tempFilePath ? fs.readFileSync(file.tempFilePath) : null);
    if (!data || !data.length) {
      return res.status(400).json({ ok: false, message: "Empty file" });
    }

    let records = [];
    try {
      records = parse(data, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch (e) {
      console.error("CSV parse error:", e);
      return res.status(400).json({ ok: false, message: "Invalid CSV format" });
    }

    if (!Array.isArray(records) || !records.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No rows found in CSV" });
    }

    const results = { ok: true, imported: 0, skipped: 0, errors: [] };
    const currentYear = new Date().getFullYear();

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      try {
        const studentId = (row.studentId || row.student_id || "")
          .toString()
          .trim();
        const full_name = (row.full_name || row.name || "").toString().trim();
        const email = (row.email || "").toString().trim();
        const program = (row.program || "").toString().trim();
        const classGroupRaw = (row.classGroup || row.class_group || "")
          .toString()
          .trim();
        const classGroup = db.normalizeClassGroup
          ? db.normalizeClassGroup(classGroupRaw)
          : classGroupRaw;
        const academicYearStart = Number(
          row.academicYearStart || row.academic_year_start || currentYear,
        );
        const role = (row.role || "").toString().trim() || "student";
        const password = (row.password || "").toString();

        if (!studentId || !full_name || !email || !program || !classGroup) {
          results.skipped++;
          results.errors.push({
            row: i + 1,
            error:
              "Missing required fields (studentId, full_name, email, program, classGroup)",
          });
          continue;
        }

        const byId = await db.findUserByStudentId(studentId);
        const byEmail = email ? await db.findUserByEmail(email) : null;
        if (byId || byEmail) {
          results.skipped++;
          results.errors.push({
            row: i + 1,
            studentId,
            error: "Duplicate studentId or email",
          });
          continue;
        }

        const created = await db.createUser({
          studentId,
          full_name,
          email,
          program,
          classGroup,
          password: password || uuidv4().slice(0, 10),
          role,
          institutionId: "upsa",
          academicYearStart,
        });

        if (!created) {
          results.skipped++;
          results.errors.push({
            row: i + 1,
            studentId,
            error: "Failed to insert",
          });
          continue;
        }

        results.imported++;
      } catch (e) {
        console.error("Row import error:", e);
        results.skipped++;
        results.errors.push({
          row: i + 1,
          error: e.message || "Unknown error",
        });
      }
    }

    return res.json(results);
  } catch (e) {
    console.error("Admin import error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});
// --- API: slides ---
app.get("/api/slides", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });
  try {
    const user = req.session.user;
    const qCourseTitle =
      typeof req.query.courseTitle === "string"
        ? req.query.courseTitle.trim()
        : "";
    let rows = await db.listSlidesByClassGroupId(user.classGroupId);
    if (qCourseTitle) {
      rows = rows.filter((s) => (s.course_title || "").trim() === qCourseTitle);
    }
    const slides = rows.map((s) => ({
      id: s.id,
      classGroup: s.class_group_id,
      courseTitle: s.course_title,
      slideTitle: s.slide_title,
      filename: s.object_path,
      originalName: s.original_name,
      createdAt: s.created_at,
    }));
    return res.json({ ok: true, slides });
  } catch (e) {
    console.error("Slides list error", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to load slides" });
  }
});

// --- API: slide download/view URL ---
// --- API: slide download/view URL ---
app.get("/api/slides/:id/url", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ ok: false, message: "Unauthorized" });

  try {
    const slide = await db.getSlideById(req.params.id);

    if (!slide)
      return res.status(404).json({ ok: false, message: "Slide not found" });
    if (!slide.object_path)
      return res.status(404).json({ ok: false, message: "Slide file missing" });
    if (!supabase)
      return res
        .status(500)
        .json({ ok: false, message: "Supabase not configured" });

    const activeBucket =
      (typeof SUPABASE_BUCKET !== "undefined" ? SUPABASE_BUCKET : null) ||
      process.env.SUPABASE_BUCKET ||
      "slides";

    // Generate signed URL (valid for 2 hours)
    const { data, error } = await supabase.storage
      .from(activeBucket)
      .createSignedUrl(slide.object_path, 60 * 60 * 2);

    if (error) {
      console.error("Supabase signed URL error:", error.message);
      return res.status(500).json({
        ok: false,
        message: "Storage access failed: " + error.message,
      });
    }

    if (!data || !data.signedUrl) {
      return res
        .status(500)
        .json({ ok: false, message: "Signed URL was not generated" });
    }

    return res.json({ ok: true, url: data.signedUrl });
  } catch (e) {
    console.error("Slide URL error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to generate slide URL" });
  }
});

// Middleware to allow Admins, Reps, or designated Creators to upload
const requireCreator = (req, res, next) => {
  const u = req.session.user;
  const isAllowed =
    u && (u.role === "admin" || u.is_rep || u.is_leader || u.is_creator);

  if (isAllowed) return next();
  res.status(403).json({ ok: false, message: "Upload permissions required." });
};

// GET /api/categories - For the filter pills
app.get("/api/categories", async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      "SELECT * FROM resource_categories ORDER BY name ASC",
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

// GET /api/resources - Contextual routing for master vault & marketplace grids
app.get("/api/resources", async (req, res) => {
  try {
    const { courseId, master, programId, level } = req.query;

    let query = `
      SELECT 
        r.id,
        r.title,
        r.description,
        r.url,
        r.youtube_id,
        r.category_id,
        r.program_id,
        r.institution_id,
        r.is_global,
        r.uploader_id,
        r.status,
        r.view_count,
        r.created_at,
        r.level,
        r.is_master_compiled,
        r.course_id,
        c.name as category_name 
      FROM resources r
      LEFT JOIN resource_categories c ON r.category_id = c.id
      WHERE r.status = 'approved'
    `;

    const queryParams = [];

    // 1. Optional Course Filter (Used heavily by the course list selection layout)
    if (courseId) {
      queryParams.push(courseId);
      query += ` AND r.course_id = $${queryParams.length}`;
    }

    // 2. Structural Split: Master Vault Context vs. General Marketplace
    if (master === "true") {
      // Enforce strict master compilation filtering
      query += ` AND (r.is_master_compiled = true OR r.is_master_compiled = 'true')`;

      // SECURITY: Never trust client-sent program/level. Resolve them from the
      // logged-in user's DB row so students only ever see THEIR program's vault.
      let scopedProgramId = null;
      let scopedLevel = null;
      if (req.session && req.session.user && req.session.user.id) {
        try {
          const { rows: uRows } = await db.pool.query(
            "SELECT program_id, current_level FROM users_app WHERE id = $1 LIMIT 1",
            [req.session.user.id],
          );
          if (uRows.length > 0) {
            scopedProgramId = uRows[0].program_id || null;
            scopedLevel = uRows[0].current_level || null;
          }
        } catch (ue) {
          console.error("Vault scope lookup error:", ue.message);
        }
      }

      // Fallback to session values if DB row is missing for some reason
      if (!scopedProgramId) {
        scopedProgramId =
          (req.session &&
            req.session.user &&
            (req.session.user.programId || req.session.user.program_id)) ||
          programId ||
          null;
      }
      if (!scopedLevel) {
        scopedLevel =
          (req.session &&
            req.session.user &&
            (req.session.user.currentLevel || req.session.user.current_level)) ||
          level ||
          null;
      }

      // Enforce student program alignment (MANDATORY for master vault).
      // A resource belongs to the student's program if its program_id matches
      // directly OR its course is part of the program's curriculum (program_courses).
      if (scopedProgramId) {
        queryParams.push(String(scopedProgramId));
        const pIdx = queryParams.length;
        query += `
        AND (
          r.program_id = $${pIdx}
          OR (
            r.course_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM program_courses pc
              WHERE pc.course_id = r.course_id AND pc.program_id = $${pIdx}
            )
          )
        )`;
      }

      // Enforce student level alignment (MANDATORY for master vault)
      if (scopedLevel) {
        queryParams.push(parseInt(scopedLevel, 10) || 100);
        query += ` AND r.level = $${queryParams.length}`;
      }
    } else {
      // Marketplace logic: Hide master-compiled tracks completely to isolate standard submissions
      query += ` AND (r.is_master_compiled = false OR r.is_master_compiled IS NULL)`;
    }

    // Append standard descending sorting order
    query += ` ORDER BY r.created_at DESC`;

    const { rows } = await db.pool.query(query, queryParams);

    // Returns response envelope that perfectly bridges dashboard-modern.js and resources.js
    res.json({ resources: rows });
  } catch (e) {
    console.error("Backend resource extraction error:", e);
    res
      .status(500)
      .json({ ok: false, message: "Failed to fetch library resources" });
  }
});

// PATCH /api/resources/:id/view - Increments view count
app.patch("/api/resources/:id/view", async (req, res) => {
  try {
    await db.pool.query(
      "UPDATE resources SET view_count = view_count + 1 WHERE id = $1",
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.post("/api/resources", requireCreator, async (req, res) => {
  try {
    const {
      title,
      description,
      youtube_id,
      category_id,
      is_global,
      url,
      program_id,
    } = req.body;
    const u = req.session.user;

    // Support both snake_case and camelCase for session property naming
    const instId = u.institution_id || u.institutionId;
    let finalUrl = url;

    // 1. Handle File Upload with Institution-based folder isolation
    if (req.files && req.files.file) {
      const file = req.files.file;
      const fileId = uuidv4();

      // Crucial: Files are stored in a folder named after the school's ID
      const objectPath = `resources/${instId}/${fileId}_${file.name}`;

      const { error: upErr } = await supabase.storage
        .from("campus-resources")
        .upload(objectPath, file.data, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (upErr) throw upErr;

      const { data: publicUrlData } = supabase.storage
        .from("campus-resources")
        .getPublicUrl(objectPath);

      finalUrl = publicUrlData.publicUrl;
    }

    // 2. Status Logic: Admins/Reps auto-approve (if that's your policy), others stay pending
    const status = u.role === "admin" || u.is_rep ? "approved" : "pending";

    // 3. Database Insertion with Program and Institution scope
    const query = `
      INSERT INTO resources (
        title, description, url, youtube_id, category_id, 
        uploader_id, status, is_global, program_id, institution_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    const vals = [
      title,
      description,
      finalUrl || null,
      youtube_id || null,
      category_id,
      u.id,
      status,
      is_global === "true" || is_global === true,
      // If global, program is null; otherwise use selected or uploader's program
      is_global === "true" ? null : program_id || u.program_id || u.programId,
      instId,
    ];

    const { rows } = await db.pool.query(query, vals);

    res.json({
      ok: true,
      resource: rows[0],
      autoApproved: status === "approved",
    });
  } catch (e) {
    console.error("Upload error:", e);
    res
      .status(500)
      .json({ ok: false, message: "Submission failed: " + e.message });
  }
});

// GET /api/creator/my-resources - Allows creators to see their own upload status
app.get("/api/creator/my-resources", requireCreator, async (req, res) => {
  const { rows } = await db.pool.query(
    "SELECT * FROM resources WHERE uploader_id = $1 ORDER BY created_at DESC",
    [req.session.user.id],
  );
  res.json(rows);
});

// GET /api/admin/resources/pending - The approval queue
app.get("/api/admin/resources/pending", requireAdmin, async (req, res) => {
  const query = `
    SELECT r.*, u.full_name as uploader_name 
    FROM resources r
    JOIN users_app u ON r.uploader_id = u.id
    WHERE r.status = 'pending'
  `;
  const { rows } = await db.pool.query(query);
  res.json(rows);
});

// PATCH /api/admin/resources/:id/status - Approve or Reject
app.patch("/api/admin/resources/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body; // Expects 'approved' or 'rejected'
  try {
    const result = await db.pool.query(
      "UPDATE resources SET status = $1 WHERE id = $2 RETURNING id",
      [status, req.params.id],
    );
    res.json({ ok: true, message: `Resource ${status}` });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// DELETE /api/admin/resources/:id - Hard delete
app.delete("/api/admin/resources/:id", requireAdmin, async (req, res) => {
  await db.pool.query("DELETE FROM resources WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/admin/resources", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      url,
      youtube_id,
      category_id,
      program_id,
      is_global,
      status,
    } = req.body;

    const u = req.session.user;

    // Initialize finalUrl with the text input (could be a website link)
    let finalUrl = url;

    // 1. Handle File Upload (Priority)
    if (req.files && req.files.file) {
      const file = req.files.file;
      const fileId = uuidv4();

      // Using your specific folder structure: resources/[institution]/[filename]
      const instId = u.institutionId || "global";
      const objectPath = `resources/${instId}/${fileId}_${file.name}`;

      const { error: upErr } = await supabase.storage
        .from("campus-resources")
        .upload(objectPath, file.data, {
          contentType: file.mimetype,
          upsert: true, // Overwrite if same ID exists
        });

      if (upErr) throw upErr;

      const { data: publicUrlData } = supabase.storage
        .from("campus-resources")
        .getPublicUrl(objectPath);

      // Override finalUrl with the fresh Supabase link
      finalUrl = publicUrlData.publicUrl;
    }

    // 2. Database Insertion
    const query = `
      INSERT INTO resources (
        title, description, url, youtube_id, category_id, 
        program_id, institution_id, is_global, uploader_id, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;

    // Ensure we handle defaults for Admin-created resources
    const vals = [
      title,
      description,
      finalUrl || null,
      youtube_id || null,
      category_id,
      program_id || u.programId || null,
      u.institutionId || null,
      is_global === "true" || is_global === true, // Robust boolean check
      u.id,
      status || "approved",
    ];

    const { rows } = await db.pool.query(query, vals);
    res.json({ ok: true, resource: rows[0] });
  } catch (e) {
    console.error("Admin Resource Creation Error:", e);
    res
      .status(500)
      .json({ ok: false, message: e.message || "Failed to create resource" });
  }
});

app.post("/api/resources/:id/view", async (req, res) => {
  const { id } = req.params;

  // This calls the exact SQL function you created
  const { error } = await supabase.rpc("increment_view_count", {
    row_id: id,
  });

  if (error) {
    console.error("Database error:", error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  res.json({ ok: true });
});

// Get all top-level posts and their reply counts for moderation
app.get("/api/admin/forum/summary", requireAdmin, async (req, res) => {
  try {
    const query = `
      SELECT p.*, u.full_name, 
      (SELECT COUNT(*) FROM forum_posts r WHERE r.parent_id = p.id) as reply_count
      FROM forum_posts p
      JOIN users_app u ON p.user_id = u.id
      WHERE p.parent_id IS NULL
      ORDER BY p.created_at DESC
    `;
    const { rows } = await db.pool.query(query);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Delete a post and all its nested replies
app.delete("/api/admin/forum/posts/:id", requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    // This query handles the tree deletion if you didn't set ON DELETE CASCADE
    await db.pool.query(
      "DELETE FROM forum_posts WHERE id = $1 OR parent_id = $1",
      [postId],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// GET /api/forum - Fetch the discussion feed for students
app.get("/api/forum", async (req, res) => {
  try {
    const { target } = req.query; // 'global', 'program', or 'class'
    const u = req.session.user;

    let query = `
      SELECT p.*, u.full_name 
      FROM forum_posts p
      JOIN users_app u ON p.user_id = u.id
      WHERE p.target_type = $1
    `;

    const params = [target || "global"];

    // If they want 'program' or 'class' posts, filter by their specific IDs
    if (target === "program" && u) {
      query += ` AND p.target_id = $2`;
      params.push(u.programId);
    } else if (target === "class" && u) {
      query += ` AND p.target_id = $2`;
      // Session stores classGroupId (NOT classId)
      params.push(u.classGroupId || u.class_group_id);
    }

    query += ` ORDER BY p.created_at DESC`;

    const { rows } = await db.pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error("Feed error:", e);
    res.status(500).json({ ok: false, message: "Could not load feed" });
  }
});

// --- NEW: User Permissions & Promotions (is_rep, is_leader, is_creator) ---
app.post(
  "/api/admin/users/:studentId/permissions",
  requireAdmin,
  async (req, res) => {
    const { studentId } = req.params;
    const { bio, is_rep, is_leader, is_creator, role } = req.body;

    try {
      // 1. Find user by student_id
      const user = await db.pool.query(
        "SELECT id FROM users_app WHERE student_id = $1",
        [studentId],
      );
      if (user.rows.length === 0)
        return res.status(404).json({ ok: false, message: "User not found" });

      const userId = user.rows[0].id;

      // 2. Update the columns matching your users_app schema
      const query = `
            UPDATE users_app
            SET bio = $1, is_rep = $2, is_leader = $3, is_creator = $4, role = $5
            WHERE id = $6
            RETURNING id, role
        `;
      const values = [
        bio,
        is_rep,
        is_leader,
        is_creator || false,
        role,
        userId,
      ];

      const result = await db.pool.query(query, values);
      res.json({ ok: true, user: result.rows[0] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, message: "Update failed" });
    }
  },
);

// GET /api/notifications/vapid-key
app.get("/api/notifications/vapid-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/notifications/save-subscription
app.post("/api/notifications/save-subscription", async (req, res) => {
  try {
    const { subscription } = req.body;
    const userId = req.session.user?.id;

    if (!userId || !subscription) {
      return res.status(400).json({ ok: false, message: "Missing data" });
    }

    await db.pool.query(
      "UPDATE users_app SET push_subscription = $1 WHERE id = $2",
      [JSON.stringify(subscription), userId],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Save Sub Error:", err);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/notifications/unsubscribe", async (req, res) => {
  try {
    const userId = req.session.user?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    await db.pool.query(
      "UPDATE users_app SET push_subscription = NULL WHERE id = $1",
      [userId],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Unsubscribe error:", err);
    res.status(500).json({ ok: false, message: "Unable to unsubscribe" });
  }
});

// --- NEW: Forum Moderation Tools ---
// List all posts across all threads for moderation
app.get("/api/admin/forum/posts", requireAdmin, async (req, res) => {
  try {
    const query = `
      SELECT p.*, u.full_name as user_name
      FROM forum_posts p
      LEFT JOIN users_app u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `;
    const { rows } = await db.pool.query(query);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ ok: false, message: "Failed to fetch posts" });
  }
});

// Delete a post (Moderation action)
app.delete("/api/admin/forum/posts/:id", requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    // This will also delete replies if you have ON DELETE CASCADE set up in SQL
    await db.pool.query("DELETE FROM forum_posts WHERE id = $1", [postId]);
    res.json({ ok: true, message: "Post removed by moderator" });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Failed to delete post" });
  }
});

app.post("/api/forum", async (req, res) => {
  try {
    const { content, target_type, target_id } = req.body;
    const u = req.session.user;
    if (!u) return res.status(401).json({ ok: false });

    const query = `
      INSERT INTO forum_posts (user_id, content, target_type, target_id, target_institution)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    // Fall back to the poster's own cohort when the form didn't send a target_id,
    // otherwise program/class posts are stored with NULL and never appear in feeds.
    const finalTargetId =
      target_id ||
      (target_type === "program" ? u.programId : null) ||
      (target_type === "class" ? u.classGroupId || u.class_group_id : null);

    const vals = [
      u.id,
      content,
      target_type || "global",
      finalTargetId,
      u.institutionId || u.institution_id,
    ];
    const { rows } = await db.pool.query(query, vals);

    // Trigger Notification
    // NOTE: 'institution' is not a valid target_type (DB check constraint allows
    // only class/program/global), so it can never occur on a stored post.
    const notifyCriteria =
      target_type === "program"
        ? { type: "program", id: finalTargetId || u.programId }
        : target_type === "class"
          ? { type: "program", id: u.programId } // push at program level for class posts
          : { type: "all" };

    notifyTargetGroup(
      {
        title: "New Discussion",
        content: `${u.full_name}: ${content.substring(0, 50)}...`,
        type: "forum",
        url: "/forum.html",
      },
      notifyCriteria,
    );

    res.json({ ok: true, post: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// POST /api/forum/reply - Reply to an existing post
app.post("/api/forum/reply", async (req, res) => {
  try {
    const { content, parent_id } = req.body;
    const u = req.session.user;

    const query = `
      INSERT INTO forum_posts (user_id, content, parent_id, target_type)
      VALUES ($1, $2, $3, (SELECT target_type FROM forum_posts WHERE id = $3))
      RETURNING *
    `;
    const { rows } = await db.pool.query(query, [u.id, content, parent_id]);

    res.json({ ok: true, reply: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// --- NEW: Announcement Management ---
// GET /api/announcements
app.get("/api/announcements", async (req, res) => {
  try {
    const u = req.session.user;

    // Fetch announcements that are EITHER global, for their institution, OR for their program
    // (NULL targets on a non-global announcement are treated as "everyone")
    const query = `
      SELECT a.*, u.full_name as author_name, u.role as author_role
      FROM announcements a
      LEFT JOIN users_app u ON a.author_id = u.id
      WHERE a.is_global = true
      OR (a.target_institution IS NULL AND a.target_program IS NULL)
      ${u ? "OR a.target_institution = $1 OR a.target_program = $2" : ""}
      ORDER BY a.created_at DESC
    `;

    // We use the session data to filter
    const params = u ? [u.institutionId, u.programId] : [];
    const { rows } = await db.pool.query(query, params);
    res.json(rows);
  } catch (e) {
    console.error("Fetch announcements error:", e);
    res.status(500).json([]);
  }
});

// Get all unique programs directly from your PostgreSQL program_courses table
app.get("/api/programs", async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT DISTINCT program_id 
       FROM program_courses 
       WHERE program_id IS NOT NULL AND program_id != '' 
       ORDER BY program_id ASC`
    );

    // Format for the frontend dropdown (using program_id as both id and name)
    const programsList = rows.map((row) => ({
      id: row.program_id,
      name: row.program_id,
    }));

    res.json(programsList);
  } catch (err) {
    console.error("Error fetching programs:", err.message);
    res.status(500).json([]);
  }
});

// Express Backend Endpoint (/api/my-program-courses)
app.get("/api/my-program-courses", async (req, res) => {
  try {
    const { programId } = req.query;

    if (!programId) {
      return res
        .status(400)
        .json({ error: "Missing programId query parameter." });
    }

    // Query joining your program_courses table map to the primary courses definitions
    const { data, error } = await supabase
      .from("program_courses")
      .select(
        `
                id,
                program_id,
                semester,
                is_required,
                courses (
                    id,
                    course_code,
                    course_name
                )
            `,
      )
      .eq("program_id", programId);

    if (error) throw error;

    // Flatten the data structure so it fits exactly what dashboard-modern.js expects
    const formattedCourses = (data || [])
      .map((item) => {
        if (!item.courses) return null;
        return {
          id: item.courses.id, // target course ID for resources mapping
          course_code: item.courses.course_code,
          course_name: item.courses.course_name,
          semester: item.semester,
          is_required: item.is_required,
        };
      })
      .filter(Boolean);

    // Send back a clear dictionary mapping
    return res.json({ courses: formattedCourses });
  } catch (err) {
    console.error("Error fetching program curriculum:", err.message);
    return res.status(500).json({ error: "Internal server lookup error." });
  }
});

// POST /api/admin/announcements
app.post("/api/admin/announcements", requireLeader, async (req, res) => {
  try {
    const { title, content, is_global, target_program } = req.body;
    const u = req.session.user;

    const finalIsGlobal = u.role === "admin" ? !!is_global : false;

    const query = `
      INSERT INTO announcements (
        author_id, title, content, is_global, 
        target_institution, target_program
      )
      VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING *
    `;

    const vals = [
      u.id,
      title,
      content,
      finalIsGlobal,
      u.institutionId,
      target_program || null,
    ];
    const { rows } = await db.pool.query(query, vals);

    // Determine target for notification
    let targetCriteria = { type: "all" };
    if (target_program) {
      targetCriteria = { type: "program", id: target_program };
    } else if (!finalIsGlobal) {
      targetCriteria = { type: "institution", id: u.institutionId };
    }

    // Trigger Notification
    notifyTargetGroup(
      {
        title: `📢 ${title}`,
        content: content.substring(0, 100),
        type: "announcement",
        url: "/announcements.html",
      },
      targetCriteria,
    );

    res.json({ ok: true, announcement: rows[0] });
  } catch (e) {
    console.error("Post announcement error:", e);
    res.status(500).json({ ok: false, message: "Failed to broadcast" });
  }
});

// --- NEW: Category Management ---
app.post("/api/admin/categories", requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    await db.pool.query("INSERT INTO categories (name) VALUES ($1)", [name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Error adding category" });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const safeResponse = {
      ok: true,
      message: "If an account exists, a reset link has been sent.",
    };

    if (!email) return res.json(safeResponse);

    const user = await db.findUserByEmail(email);
    if (!user) return res.json(safeResponse);

    // Invalidate old unused reset links
    await db.pool.query(
      `
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE user_id = $1
        AND used_at IS NULL
      `,
      [user.id],
    );

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    await db.pool.query(
      `
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
      VALUES ($1, $2, now() + interval '30 minutes')
      `,
      [user.id, tokenHash],
    );

    const baseUrl = process.env.APP_BASE_URL || "https://www.evantrahub.me";
    const resetLink = `${baseUrl}/reset-password.html?token=${rawToken}`;

    // SAFECRACK: Fallback sender address if env is unparsed or missing
    const senderEmail = process.env.RESET_EMAIL_FROM || "noreply@evantrahub.me";

    console.log(
      `Attempting to send mail via Resend from: ${senderEmail} to: ${email}`,
    );

    const sent = await resend.emails.send({
      from: senderEmail,
      to: email,
      subject: "Reset your Evantrahub password",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;max-width:500px;margin:auto;border:1px solid #e5e7eb;padding:20px;border-radius:12px;">
          <h2 style="color:#0d6efd;">Reset your Evantrahub password</h2>
          <p>Hello ${user.first_name || user.full_name || "there"},</p>
          <p>We received a request to reset your Evantrahub password.</p>
          <p style="margin:25px 0;">
            <a href="${resetLink}" style="background:#0d6efd;color:#ffffff;padding:12px 18px;text-decoration:none;border-radius:8px;display:inline-block;font-weight:bold;">
              Reset Password
            </a>
          </p>
          <p style="color:#6b7280;font-size:0.85em;">This link expires in 30 minutes.</p>
          <p style="color:#6b7280;font-size:0.85em;">If you did not request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    // Check both standard response variations safely
    if (sent && sent.error) {
      console.error("Resend API rejected transmission:", sent.error);
      return res.status(500).json({
        ok: false,
        message: `Mailer Error: ${sent.error.message || "Rejected by provider"}`,
      });
    }

    return res.json(safeResponse);
  } catch (e) {
    // CRITICAL DEBUG: This exposes exactly what error is breaking your execution in server logs
    console.error("CRITICAL EXCEPTION inside forgot-password route:", e);
    return res.status(500).json({
      ok: false,
      message: `Internal processing error: ${e.message}`,
    });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");

    if (!token || !password) {
      return res.status(400).json({
        ok: false,
        message: "Token and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "Password must be at least 8 characters",
      });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const found = await db.pool.query(
      `
      SELECT id, user_id
      FROM password_reset_tokens
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      LIMIT 1
      `,
      [tokenHash],
    );

    if (!found.rowCount) {
      return res.status(400).json({
        ok: false,
        message: "Invalid or expired reset link",
      });
    }

    const reset = found.rows[0];
    const passwordHash = crypto
      .createHash("sha256")
      .update(String(password))
      .digest("hex");

    await db.pool.query("BEGIN");

    await db.pool.query(
      "UPDATE users_app SET password_hash = $1 WHERE id = $2",
      [passwordHash, reset.user_id],
    );

    await db.pool.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE id = $1",
      [reset.id],
    );

    await db.pool.query("COMMIT");

    return res.json({
      ok: true,
      message: "Password updated successfully",
    });
  } catch (e) {
    try {
      await db.pool.query("ROLLBACK");
    } catch (_) {}

    console.error("Reset password error:", e);
    return res.status(500).json({
      ok: false,
      message: "Password reset failed",
    });
  }
});

// GET /api/user/profile-full
app.get("/api/user/profile-full", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const userId = req.session.user.id;

  try {
    const [userRes, postsRes, resourcesRes] = await Promise.all([
      db.pool.query(
        `
                SELECT id, student_id, full_name, email, COALESCE(bio, '') as bio, 
                       program, class_group, role, is_leader, is_creator, is_rep,
                       avatar_url, institution_id 
                FROM users_app 
                WHERE id = $1`,
        [userId],
      ),
      // FIX: Changed author_id to user_id and added 'content' since your schema lacks 'title'
      db.pool.query(
        "SELECT id, content as title, created_at FROM forum_posts WHERE user_id = $1 ORDER BY created_at DESC",
        [userId],
      ),
      db.pool.query(
        "SELECT id, title, created_at FROM resources WHERE uploader_id = $1 ORDER BY created_at DESC",
        [userId],
      ),
    ]);

    if (userRes.rows.length === 0) {
      return res.status(404).json({ ok: false, message: "User not found" });
    }

    res.json({
      user: userRes.rows[0],
      activity: {
        posts: postsRes.rows,
        resources: resourcesRes.rows,
      },
    });
  } catch (err) {
    console.error("Profile API Error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

app.post("/api/user/update-bio", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ ok: false });

  const { bio, classGroup } = req.body;
  try {
    const normalizedClassGroup = db.normalizeClassGroup
      ? db.normalizeClassGroup(classGroup)
      : String(classGroup || "").trim();
    await db.pool.query(
      "UPDATE users_app SET bio = $1, class_group = $2 WHERE id = $3",
      [bio, normalizedClassGroup || null, req.session.user.id],
    );
    req.session.user.class_group = normalizedClassGroup;
    req.session.user.classGroup = normalizedClassGroup;
    if (db.makeClassGroupId && req.session.user.cohort_id) {
      const classGroupId = db.makeClassGroupId(
        req.session.user.cohort_id,
        normalizedClassGroup,
      );
      req.session.user.class_group_id = classGroupId;
      req.session.user.classGroupId = classGroupId;
    }
    res.json({ ok: true, class_group: normalizedClassGroup });
  } catch (err) {
    console.error("Bio Update Error:", err);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/user/update-avatar", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");

  try {
    if (!req.files || !req.files.avatar) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    const file = req.files.avatar;
    const userId = req.session.user.id;
    // Path: avatars/user_123_random.png
    const objectPath = `avatars/user_${userId}_${Date.now()}`;

    // 1. Upload to Supabase
    const { error: upErr } = await supabase.storage
      .from("campus-resources")
      .upload(objectPath, file.data, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (upErr) throw upErr;

    // 2. Get Public URL
    const { data } = supabase.storage
      .from("campus-resources")
      .getPublicUrl(objectPath);
    const publicUrl = data.publicUrl;

    // 3. Update users_app table
    await db.pool.query("UPDATE users_app SET avatar_url = $1 WHERE id = $2", [
      publicUrl,
      userId,
    ]);

    res.json({ success: true, avatar_url: publicUrl });
  } catch (err) {
    console.error("Avatar Upload Error:", err);
    res.status(500).json({ message: "Upload failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  const { question } = req.body;
  const user = req.session?.user;

  if (!user)
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  req.session.chatHistory = req.session.chatHistory || [];

  try {
    // 1. Construct a simple, versatile prompt
    // You can add system instructions to keep it professional
    const prompt = `You are a helpful academic tutor for Evantrahub. Answer the user's question accurately and encourage their academic growth. If the question is academic, provide detailed explanations. User asked: ${question}`;

    // 2. Call Gemini with the history
    const answer = await getGeminiResponse(req.session.chatHistory, prompt);

    // 3. Update history
    req.session.chatHistory.push({ role: "user", text: question });
    req.session.chatHistory.push({ role: "model", text: answer });

    return res.json({ ok: true, answer });
  } catch (error) {
    console.error("AI Error:", error);
    return res
      .status(500)
      .json({
        ok: false,
        message: "I am having trouble connecting to the brain right now.",
      });
  }
});

// health endpoint for keepalive
app.get("/healthz", (req, res) => res.status(200).send("ok"));

(async () => {
  try {
    if (typeof db.initSchema === "function") {
      await db.initSchema();
    }
  } catch (err) {
    console.warn(
      "Continuing without confirmed schema init; errors may occur until DB is ready.",
      err,
    );
  }

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);

    if (process.env.KEEPALIVE === "true") {
      const urlPath = "/healthz";
      const intervalMs = Number(process.env.KEEPALIVE_INTERVAL_MS || 60000);
      console.log(
        `[keepalive] enabled; pinging ${urlPath} every ${intervalMs}ms`,
      );
      setInterval(() => {
        // Use fetch relative to current origin (Node 18+ has global fetch)
        fetch(urlPath).catch(() => {});
      }, intervalMs);
    }
  });
})();
