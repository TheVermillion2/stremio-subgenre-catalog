const https = require('https');

function testMyJsonValid2() {
  const payload = JSON.stringify({
    jsonData: JSON.stringify({ sample: "test_collections", timestamp: Date.now() }),
    collectionId: "stremio_app_db"
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
      const data = JSON.parse(body);
      if (data.data && data.data.id) {
        const recordId = data.data.id;
        // Test GET
        https.get(`https://api.myjson.online/v1/records/${recordId}`, (getRes) => {
          let getBody = '';
          getRes.on('data', c => getBody += c);
          getRes.on('end', () => {
            console.log(`GET record: ${getRes.statusCode} - ${getBody}`);
          });
        });
      }
    });
  });

  req.on('error', e => console.error('Error:', e.message));
  req.write(payload);
  req.end();
}

testMyJsonValid2();
