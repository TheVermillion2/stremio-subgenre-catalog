const https = require('https');

function testMyJsonValid() {
  const payload = JSON.stringify({
    jsonData: JSON.stringify({ sample: "test_collections", timestamp: Date.now() })
  });

  const req = https.request('https://api.myjson.online/v1/records', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`MyJson status: ${res.statusCode}`);
      console.log(`MyJson response: ${body}`);
    });
  });

  req.on('error', e => console.error('Error:', e.message));
  req.write(payload);
  req.end();
}

testMyJsonValid();
