const https = require('https');

function testKvdb() {
  const bucketId = 'stremio_subgenre_db_djlong_2026';
  const url = `https://kvdb.io/${bucketId}/collections`;
  
  const testData = JSON.stringify({ test: "hello", timestamp: Date.now() });
  
  const req = https.request(url, { method: 'POST' }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      print(`KVDB POST response: ${res.statusCode} ${body}`);
      
      // Now GET it back
      https.get(url, (getRes) => {
        let getBody = '';
        getRes.on('data', c => getBody += c);
        getRes.on('end', () => {
          print(`KVDB GET response: ${getRes.statusCode} ${getBody}`);
        });
      });
    });
  });
  
  req.on('error', e => print(`KVDB Error: ${e.message}`));
  req.write(testData);
  req.end();
}

function print(msg) {
  console.log(msg);
}

testKvdb();
