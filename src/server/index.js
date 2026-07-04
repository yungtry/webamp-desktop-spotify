const { app } = require('./server');

const port = 3000;

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Spotify auth server listening at http://127.0.0.1:${port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.warn(
      `Spotify auth server port ${port} is already in use. ` +
      'Continuing without starting another local server.'
    );
    return;
  }

  throw error;
});

module.exports = server; 
