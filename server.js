const express = require('express');
const app = express();
const path = require('path');

app.use(express.json());
app.use(express.static('.'));

// In-memory store — last 200 alerts
let alerts = [];
let clients = []; // SSE clients

// ── SSE endpoint for live push ────────────────────────────────
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current alerts on connect
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
    const body = req.body;

    // Parse the raw TradingView alert message text
    const raw = body.message || body.text || body.alert_message || '';

    const alert = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      raw,
      ticker: body.ticker || extractField(raw, 'ticker') || symInfo(raw),
      timeframe: body.timeframe || extractTF(raw),
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

    broadcast(alert);
    res.json({ ok: true, alert });
  } catch (e) {
    console.error('Webhook error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Get all alerts (for page load) ───────────────────────────
app.get('/alerts', (req, res) => {
  res.json(alerts);
});

// ── Clear alerts ──────────────────────────────────────────────
app.delete('/alerts', (req, res) => {
  alerts = [];
  broadcast({ type: 'clear' });
  res.json({ ok: true });
});

// ── Parsing helpers ───────────────────────────────────────────
function extractField(text, field) {
  const m = text.match(new RegExp(field + '[:\\s]+([A-Z0-9./]+)', 'i'));
  return m ? m[1] : null;
}

function symInfo(text) {
  // Try to extract ticker from common patterns
  const m = text.match(/\b([A-Z]{1,5})\b/);
  return m ? m[1] : 'UNKNOWN';
}

function extractTF(text) {
  const m = text.match(/\[TF:\s*(\w+)\]|\b(5m|15m|30m|60m|1h|4h)\b/i);
  return m ? (m[1] || m[2]) : '—';
}

function detectType(text) {
  if (/ENTER CALLS/i.test(text))   return 'ENTRY_CALLS';
  if (/ENTER PUTS/i.test(text))    return 'ENTRY_PUTS';
  if (/T1 HIT/i.test(text))        return 'T1_HIT';
  if (/T2 HIT/i.test(text))        return 'T2_HIT';
  if (/T3 HIT/i.test(text))        return 'T3_HIT';
  if (/STOPPED OUT/i.test(text))   return 'STOPPED';
  if (/BULL LIQ SWEEP/i.test(text)) return 'LIQ_BULL';
  if (/BEAR LIQ SWEEP/i.test(text)) return 'LIQ_BEAR';
  if (/TRIPLE TOP/i.test(text))    return 'TRIPLE_TOP';
  if (/DOUBLE TOP/i.test(text))    return 'DOUBLE_TOP';
  if (/TRIPLE BOTTOM/i.test(text)) return 'TRIPLE_BOT';
  if (/DOUBLE BOTTOM/i.test(text)) return 'DOUBLE_BOT';
  if (/FAILED.*BOS/i.test(text))   return 'FAILED_BOS';
  if (/3.LINE STRIKE/i.test(text)) return 'THREE_LS';
  if (/EMA SQUEEZE/i.test(text))   return 'EMA_SQZ';
  if (/GAP OPEN/i.test(text))      return 'GAP';
  if (/PWH/i.test(text))           return 'PWH';
  if (/PWL/i.test(text))           return 'PWL';
  if (/YDH/i.test(text))           return 'YDH';
  if (/YDL/i.test(text))           return 'YDL';
  return 'INFO';
}

function detectSignal(text) {
  if (/CALLS/i.test(text) && !/PUTS/i.test(text)) return 'CALLS';
  if (/PUTS/i.test(text)  && !/CALLS/i.test(text)) return 'PUTS';
  if (/CALLS/i.test(text) && /PUTS/i.test(text))  return 'MIXED';
  return 'NEUTRAL';
}

function extractScore(text) {
  const m = text.match(/Score:\s*(\d+)/i) || text.match(/(\d+)\/10/);
  return m ? parseInt(m[1]) : null;
}

function extractQuality(text) {
  if (/EXCEPTIONAL/i.test(text)) return '★★★ EXCEPTIONAL';
  if (/HIGH CONF/i.test(text))   return '★★ HIGH CONF';
  if (/GOOD/i.test(text))        return '★ GOOD';
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
  if (/0DTE/i.test(text))  return '0DTE';
  if (/5DTE/i.test(text))  return '5DTE';
  if (/BIWK/i.test(text))  return 'BIWK';
  return null;
}

function extractTrigger(text) {
  if (/ LIQ/i.test(text))   return 'LIQ';
  if (/ OB/i.test(text))    return 'OB';
  if (/ BOS/i.test(text))   return 'BOS';
  if (/ EMA/i.test(text))   return 'EMA';
  if (/ SQZ/i.test(text))   return 'SQZ';
  if (/ FBOS/i.test(text))  return 'FBOS';
  if (/ 3LS/i.test(text))   return '3LS';
  if (/ OPEN/i.test(text))  return 'OPEN';
  return null;
}

function extractVerdict(text) {
  if (/ENTER CALLS/i.test(text))    return '▲ ENTER CALLS';
  if (/ENTER PUTS/i.test(text))     return '▼ ENTER PUTS';
  if (/T1 HIT/i.test(text))         return '🎯 T1 HIT';
  if (/T2 HIT/i.test(text))         return '🎯 T2 HIT';
  if (/T3 HIT/i.test(text))         return '✅ T3 FULL EXIT';
  if (/STOPPED OUT/i.test(text))    return '🛑 STOPPED OUT';
  return text.split('\n')[0].slice(0, 60);
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IE Webhook running on port ${PORT}`));
