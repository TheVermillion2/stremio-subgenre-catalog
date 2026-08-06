const https = require('https');

function testGist() {
  const payload = JSON.stringify({
    description: "Stremio Collections Backup",
    public: false,
    files: {
      "collections.json": {
        content: JSON.stringify({ test: "data", timestamp: Date.now() })
      }
    }
  });

  const req = https.request('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Stremio-Subgenre-App'
    }
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`Gist status: ${res.statusCode}`);
      console.log(`Gist response: ${body.substring(0, 300)}`);
    });
  });

  req.on('error', e => console.error(e));
  req.write(payload);
  req.end();
}

testGist();
