const crypto = require('crypto');
const fs = require('fs');
require('dotenv').config();

// Generate a proper length key using a password
const password = 'your-secret-password';
const key = crypto.scryptSync(password, 'salt', 32); // Creates a 32-byte key

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

const env = {
  SPOTIFY_CLIENT_ID: encrypt(process.env.SPOTIFY_CLIENT_ID),
  SPOTIFY_CLIENT_SECRET: encrypt(process.env.SPOTIFY_CLIENT_SECRET),
  SPOTIFY_REDIRECT_URI: encrypt(process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:3000/callback`),
};

fs.writeFileSync('./build-env.json', JSON.stringify(env, null, 2)); 