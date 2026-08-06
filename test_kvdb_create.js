const https = require('https');

function createKvdbBucket() {
  const req = https.request('https://kvdb.io/', { method: 'POST' }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`KVDB Bucket Created: ${res.statusCode} - Bucket ID: ${body.trim()}`);
      
      const bucketId = body.trim();
      // Test saving data to this bucket
      const postReq = https.request(`https://kvdb.io/${bucketId}/collections`, { method: 'POST' }, (postRes) => {
        let postBody = '';
        postRes.on('data', c => postBody += c);
        postRes.on('end', () => {
          console.log(`POST to bucket: ${postRes.statusCode} - ${postBody}`);
          
          // Test reading back
          https.get(`https://kvdb.io/${bucketId}/collections`, (getRes) => {
            let getBody = '';
            getRes.on('data', c => getBody += c);
            getRes.on('end', () => {
              console.log(`GET from bucket: ${getRes.statusCode} - ${getBody}`);
            });
          });
        });
      });
      postReq.write(JSON.stringify({ hello: "world", timestamp: Date.now() }));
      postReq.end();
    });
  });
  req.on('error', e => console.error(e));
  req.end();
}

createKvdbBucket();
