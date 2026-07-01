const http = require('node:http');
const { createHmac } = require('node:crypto');

const port = Number(process.env.MOCK_CRM_PORT || 4010);
// Mirror the CRM's HMAC check when a secret is configured (matches
// CRM_WEBHOOK_HMAC_SECRET on the worker side). Left blank => signature not enforced.
const hmacSecret = process.env.MOCK_CRM_HMAC_SECRET || '';

// Accepts the structured /call-results endpoint (current) and the legacy /leads
// path (pre-migration) so both producer shapes exercise the mock.
const ACCEPTED_PATHS = new Set(['/call-results', '/leads']);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !ACCEPTED_PATHS.has(req.url)) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });

  req.on('end', () => {
    if (hmacSecret) {
      const expected =
        'sha256=' + createHmac('sha256', hmacSecret).update(raw, 'utf8').digest('hex');
      if (req.headers['x-signature'] !== expected) {
        console.log('Mock CRM rejected: bad X-Signature');
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'signature_mismatch' } }));
        return;
      }
    }

    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { raw };
    }

    console.log(`Mock CRM received on ${req.url}:`, JSON.stringify(payload));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, crmLeadId: `lead-${Date.now()}`, id: `crm-${Date.now()}` }));
  });
});

server.listen(port, () => console.log(`Mock CRM listening on ${port}`));
