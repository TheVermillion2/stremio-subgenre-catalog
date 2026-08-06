const https = require('https');

function testFirebaseRest() {
  const dbUrl = 'https://stremio-subgenre-catalog-default-rtdb.firebaseio.com/collections.json';
  
  const testData = JSON.stringify({ testCollection: { name: "Test Genre", movies: [] } });
  
  const req = https.request(dbUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log(`Firebase REST PUT status: ${res.statusCode}`);
      console.log(`Firebase REST PUT response: ${body}`);
      
      https.get(dbUrl, (getRes) => {
        let getBody = '';
        getRes.on('data', c => getBody += c);
        getRes.on('end', () => {
          console.log(`Firebase REST GET status: ${getRes.statusCode}`);
          console.log(`Firebase REST GET response: ${getBody}`);
        });
      });
    });
  });
  
  req.on('error', e => console.error('Error:', e.message));
  req.write(testData);
  req.end();
}

testFirebaseRest();
