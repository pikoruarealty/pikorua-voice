const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.post('/crm/leads', (req, res) => {
  console.log('Mock CRM received:', req.body);
  // Simulate success
  res.json({ ok: true, id: 'crm-' + Date.now() });
});

const port = process.env.MOCK_CRM_PORT || 4010;
app.listen(port, () => console.log(`Mock CRM listening on ${port}`));
