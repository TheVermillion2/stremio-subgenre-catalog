const https = require('https');

function testJsonBin() {
  const data = JSON.stringify({ sample: "test_collections", timestamp: Date.now() });
  
  const options = {
    hostname: 'api.jsonbin.io',
    path: '/v3/b',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bin-Private': 'false'
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`JSONBIN Status: ${res.statusCode}`);
      console.log(`JSONBIN Body: ${body}`);
    });
  });

  req.on('error', e => console.error(`Error: ${e.message}`));
  req.write(data);
  req.end();
}

testJsonBin();
