const https = require('https');

function testMyJsonValid3() {
  const payload = JSON.stringify({
    jsonData: JSON.stringify({ sample: "test_collections", timestamp: Date.now() }),
    collectionId: "123e4567-e89b-12d3-a456-426614174000"
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
      try {
        const data = JSON.parse(body);
        if (data.data && data.data.id) {
          const recordId = data.data.id;
          https.get(`https://api.myjson.online/v1/records/${recordId}`, (getRes) => {
            let getBody = '';
            getRes.on('data', c => getBody += c);
            getRes.on('end', () => {
              console.log(`GET record: ${getRes.statusCode} - ${getBody}`);
            });
          });
        }
      } catch (e) {}
    });
  });

  req.on('error', e => console.error('Error:', e.message));
  req.write(payload);
  req.end();
}

testMyJsonValid3();
