const path = require('node:path');
const { installDevelopmentRefresh } = require('./development-refresh.cjs');
installDevelopmentRefresh({ root: path.resolve(__dirname, '..') });
