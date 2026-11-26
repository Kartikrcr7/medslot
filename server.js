require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const JWT_SECRET = process.env.JWT_SECRET || 'medslot_super_secret_2026';

// Auto-seed demo accounts on first startup
async function seedDatabase() {
  try {
    const check = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(check.rows[0].count) > 0) return;

    const hash = await bcrypt.hash('password123', 10);

    await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES
       ('Rohan Sharma', 'patient@medslot.com', $1, 'PATIENT'),
       ('Clinic Admin', 'admin@medslot.com', $1, 'ADMIN')`,
      [hash]
    );

    const doc1 = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Dr. Priya Mehta', 'priya@medslot.com', $1, 'DOCTOR') RETURNING id`,
      [hash]
    );
    const doc2 = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ('Dr. Arjun Nair', 'arjun@medslot.com', $1, 'DOCTOR') RETURNING id`,
      [hash]
    );

    await pool.query(
      `INSERT INTO doctors (user_id, specialization, consultation_fee, room_number, available_from, available_to) VALUES
       ($1, 'General Physician', 500, 'Room 101', '09:00', '17:00'),
       ($2, 'Cardiologist', 800, 'Room 204', '10:00', '18:00')`,
      [doc1.rows[0].id, doc2.rows[0].id]
    );

    console.log('Seeded demo Patient, Doctors, and Admin accounts.');
  } catch (err) {
    console.error('Seed check error:', err.message);
  }
}

// Role-Based Access Control Middleware
function auth(roles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      const decoded = jwt.verify(header.split(' ')[1], JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Access denied for this role' });
      }
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// 1. Register (New Patient)
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'PATIENT') RETURNING id, name, email, role`,
      [name.trim(), email.trim().toLowerCase(), hash]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role, name: user.name });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: err.message });
  }
});

// 2. Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, role: user.role, name: user.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Doctors & Live Load (from SQL View)
app.get('/api/doctors', auth(), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM view_doctor_daily_load ORDER BY doctor_id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Book Appointment (ACID Transaction + Row Locking + Cloud File Upload)
app.post('/api/appointments', auth(['PATIENT']), upload.single('labReport'), async (req, res) => {
  const { doctor_id, appointment_date, time_slot, symptoms } = req.body;
  if (!doctor_id || !appointment_date || !time_slot) {
    return res.status(400).json({ error: 'Doctor, date, and time slot are required' });
  }

  let reportUrl = null;
  if (req.file) {
    const fileName = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;
    const { error: upErr } = await supabase.storage
      .from('medical-reports')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) return res.status(500).json({ error: 'File upload failed: ' + upErr.message });
    reportUrl = supabase.storage.from('medical-reports').getPublicUrl(fileName).data.publicUrl;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM doctors WHERE id = $1 FOR UPDATE', [doctor_id]);

    const conflict = await client.query(
      `SELECT id FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND time_slot = $3 AND status != 'CANCELLED'`,
      [doctor_id, appointment_date, time_slot]
    );
    if (conflict.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This time slot is already booked. Please pick another slot.' });
    }

    const inserted = await client.query(
      `INSERT INTO appointments (patient_id, doctor_id, appointment_date, time_slot, symptoms, report_blob_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, doctor_id, appointment_date, time_slot, symptoms || '', reportUrl]
    );

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, details) VALUES ($1, 'BOOK_APPOINTMENT', $2)`,
      [req.user.id, `Booked appointment #${inserted.rows[0].id} for ${appointment_date} at ${time_slot}`]
    );

    await client.query('COMMIT');
    res.json({ message: 'Appointment confirmed!', appointment: inserted.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Slot already taken.' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 5. Get Appointments (Role-Scoped)
app.get('/api/appointments', auth(), async (req, res) => {
  try {
    let query = `
      SELECT a.*,
             pu.name AS patient_name,
             du.name AS doctor_name,
             d.specialization, d.room_number, d.consultation_fee,
             p.diagnosis, p.medications, p.notes, p.issued_at
      FROM appointments a
      JOIN users pu ON a.patient_id = pu.id
      JOIN doctors d ON a.doctor_id = d.id
      JOIN users du ON d.user_id = du.id
      LEFT JOIN prescriptions p ON p.appointment_id = a.id
    `;
    let params = [];

    if (req.user.role === 'PATIENT') {
      query += ' WHERE a.patient_id = $1';
      params = [req.user.id];
    } else if (req.user.role === 'DOCTOR') {
      query += ' WHERE d.user_id = $1';
      params = [req.user.id];
    }
    query += ' ORDER BY a.appointment_date DESC, a.time_slot ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Issue Digital Prescription (Doctor Only, ACID Transaction)
app.post('/api/appointments/:id/prescribe', auth(['DOCTOR']), async (req, res) => {
  const { diagnosis, medications, notes } = req.body;
  if (!diagnosis || !medications) {
    return res.status(400).json({ error: 'Diagnosis and medications are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO prescriptions (appointment_id, diagnosis, medications, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (appointment_id) DO UPDATE SET diagnosis = $2, medications = $3, notes = $4, issued_at = NOW()`,
      [req.params.id, diagnosis, medications, notes || '']
    );
    await client.query(`UPDATE appointments SET status = 'COMPLETED' WHERE id = $1`, [req.params.id]);
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, details) VALUES ($1, 'ISSUE_PRESCRIPTION', $2)`,
      [req.user.id, `Issued digital prescription for appointment #${req.params.id}`]
    );
    await client.query('COMMIT');
    res.json({ message: 'Digital prescription issued and visit marked COMPLETED.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 7. Cancel Appointment (Patient or Admin)
app.patch('/api/appointments/:id/cancel', auth(['PATIENT', 'ADMIN']), async (req, res) => {
  try {
    const check = await pool.query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    if (req.user.role === 'PATIENT' && check.rows[0].patient_id !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to cancel this booking' });
    }
    await pool.query(`UPDATE appointments SET status = 'CANCELLED' WHERE id = $1`, [req.params.id]);
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, details) VALUES ($1, 'CANCEL_APPOINTMENT', $2)`,
      [req.user.id, `Cancelled appointment #${req.params.id}`]
    );
    res.json({ message: 'Appointment cancelled and slot released.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Admin: Add New Doctor
app.post('/api/admin/doctors', auth(['ADMIN']), async (req, res) => {
  const { name, email, password, specialization, consultation_fee, room_number } = req.body;
  if (!name || !email || !specialization || !room_number) {
    return res.status(400).json({ error: 'All doctor fields are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password || 'password123', 10);
    const uRes = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'DOCTOR') RETURNING id`,
      [name.trim(), email.trim().toLowerCase(), hash]
    );
    await client.query(
      `INSERT INTO doctors (user_id, specialization, consultation_fee, room_number) VALUES ($1, $2, $3, $4)`,
      [uRes.rows[0].id, specialization.trim(), parseInt(consultation_fee) || 500, room_number.trim()]
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, details) VALUES ($1, 'ADD_DOCTOR', $2)`,
      [req.user.id, `Added ${name} (${specialization}) in ${room_number}`]
    );
    await client.query('COMMIT');
    res.json({ message: `Doctor ${name} added successfully!` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 9. Admin: Audit Logs
app.get('/api/admin/logs', auth(['ADMIN']), async (req, res) => {
  try {
    const logs = await pool.query(`
      SELECT l.*, u.name AS actor_name, u.role AS actor_role
      FROM audit_logs l
      LEFT JOIN users u ON l.actor_id = u.id
      ORDER BY l.created_at DESC LIMIT 15
    `);
    res.json(logs.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await seedDatabase();
  console.log(`MedSlot running on http://localhost:${PORT}`);
});