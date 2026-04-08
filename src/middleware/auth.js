const { admin } = require('../config/env');

const auth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  if (user === admin.username && pass === admin.password) {
    return next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Dashboard"');
    return res.status(401).send('Invalid credentials');
  }
};

module.exports = auth;
