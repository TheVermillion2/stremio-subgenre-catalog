const localtunnel = require('localtunnel');
(async () => {
  try {
    console.log('Starting localtunnel...');
    const tunnel = await localtunnel({ port: 7000 });
    console.log('Tunnel URL:', tunnel.url);
    tunnel.close();
    process.exit(0);
  } catch (err) {
    console.error('Tunnel error:', err.message);
    process.exit(1);
  }
})();
