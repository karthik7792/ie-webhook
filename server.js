const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');

// ── Persistence ───────────────────────────────────────────────
// Alerts are written to disk so they survive server restarts.
// This is what makes the Active Signals panel work across sessions:
// a 4H/1D carry signal fired at 3:30 PM will still appear active
// the next morning when the dashboard reconnects.
const ALERTS_FILE = path.join(__dirname, 'alerts_store.json');

function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, 200) : [];
    }
  } catch (e) {
    console.warn('Could not load alerts_store.json, starting fresh:', e.message);
  }
  return [];
}

function saveAlerts() {
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), 'utf8');
  } catch (e) {
    console.error('Could not write alerts_store.json:', e.message);
  }
}

// ── Body parsers — order matters ──────────────────────────────
// TradingView sends plain text OR JSON depending on alert config
app.use((req, res, next) => {
  express.text({ type: '*/*' })(req, res, (err) => {
    if (err) return next(err);
    if (typeof req.body === 'string') {
      try { req.bodyJson = JSON.parse(req.body); }
      catch (e) { req.bodyJson = null; }
    }
    next();
  });
});
app.use(express.json());
app.use(express.static('.'));

// Load persisted alerts on startup
let alerts = loadAlerts();
console.log(`Loaded ${alerts.length} persisted alert(s) from disk`);

let clients = []; // SSE clients

// ── SSE endpoint for live push ────────────────────────────────
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'init', alerts })}\n\n`);

  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

function broadcast(alert) {
  const data = JSON.stringify({ type: 'alert', alert });
  clients.forEach(c => c.write(`data: ${data}\n\n`));
}

// ── Webhook endpoint — TradingView sends here ─────────────────
app.post('/webhook', (req, res) => {
  try {
    let raw = '';
    let tickerOverride = '';

    if (typeof req.body === 'string' && req.body.trim()) {
      if (req.bodyJson) {
        const j = req.bodyJson;
        raw = j.message || j.text || j.alert_message || j.msg || '';
        tickerOverride = j.ticker || j.symbol || '';
        if (!raw) raw = req.body;
      } else {
        raw = req.body;
      }
    } else if (req.body && typeof req.body === 'object') {
      const j = req.body;
      raw = j.message || j.text || j.alert_message || j.msg || '';
      tickerOverride = j.ticker || j.symbol || '';
      if (!raw) raw = JSON.stringify(j);
    }

    raw = raw.trim();
    console.log('Webhook received, raw:', raw.substring(0, 120));

    const alert = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      raw,
      ticker: tickerOverride || extractField(raw, 'ticker') || extractTicker(raw),
      timeframe: extractTF(raw),
      type: detectType(raw),
      signal: detectSignal(raw),
      score: extractScore(raw),
      quality: extractQuality(raw),
      entry: extractPrice(raw, 'Entry'),
      sl: extractPrice(raw, 'SL'),
      t1: extractPrice(raw, 'T1'),
      t2: extractPrice(raw, 'T2'),
      t3: extractPrice(raw, 'T3'),
      htf: extractHTF(raw),
      dte: extractDTE(raw),
      trigger: extractTrigger(raw),
      verdict: extractVerdict(raw),
    };

    alerts.unshift(alert);
    if (alerts.length > 200) alerts = alerts.slice(0, 200);

    // Persist to disk every time a new alert arrives
    saveAlerts();

    broadcast(alert);
    res.json({ ok: true, alert });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Get all alerts ────────────────────────────────────────────
app.get('/alerts', (req, res) => {
  res.json(alerts);
});

// ── Clear alerts ──────────────────────────────────────────────
app.delete('/alerts', (req, res) => {
  alerts = [];
  saveAlerts(); // persist the cleared state
  clients.forEach(c => c.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`));
  res.json({ ok: true });
});

// ── Parsing helpers ───────────────────────────────────────────
function extractField(text, field) {
  const m = text.match(new RegExp(field + '[:\\s]+([A-Z0-9./]+)', 'i'));
  return m ? m[1] : null;
}

function extractTicker(text) {
  const m1 = text.match(/TICKER[:\s]+([A-Z0-9]{1,6})/i);
  if (m1) return m1[1];
  const m2 = text.match(/^([A-Z]{1,6})\s+[▲▼⚡🚨]/);
  if (m2) return m2[1];
  const skipWords = ['PRICE','EMA','HIGH','LOW','BULL','BEAR','CALL','PUT','GAP','YDH','YDL','PWH','PWL','HTF','BOS','LIQ','SQZ'];
  const m3 = text.match(/\b([A-Z]{1,6})\s+\[(?:\d+m?|TF:)/);
  if (m3 && !skipWords.includes(m3[1])) return m3[1];
  const words = text.match(/\b([A-Z]{2,6})\b/g) || [];
  for (const w of words) {
    if (!skipWords.includes(w)) return w;
  }
  return 'UNKNOWN';
}

function extractTF(text) {
  // Extended to capture 4H, 1D, 240, 240m in addition to standard formats
  const m = text.match(/\[TF:\s*(\w+)\]|\[(\d+[mMhHdD])\]|\b(5m|15m|30m|60m|1h|4h|1H|4H|1D|1d|240m|240)\b/i);
  return m ? (m[1] || m[2] || m[3]) : '—';
}

function detectType(text) {
  if (/GAP EXIT/i.test(text))       return 'GAP_EXIT';
  if (/GAP TRADE/i.test(text))      return 'GAP_TRADE';
  if (/ENTER CALLS/i.test(text))    return 'ENTRY_CALLS';
  if (/ENTER PUTS/i.test(text))     return 'ENTRY_PUTS';
  if (/CALLS T3 HIT|✅ CALLS T3/i.test(text)) return 'T3_HIT';
  if (/PUTS T3 HIT|✅ PUTS T3/i.test(text))   return 'T3_HIT';
  if (/CALLS T2 HIT|🎯 CALLS T2/i.test(text)) return 'T2_HIT';
  if (/PUTS T2 HIT|🎯 PUTS T2/i.test(text))   return 'T2_HIT';
  if (/CALLS T1 HIT|🎯 CALLS T1/i.test(text)) return 'T1_HIT';
  if (/PUTS T1 HIT|🎯 PUTS T1/i.test(text))   return 'T1_HIT';
  if (/T1 HIT/i.test(text))         return 'T1_HIT';
  if (/T2 HIT/i.test(text))         return 'T2_HIT';
  if (/T3 HIT/i.test(text))         return 'T3_HIT';
  if (/SIGNAL BLOCKED/i.test(text)) return 'BLOCKED';
  if (/STOPPED OUT/i.test(text))    return 'STOPPED';
  if (/BULL LIQ SWEEP/i.test(text)) return 'LIQ_BULL';
  if (/BEAR LIQ SWEEP/i.test(text)) return 'LIQ_BEAR';
  if (/TRIPLE TOP/i.test(text))     return 'TRIPLE_TOP';
  if (/DOUBLE TOP/i.test(text))     return 'DOUBLE_TOP';
  if (/TRIPLE BOTTOM/i.test(text))  return 'TRIPLE_BOT';
  if (/DOUBLE BOTTOM/i.test(text))  return 'DOUBLE_BOT';
  if (/FAILED.*BOS/i.test(text))    return 'FAILED_BOS';
  if (/3.LINE STRIKE/i.test(text))  return 'THREE_LS';
  if (/EMA SQUEEZE/i.test(text))    return 'EMA_SQZ';
  if (/GAP OPEN/i.test(text))       return 'GAP';
  if (/PRICE NEAR PWH/i.test(text)) return 'PWH';
  if (/PRICE NEAR PWL/i.test(text)) return 'PWL';
  if (/PRICE NEAR YDH/i.test(text)) return 'YDH';
  if (/PRICE NEAR YDL/i.test(text)) return 'YDL';
  if (/FLIP.*CLOSING CALLS.*OPENING PUTS/i.test(text)) return 'ENTRY_PUTS';
  if (/FLIP.*CLOSING PUTS.*OPENING CALLS/i.test(text)) return 'ENTRY_CALLS';
  if (/OB CLEARED/i.test(text))     return 'OB_CLEARED';
  if (/OB BROKEN/i.test(text))      return 'OB_BROKEN';
  return 'INFO';
}

function detectSignal(text) {
  const isGapExit = /GAP EXIT/i.test(text);
  if (isGapExit) return /EXIT CALLS/i.test(text) ? 'PUTS' : 'CALLS';
  if (/▲ CALLS/i.test(text) || (/CALLS/i.test(text) && !/PUTS/i.test(text))) return 'CALLS';
  if (/▼ PUTS/i.test(text)  || (/PUTS/i.test(text)  && !/CALLS/i.test(text))) return 'PUTS';
  if (/CALLS/i.test(text) && /PUTS/i.test(text)) return 'MIXED';
  return 'NEUTRAL';
}

function extractScore(text) {
  const m = text.match(/Score:\s*(\d+)/i) || text.match(/\[Score:\s*(\d+)\/10\]/i) || text.match(/(\d+)\/10/);
  return m ? parseInt(m[1]) : null;
}

function extractQuality(text) {
  if (/EXCEPTIONAL/i.test(text)) return '★★★';
  if (/HIGH CONF/i.test(text))   return '★★';
  if (/\bGOOD\b/i.test(text))   return '★';
  return null;
}

function extractPrice(text, label) {
  const m = text.match(new RegExp(label + '\\s*[:\\-]+\\s*([\\d.]+)', 'i'));
  return m ? parseFloat(m[1]) : null;
}

function extractHTF(text) {
  if (/HTF✅/.test(text)) return '✅';
  if (/HTF❌/.test(text)) return '❌';
  return null;
}

function extractDTE(text) {
  if (/\[0DTE\]/i.test(text)) return '[0DTE]';
  if (/\[5DTE\]/i.test(text)) return '[5DTE]';
  if (/\[BIWK\]/i.test(text)) return '[BIWK]';
  return null;
}

function extractTrigger(text) {
  if (/ LIQ/i.test(text))  return 'LIQ';
  if (/ OB/i.test(text))   return 'OB';
  if (/ BOS/i.test(text))  return 'BOS';
  if (/ EMA/i.test(text))  return 'EMA';
  if (/ SQZ/i.test(text))  return 'SQZ';
  if (/ FBOS/i.test(text)) return 'FBOS';
  if (/ 3LS/i.test(text))  return '3LS';
  if (/ OPEN/i.test(text)) return 'OPEN';
  return null;
}

function extractVerdict(text) {
  if (/GAP EXIT/i.test(text))    return text.split('\n')[0].slice(0, 100);
  if (/GAP TRADE/i.test(text))   return text.split('\n')[0].slice(0, 100);
  if (/ENTER CALLS/i.test(text)) return '▲ ENTER CALLS';
  if (/ENTER PUTS/i.test(text))  return '▼ ENTER PUTS';
  if (/T1 HIT/i.test(text))      return '🎯 T1 HIT';
  if (/T2 HIT/i.test(text))      return '🎯 T2 HIT';
  if (/T3 HIT/i.test(text))      return '✅ T3 FULL EXIT';
  if (/STOPPED OUT/i.test(text)) return '🛑 STOPPED OUT';
  return text.split('\n')[0].slice(0, 140);
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IE Webhook running on port ${PORT}`));
