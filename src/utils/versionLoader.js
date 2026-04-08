const fs = require('fs');
const path = require('path');

const getVersion = () => {
  try {
    return fs.readFileSync(path.join(__dirname, '../../version.txt'), 'utf8').trim();
  } catch (err) {
    return '0.0.0';
  }
};

module.exports = { getVersion };
