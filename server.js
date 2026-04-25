const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ================= DATABASE =================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
// ================= CONFIG =================
const BUSINESS_NAME = 'PHINDU';
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || '0990000000';
const SUBSCRIPTION_FEE = 5000;

const AIRTEL_NUMBER = process.env.AIRTEL_NUMBER || '0990000000';
const TNM_NUMBER = process.env.TNM_NUMBER || '0880000000';

// ================= TEMP =================
const pinResetSessions = {};
const pendingSubscriptions = {};

// ================= HELPERS =================
function reply(res, text, cont = false) {
  res.send(`${cont ? 'CON' : 'END'} ${text}`);
}

async function isSubscribed(phone) {
  const r = await pool.query('SELECT subscribed FROM users WHERE phone=$1', [phone]);
  return r.rows[0]?.subscribed === true;
}

async function verifyPIN(phone, pin) {
  const r = await pool.query('SELECT pin, attempts, locked FROM users WHERE phone=$1', [phone]);

  if (r.rows.length === 0) return { status: 'invalid', attemptsLeft: 2 };

  if (r.rows[0].locked) return { status: 'locked' };

  if (r.rows[0].pin !== pin) {
    let attempts = r.rows[0].attempts + 1;

    if (attempts >= 3) {
      await pool.query('UPDATE users SET locked=true WHERE phone=$1', [phone]);
      return { status: 'locked' };
    }

    await pool.query('UPDATE users SET attempts=$1 WHERE phone=$2', [attempts, phone]);
    return { status: 'invalid', attemptsLeft: 3 - attempts };
  }

  await pool.query('UPDATE users SET attempts=0 WHERE phone=$1', [phone]);
  return { status: 'ok' };
}

async function resetPIN(phone, newPin) {
  await pool.query(
    'UPDATE users SET pin=$1, attempts=0, locked=false WHERE phone=$2',
    [newPin, phone]
  );
}

// ================= USSD =================
app.post('/ussd', async (req, res) => {
  const { phoneNumber, text } = req.body;
  const inputs = text.split('*');

  const userCheck = await pool.query('SELECT * FROM users WHERE phone=$1', [phoneNumber]);

  // NEW USER
  if (userCheck.rows.length === 0) {
    if (text === '') return reply(res, `${BUSINESS_NAME}\nEnter Name`, true);
    if (inputs.length === 1) return reply(res, 'Enter Capital', true);
    if (inputs.length === 2) return reply(res, 'Set PIN', true);

    if (inputs.length === 3) {
      await pool.query(
        'INSERT INTO users(phone,name,pin,subscribed,attempts,locked) VALUES($1,$2,$3,false,0,false)',
        [phoneNumber, inputs[0], inputs[2]]
      );
      return reply(res, 'Registered');
    }
  }

  // PIN RESET
  if (text === '9') return reply(res, 'Enter your name', true);

  if (inputs[0] === '9' && inputs.length === 3) {
    await resetPIN(phoneNumber, inputs[2]);
    return reply(res, 'PIN reset OK');
  }

  // LOGIN
  if (text === '') return reply(res, `${BUSINESS_NAME}\nEnter PIN\n9.Reset PIN`, true);

  if (inputs.length === 1 && inputs[0] !== '9') {
    const result = await verifyPIN(phoneNumber, inputs[0]);

    if (result.status === 'locked') return reply(res, `Locked. Call ${SUPPORT_CONTACT}`);
    if (result.status === 'invalid') return reply(res, `Invalid PIN. Left:${result.attemptsLeft}`);

    const active = await isSubscribed(phoneNumber);

    if (!active) {
      return reply(res, 'SUBSCRIPTION REQUIRED\n1.Pay\n2.I Paid', true);
    }

    return reply(res, '1.Sale\n2.Expense\n3.Profit\n4.Loan\n5.Withdraw', true);
  }

  // SUBSCRIPTION
  if (inputs[1] === '1' && inputs.length === 2) {
    return reply(
      res,
      `Pay MK${SUBSCRIPTION_FEE}:\nAirtel:${AIRTEL_NUMBER}\nTNM:${TNM_NUMBER}\nRef:Phone\nThen select 2`
    );
  }

  if (inputs[1] === '2') {
    pendingSubscriptions[phoneNumber] = true;
    return reply(res, 'Pending activation');
  }

  const active = await isSubscribed(phoneNumber);
  if (!active) return reply(res, 'Access denied');

  if (inputs[1] === '3') return reply(res, 'Profit: Calculated');
});

// ================= PORT =================
const PORT = process.env.PORT || 3000;
// Create table automatically on startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20) UNIQUE,
        name VARCHAR(100),
        pin VARCHAR(10),
        subscribed BOOLEAN DEFAULT false,
        attempts INT DEFAULT 0,
        locked BOOLEAN DEFAULT false
      );
    `);
    console.log("Users table ready");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}

// Start server AFTER DB init

initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
