const http = require('node:http');

const port = Number(process.env.MOCK_CRM_PORT || 4010);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/leads') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });

  req.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { raw };
    }

    console.log('Mock CRM received:', payload);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, id: `crm-${Date.now()}` }));
  });
});

server.listen(port, () => console.log(`Mock CRM listening on ${port}`));
