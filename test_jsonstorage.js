const https = require('https');

function testJsonStorage() {
  const data = JSON.stringify({ collections: { test: "demo" } });
  
  const req = https.request('https://api.jsonstorage.net/v1/json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`jsonstorage status: ${res.statusCode}`);
      console.log(`jsonstorage body: ${body}`);
    });
  });
  req.on('error', e => console.error(e));
  req.write(data);
  req.end();
}

testJsonStorage();
