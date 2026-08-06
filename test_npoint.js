const https = require('https');

function testNpoint() {
  const data = JSON.stringify({ sample: "test_collections", timestamp: Date.now() });
  
  const options = {
    hostname: 'api.npoint.io',
    path: '/documents',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`NPOINT Status: ${res.statusCode}`);
      console.log(`NPOINT Body: ${body}`);
    });
  });

  req.on('error', e => console.error(`Error: ${e.message}`));
  req.write(data);
  req.end();
}

testNpoint();
